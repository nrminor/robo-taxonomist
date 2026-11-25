import * as Array from "effect/Array";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Errors from "./errors.ts";
import { TaxonId, TaxonName, TaxonomicRank, TaxonSource } from "./schemas.ts";

/** Use a recorded taxon directly as a taxonomic record. */
export const TaxonSummary = Schema.Struct({
  taxonId: TaxonId,
  scientificName: TaxonName,
  rank: Schema.optionalKey(TaxonomicRank),
  sourceRank: Schema.optionalKey(Schema.String),
});

/** A taxon with its identifier, recorded name, and available rank information. */
export type TaxonSummary = typeof TaxonSummary.Type;

/** Read a taxon and its ancestors, nearest first and excluding the taxon itself. */
export const TaxonEntry = Schema.Struct({
  taxon: TaxonSummary,
  ancestors: Schema.Array(TaxonSummary),
});

/** A taxon and its recorded ancestry. */
export type TaxonEntry = typeof TaxonEntry.Type;

/** Distinguish a current identifier, a merge, a recorded deletion, and a miss. */
export const IdLookup = Schema.TaggedUnion({
  Found: { entry: TaxonEntry },
  Merged: { requested: TaxonId, entry: TaxonEntry },
  Deleted: { requested: TaxonId },
  NotFound: { requested: TaxonId },
});

/** The outcome of ID resolution in the configured taxonomy view. */
export type IdLookup = typeof IdLookup.Type;

/** Inspect the name and source name class that matched a name query. */
export const NameHit = Schema.Struct({
  taxon: TaxonSummary,
  matchedName: TaxonName,
  nameClass: Schema.optionalKey(Schema.String),
});

/** A candidate taxon with its matching recorded name. */
export type NameHit = typeof NameHit.Type;

export const entryFromLookup = IdLookup.match({
  Found: ({ entry }) => Option.some(entry),
  Merged: ({ entry }) => Option.some(entry),
  Deleted: () => Option.none(),
  NotFound: () => Option.none(),
});

export const taxonAtRank = ({ taxon, ancestors }: TaxonEntry, rank: TaxonomicRank) => {
  if (taxon.rank === rank) return Option.some(taxon);

  return Option.fromUndefinedOr(ancestors.find((ancestor) => ancestor.rank === rank));
};

export const servesId = (source: TaxonSource, id: TaxonId) =>
  id.taxonomy === source.taxonomy &&
  (id.release === undefined ||
    (TaxonSource.guards.Snapshot(source) && id.release === source.release));

// Call only for identifiers resolved in the same view.
export const sameResolvedId = (left: TaxonId, right: TaxonId) =>
  left.taxonomy === right.taxonomy && left.id === right.id;

type LookupProvider = {
  readonly source: TaxonSource;
  readonly byId: (id: TaxonId) => Effect.Effect<IdLookup, Errors.TaxonIdQueryError>;
  readonly byName: (name: TaxonName) => Effect.Effect<readonly NameHit[], Errors.TaxonQueryError>;
};

const makeLookup = (provider: LookupProvider) => {
  const checkName = Effect.fn("TaxonLookup.checkName")(function* (id: TaxonId, name: TaxonName) {
    const { source } = provider;

    if (TaxonSource.guards.Live(source)) {
      return yield* new Errors.TaxonSnapshotRequired({ source });
    }

    const resolved = yield* provider.byId(id);

    if (IdLookup.guards.Deleted(resolved) || IdLookup.guards.NotFound(resolved)) {
      return yield* Effect.fail(resolved);
    }

    const canonicalId = resolved.entry.taxon.taxonId;
    const hits = yield* provider.byName(name);

    return hits.filter(({ taxon }) => sameResolvedId(taxon.taxonId, canonicalId));
  });

  const ancestorAtRank = Effect.fn("TaxonLookup.ancestorAtRank")(function* (
    id: TaxonId,
    rank: TaxonomicRank,
  ) {
    const result = yield* provider.byId(id);
    const entry = entryFromLookup(result);

    return Option.flatMap(entry, (recorded) => taxonAtRank(recorded, rank));
  });

  return {
    /** Read the source of the configured taxonomy view. */
    get source() {
      return provider.source;
    },
    /** Resolve an identifier in the configured taxonomy view. */
    byId: (id: TaxonId) => provider.byId(id),
    /** Find candidates with an exact recorded scientific name or synonym. */
    byName: (name: TaxonName) => provider.byName(name),
    /** Find exact scientific names or synonyms recorded for an ID in a fixed view. */
    checkName,
    /** Check whether a fixed view records the name for the resolved ID. */
    hasName: (id: TaxonId, name: TaxonName) =>
      checkName(id, name).pipe(Effect.map(Array.isReadonlyArrayNonEmpty)),
    /** Return the matching names or use the caller's failure for a completed mismatch. */
    requireName: <E>(id: TaxonId, name: TaxonName, onNoMatch: () => E) => {
      const check = checkName(id, name);

      return Effect.filterOrFail(check, Array.isReadonlyArrayNonEmpty, onNoMatch);
    },
    /** Find the recorded taxon at a rank, including the starting taxon itself. */
    ancestorAtRank,
    /** Find the recorded domain, if the source supplies one. */
    domainOf: (id: TaxonId) => ancestorAtRank(id, "domain"),
    /** Find the recorded kingdom, if the source supplies one. */
    kingdomOf: (id: TaxonId) => ancestorAtRank(id, "kingdom"),
    /** Find the recorded phylum, if the source supplies one. */
    phylumOf: (id: TaxonId) => ancestorAtRank(id, "phylum"),
    /** Find the recorded class, if the source supplies one. */
    classOf: (id: TaxonId) => ancestorAtRank(id, "class"),
    /** Find the recorded order, if the source supplies one. */
    orderOf: (id: TaxonId) => ancestorAtRank(id, "order"),
    /** Find the recorded family, if the source supplies one. */
    familyOf: (id: TaxonId) => ancestorAtRank(id, "family"),
    /** Find the taxon's recorded genus, if supplied by the source. */
    genusOf: (id: TaxonId) => ancestorAtRank(id, "genus"),
    /** Find the taxon's recorded species, if supplied by the source. */
    speciesOf: (id: TaxonId) => ancestorAtRank(id, "species"),
  } as const;
};

/**
 * Query the taxonomy view provided in the current Effect scope.
 * Yield this service to resolve IDs, match names, or find recorded ranks.
 *
 * @category models
 * @since 0.7.0
 */
export class TaxonLookup extends Context.Service<TaxonLookup, ReturnType<typeof makeLookup>>()(
  "robo-taxonomist/TaxonLookup",
) {
  /**
   * Build a lookup from a source and its ID and name queries.
   * Supply the taxonomy view as `source`. Let `byId` distinguish current, merged,
   * deleted, and unknown IDs, and let `byName` return exact recorded names and
   * synonyms. The returned service adds rank lookups and name checks.
   *
   * @category constructors
   * @since 0.8.0
   * @example
   * import { Effect, Layer } from "effect";
   * import { IdLookup, TaxonLookup, TaxonSource } from "robo-taxonomist";
   * const empty = TaxonLookup.fromProvider({
   *   source: TaxonSource.cases.Snapshot.make({ taxonomy: "example" }),
   *   byId: (requested) => Effect.succeed(IdLookup.cases.NotFound.make({ requested })),
   *   byName: () => Effect.succeed([]),
   * });
   * export const EmptyLookup = Layer.succeed(TaxonLookup, empty);
   */
  static fromProvider = makeLookup;
}
