import assert from "node:assert/strict";
import { Effect, Layer } from "effect";
import { DecisionModel } from "effect/ai";
import * as RoboTaxonomist from "robo-taxonomist";
import { TaxonName, TaxonSet, Taxonomy } from "robo-taxonomist";

const oaks = TaxonSet.of(TaxonName.make("Quercus"));

assert.equal(TaxonSet.union(oaks, oaks)._tag, "Union");

const species = TaxonSet.of(TaxonName.make("Quercus robur"));
const panel = TaxonSet.union(oaks, species);
const record = { scientificName: TaxonName.make("Quercus robur"), abundance: 8 };
const model = Layer.effect(
  DecisionModel.DecisionModel,
  DecisionModel.make({
    decide: () =>
      Effect.succeed({
        answers: {
          r0t0: {
            _tag: "Classify",
            label: "withinTaxon",
            probabilities: {
              sameTaxon: 0.01,
              withinTaxon: 0.95,
              noMatch: 0.02,
              undetermined: 0.02,
            },
          },
          r0t1: {
            _tag: "Classify",
            label: "sameTaxon",
            probabilities: {
              sameTaxon: 0.94,
              withinTaxon: 0.01,
              noMatch: 0.02,
              undetermined: 0.03,
            },
          },
        },
        usage: { inputTokens: 10, outputTokens: 20 },
      }),
  }),
);

const classified = await Effect.runPromise(
  Taxonomy.classifyRecords([record], panel).pipe(Effect.provide(model)),
);
assert.equal(classified.panel, panel);
assert.equal(classified.records[0].record, record);
assert.equal(classified.records[0].taxa[0].taxon, oaks);
assert.equal(classified.records[0].ranking[1].taxon, species);
assert.deepEqual(
  classified.records[0].ranking.map((match) => match.support),
  [0.96, 0.95],
);
assert.equal(
  classified.records[0].ranking[0].pipe((match) => match.record.abundance),
  8,
);
assert.equal(classified.usage.length, 1);
assert.equal("TaxonMatch" in RoboTaxonomist, false);
assert.equal("Support" in RoboTaxonomist, false);
assert.equal("UnitInterval" in RoboTaxonomist, false);
