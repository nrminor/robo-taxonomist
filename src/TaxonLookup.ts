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

/** Query the taxonomy view provided in the current Effect scope. */
export class TaxonLookup extends Context.Service<
  TaxonLookup,
  {
    readonly source: TaxonSource;
    readonly byId: (id: TaxonId) => Effect.Effect<IdLookup, Errors.TaxonIdQueryError>;
    readonly byName: (name: TaxonName) => Effect.Effect<readonly NameHit[], Errors.TaxonQueryError>;
  }
>()("robo-taxonomist/TaxonLookup") {
  /** Resolve an identifier in the configured taxonomy view. */
  static byId = (id: TaxonId) => TaxonLookup.use((lookup) => lookup.byId(id));

  /** Find candidates with an exact recorded scientific name or synonym. */
  static byName = (name: TaxonName) => TaxonLookup.use((lookup) => lookup.byName(name));

  /** Find exact scientific names or synonyms recorded for an ID in a fixed view. */
  static checkName = Effect.fn("TaxonLookup.checkName")(function* (id: TaxonId, name: TaxonName) {
    const lookup = yield* TaxonLookup;
    const { source } = lookup;
    if (TaxonSource.guards.Live(source)) {
      return yield* new Errors.TaxonSnapshotRequired({ source });
    }

    const resolved = yield* lookup.byId(id);
    if (IdLookup.guards.Deleted(resolved) || IdLookup.guards.NotFound(resolved)) {
      return yield* Effect.fail(resolved);
    }

    const canonicalId = resolved.entry.taxon.taxonId;
    const hits = yield* lookup.byName(name);

    return hits.filter(({ taxon }) => sameResolvedId(taxon.taxonId, canonicalId));
  });

  /** Check whether a fixed view records the name for the resolved ID. */
  static hasName = (id: TaxonId, name: TaxonName) =>
    TaxonLookup.checkName(id, name).pipe(Effect.map(Array.isReadonlyArrayNonEmpty));

  /** Return the matching names or use the caller's failure for a completed mismatch. */
  static requireName = <E>(id: TaxonId, name: TaxonName, onNoMatch: () => E) => {
    const check = TaxonLookup.checkName(id, name);

    return Effect.filterOrFail(check, Array.isReadonlyArrayNonEmpty, onNoMatch);
  };

  /** Find the recorded taxon at a rank, including the starting taxon itself. */
  static ancestorAtRank = Effect.fn("TaxonLookup.ancestorAtRank")(function* (
    id: TaxonId,
    rank: TaxonomicRank,
  ) {
    const result = yield* TaxonLookup.byId(id);
    const entry = entryFromLookup(result);

    return Option.flatMap(entry, (recorded) => taxonAtRank(recorded, rank));
  });

  /** Find the recorded domain, if the source supplies one. */
  static domainOf = (id: TaxonId) => TaxonLookup.ancestorAtRank(id, "domain");

  /** Find the recorded kingdom, if the source supplies one. */
  static kingdomOf = (id: TaxonId) => TaxonLookup.ancestorAtRank(id, "kingdom");

  /** Find the recorded phylum, if the source supplies one. */
  static phylumOf = (id: TaxonId) => TaxonLookup.ancestorAtRank(id, "phylum");

  /** Find the recorded class, if the source supplies one. */
  static classOf = (id: TaxonId) => TaxonLookup.ancestorAtRank(id, "class");

  /** Find the recorded order, if the source supplies one. */
  static orderOf = (id: TaxonId) => TaxonLookup.ancestorAtRank(id, "order");

  /** Find the recorded family, if the source supplies one. */
  static familyOf = (id: TaxonId) => TaxonLookup.ancestorAtRank(id, "family");

  /** Find the taxon's recorded genus, if supplied by the source. */
  static genusOf = (id: TaxonId) => TaxonLookup.ancestorAtRank(id, "genus");

  /** Find the taxon's recorded species, if supplied by the source. */
  static speciesOf = (id: TaxonId) => TaxonLookup.ancestorAtRank(id, "species");
}
