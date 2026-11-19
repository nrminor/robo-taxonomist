import { expect, it } from "@effect/vitest";
import { Effect, Layer, Option, Schema } from "effect";
import { DecisionModel } from "effect/ai";
import {
  Errors,
  IdLookup,
  TaxonId,
  TaxonLookup,
  TaxonName,
  TaxonSource,
  Taxonomy,
} from "robo-taxonomist";

const source = TaxonSource.cases.Snapshot.make({ taxonomy: "fixture" });
const species = {
  taxonId: TaxonId.make({ taxonomy: "fixture", id: "oak/robur" }),
  scientificName: TaxonName.make("Quercus robur"),
  rank: "species",
} as const;
const genus = {
  taxonId: TaxonId.make({ taxonomy: "fixture", id: "oak" }),
  scientificName: TaxonName.make("Quercus"),
  rank: "genus",
} as const;

const lookup = Layer.succeed(TaxonLookup, {
  source,
  byId: (requested: TaxonId) =>
    Effect.succeed(
      requested.id === species.taxonId.id
        ? IdLookup.cases.Found.make({ entry: { taxon: species, ancestors: [genus] } })
        : IdLookup.cases.NotFound.make({ requested }),
    ),
  byName: () => Effect.succeed([]),
});

it.effect("compares two ID-backed records at a recorded rank without a model request", () => {
  const model = Layer.effect(
    DecisionModel.DecisionModel,
    DecisionModel.make({ decide: () => Effect.die("Expected no model request") }),
  );

  return Effect.gen(function* () {
    const judgment = yield* Taxonomy.sameGenus({ taxonId: species.taxonId }, species);

    expect(judgment).toEqual({ _tag: "SameTaxonAtRank", rank: "genus" });
  }).pipe(Effect.provide([lookup, model]));
});

it.effect(
  "propagates query failures for an eligible pair even when the first ID is unknown",
  () => {
    const missing = TaxonId.make({ taxonomy: "fixture", id: "missing" });
    const mismatch = new Errors.TaxonSourceMismatch({
      requested: species.taxonId,
      provided: source,
    });
    const failingLookup = Layer.succeed(TaxonLookup, {
      source,
      byId: (requested) =>
        requested.id === missing.id
          ? Effect.succeed(IdLookup.cases.NotFound.make({ requested }))
          : Effect.fail(mismatch),
      byName: () => Effect.succeed([]),
    });
    const model = Layer.effect(
      DecisionModel.DecisionModel,
      DecisionModel.make({
        decide: () => Effect.die("Expected no fallback after a lookup failure"),
      }),
    );

    return Effect.gen(function* () {
      const failure = yield* Taxonomy.sameGenus({ taxonId: missing }, species).pipe(Effect.flip);

      expect(failure).toBe(mismatch);
    }).pipe(Effect.provide([failingLookup, model]));
  },
);

it.effect("returns all matching name classes for the resolved identifier", () => {
  const name = TaxonName.make("Quercus pedunculata");
  const homonym = { taxon: genus, matchedName: name, nameClass: "synonym" };
  const hit = { taxon: species, matchedName: name, nameClass: "synonym" };
  const withNames = Layer.succeed(TaxonLookup, {
    source,
    byId: () =>
      Effect.succeed(
        IdLookup.cases.Found.make({
          entry: { taxon: species, ancestors: [genus] },
        }),
      ),
    byName: () => Effect.succeed([homonym, hit]),
  });

  return Effect.gen(function* () {
    const hits = yield* TaxonLookup.checkName(species.taxonId, name);

    expect(hits).toEqual([hit]);
  }).pipe(Effect.provide(withNames));
});

it.effect("looks up the recorded genus for a nonnumeric identifier", () =>
  Effect.gen(function* () {
    const result = yield* TaxonLookup.genusOf(species.taxonId);

    expect(Option.getOrThrow(result)).toEqual({
      taxonId: { taxonomy: "fixture", id: "oak" },
      scientificName: "Quercus",
      rank: "genus",
    });
  }).pipe(Effect.provide(lookup)),
);

it.effect("includes the starting taxon in rank lookups", () =>
  Effect.gen(function* () {
    const result = yield* TaxonLookup.speciesOf(species.taxonId);

    expect(Option.getOrThrow(result).taxonId.id).toBe("oak/robur");
  }).pipe(Effect.provide(lookup)),
);

it.effect("rank shorthands leave unrecorded ranks unresolved", () =>
  Effect.gen(function* () {
    const id = species.taxonId;
    const ranks = yield* Effect.all([
      TaxonLookup.domainOf(id),
      TaxonLookup.kingdomOf(id),
      TaxonLookup.phylumOf(id),
      TaxonLookup.classOf(id),
      TaxonLookup.orderOf(id),
      TaxonLookup.familyOf(id),
    ]);

    expect(ranks.every(Option.isNone)).toBe(true);
  }).pipe(Effect.provide(lookup)),
);

it.effect("reports an absent name as false after resolving the identifier", () =>
  Effect.gen(function* () {
    const matches = yield* TaxonLookup.hasName(species.taxonId, TaxonName.make("Other name"));

    expect(matches).toBe(false);
  }).pipe(Effect.provide(lookup)),
);

const RowNameMismatch = Schema.TaggedStruct("RowNameMismatch", { row: Schema.Int });

it.effect("keeps a completed mismatch distinct from an unresolved identifier", () =>
  Effect.gen(function* () {
    const name = TaxonName.make("Other name");
    const mismatch = RowNameMismatch.make({ row: 12 });
    const onNoMatch = () => mismatch;

    const failure = yield* TaxonLookup.requireName(species.taxonId, name, onNoMatch).pipe(
      Effect.flip,
    );
    expect(failure).toBe(mismatch);

    const missing = TaxonId.make({ taxonomy: "fixture", id: "missing" });
    const unresolved = yield* TaxonLookup.requireName(missing, name, onNoMatch).pipe(Effect.flip);
    expect(unresolved).toEqual({ _tag: "NotFound", requested: missing });
  }).pipe(Effect.provide(lookup)),
);
