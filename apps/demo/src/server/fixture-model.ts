import { Data, Effect, Layer, Record, Schema } from "effect";
import { DecisionModel } from "effect/ai";
import { records } from "../lib/catalog.ts";

const inputSchema = Schema.Struct({
  records: Schema.Array(Schema.String),
  taxa: Schema.Array(Schema.Struct({ scientificName: Schema.String })),
});
const { Classify } = Data.taggedEnum<DecisionModel.ProviderClassifyAnswer>();

// Authored teaching placements, not model claims or evidence of natural co-occurrence.
const ancestors: Readonly<Record<string, readonly string[]>> = {
  r01: ["Fungi", "Saccharomycetaceae", "Saccharomyces"],
  r02: ["Fungi", "Saccharomycetaceae", "Kluyveromyces"],
  r03: ["Fungi", "Debaryomyces"],
  r04: ["Bacillota", "Lactobacillaceae", "Lactiplantibacillus"],
  r05: ["Bacillota", "Lactobacillaceae", "Levilactobacillus"],
  r06: ["Bacillota", "Lactobacillaceae", "Lacticaseibacillus"],
  r07: ["Acetobacteraceae", "Acetobacter"],
  r08: ["Acetobacteraceae", "Komagataeibacter"],
  r09: ["Acetobacteraceae", "Gluconobacter"],
  r10: ["Actinomycetota", "Streptomyces"],
  r11: ["Actinomycetota", "Bifidobacterium"],
  r12: ["Actinomycetota", "Corynebacterium"],
  r13: ["Cyanobacteriota", "Synechococcus"],
  r14: ["Cyanobacteriota", "Nostoc"],
  r15: ["Cyanobacteriota", "Prochlorococcus"],
  r16: ["Archaea", "Methanococcus"],
  r17: ["Archaea", "Methanobacteriaceae", "Methanobacterium"],
  r18: ["Archaea", "Haloferax"],
  r19: ["Fungi", "Saccharomycetaceae"],
  r20: ["Bacillota", "Lactobacillaceae"],
  r21: ["Actinomycetota"],
  r22: ["Archaea"],
};

const authoredAnswer = (
  recordText: string,
  taxon: string,
): DecisionModel.ProviderClassifyAnswer => {
  const record = records.find(
    (entry) =>
      recordText ===
      `${entry.kind === "vague" ? "Record label" : "Scientific name"}: ${JSON.stringify(entry.name)}`,
  );
  if (record === undefined) throw new Error("Unexpected fixture record");
  const label =
    record.kind === "vague"
      ? "undetermined"
      : record.name === taxon
        ? "sameTaxon"
        : ancestors[record.id]?.includes(taxon)
          ? "withinTaxon"
          : "noMatch";
  return Classify({
    label,
    probabilities: {
      sameTaxon: label === "sameTaxon" ? 0.94 : 0.01,
      withinTaxon: label === "withinTaxon" ? 0.94 : 0.01,
      noMatch: label === "noMatch" ? 0.95 : 0.02,
      undetermined: label === "undetermined" ? 0.96 : 0.03,
    },
  });
};

/**
 * Deterministic, offline teaching model using authored placements and illustrative probabilities.
 * It expects the demo's serialized records and indexed decision keys; unexpected input is a defect,
 * not a live taxonomy inference or evidence of natural co-occurrence.
 */
export const FixtureModel = Layer.effect(
  DecisionModel.DecisionModel,
  DecisionModel.make({
    decide: ({ state, decisions }) =>
      Effect.gen(function* () {
        const input = yield* Schema.decodeUnknownEffect(inputSchema)(state).pipe(Effect.orDie);
        const answers: Record<string, DecisionModel.ProviderClassifyAnswer> = {};
        for (const key of Record.keys(decisions)) {
          const indices = /^r(\d+)t(\d+)$/.exec(key);
          const record = indices === null ? undefined : input.records[Number(indices[1])];
          const taxon = indices === null ? undefined : input.taxa[Number(indices[2])];
          if (record === undefined || taxon === undefined)
            throw new Error("Unexpected fixture decision");
          answers[key] = authoredAnswer(record, taxon.scientificName);
        }
        return { answers, usage: { inputTokens: undefined, outputTokens: undefined } };
      }),
  }),
);
