import assert from "node:assert/strict";
import { Array, Data, Effect, Layer, Option } from "effect";
import { DecisionModel } from "effect/ai";
import * as RoboTaxonomist from "robo-taxonomist";
import { TaxonId, TaxonName, TaxonSet, Taxonomy } from "robo-taxonomist";

const oaks = TaxonSet.of(TaxonName.make("Quercus"));

assert.equal(TaxonSet.union(oaks, oaks)._tag, "Union");

const assignment = {
  scientificName: TaxonName.make("Quercus robur"),
  taxonId: TaxonId.make({ taxonomy: "ncbi", id: "58334" }),
  assignmentId: "oak-species",
};
const species = TaxonSet.of(assignment);
const panel = TaxonSet.unionAll([oaks, species]);
const record = { scientificName: TaxonName.make("Quercus robur"), abundance: 8 };
const { Classify } = Data.taggedEnum();
const model = Layer.effect(
  DecisionModel.DecisionModel,
  DecisionModel.make({
    decide: () =>
      Effect.succeed({
        answers: {
          r0t0: Classify({
            label: "withinTaxon",
            probabilities: {
              sameTaxon: 0.01,
              withinTaxon: 0.95,
              noMatch: 0.02,
              undetermined: 0.02,
            },
          }),
          r0t1: Classify({
            label: "sameTaxon",
            probabilities: {
              sameTaxon: 0.94,
              withinTaxon: 0.01,
              noMatch: 0.02,
              undetermined: 0.03,
            },
          }),
        },
        usage: { inputTokens: 10, outputTokens: 20 },
      }),
  }),
);

const classified = await Effect.runPromise(
  Taxonomy.classifyRecords([record], panel).pipe(Effect.provide(model)),
);
assert.equal(classified.panel, panel);
const row = Array.head(classified.records).pipe(Option.getOrThrow);
const firstTaxon = Array.head(row.taxa).pipe(Option.getOrThrow);
const firstRanked = Array.head(row.ranking).pipe(Option.getOrThrow);
const secondRanked = Array.get(row.ranking, 1).pipe(Option.getOrThrow);
assert.equal(row.record, record);
assert.equal(firstTaxon.taxon, oaks);
assert.equal(secondRanked.taxon, species);
assert.equal(species.record, assignment);
assert.equal(secondRanked.taxon.record.assignmentId, "oak-species");
assert.deepEqual(
  row.ranking.map((match) => match.support),
  [0.96, 0.95],
);
assert.equal(
  firstRanked.pipe((match) => match.record.abundance),
  8,
);
assert.equal(classified.usage.length, 1);
assert.equal("TaxonMatch" in RoboTaxonomist, false);
assert.equal("Support" in RoboTaxonomist, false);
assert.equal("UnitInterval" in RoboTaxonomist, false);
