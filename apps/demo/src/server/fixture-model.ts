import { Array, Data, Effect, HashMap, Layer, Match, Option, Record, Schema, String } from "effect";
import { DecisionModel } from "effect/ai";
import { records } from "../lib/catalog.ts";

const inputSchema = Schema.Struct({
  records: Schema.Array(Schema.String),
  taxa: Schema.Array(Schema.Struct({ scientificName: Schema.String })),
});

const { Classify } = Data.taggedEnum<DecisionModel.ProviderClassifyAnswer>();

const quoteText = Schema.encodeSync(Schema.fromJsonString(Schema.String));

// Authored teaching placements, not model claims or evidence of natural co-occurrence.
const ancestorsByRecordId = HashMap.fromIterable<string, readonly string[]>([
  ["r01", ["Fungi", "Saccharomycetaceae", "Saccharomyces"]],
  ["r02", ["Fungi", "Saccharomycetaceae", "Kluyveromyces"]],
  ["r03", ["Fungi", "Debaryomyces"]],
  ["r04", ["Bacillota", "Lactobacillaceae", "Lactiplantibacillus"]],
  ["r05", ["Bacillota", "Lactobacillaceae", "Levilactobacillus"]],
  ["r06", ["Bacillota", "Lactobacillaceae", "Lacticaseibacillus"]],
  ["r07", ["Acetobacteraceae", "Acetobacter"]],
  ["r08", ["Acetobacteraceae", "Komagataeibacter"]],
  ["r09", ["Acetobacteraceae", "Gluconobacter"]],
  ["r10", ["Actinomycetota", "Streptomyces"]],
  ["r11", ["Actinomycetota", "Bifidobacterium"]],
  ["r12", ["Actinomycetota", "Corynebacterium"]],
  ["r13", ["Cyanobacteriota", "Synechococcus"]],
  ["r14", ["Cyanobacteriota", "Nostoc"]],
  ["r15", ["Cyanobacteriota", "Prochlorococcus"]],
  ["r16", ["Archaea", "Methanococcus"]],
  ["r17", ["Archaea", "Methanobacteriaceae", "Methanobacterium"]],
  ["r18", ["Archaea", "Haloferax"]],
  ["r19", ["Fungi", "Saccharomycetaceae"]],
  ["r20", ["Bacillota", "Lactobacillaceae"]],
  ["r21", ["Actinomycetota"]],
  ["r22", ["Archaea"]],
]);

class FixtureModelDefect extends Schema.TaggedError<
  FixtureModelDefect,
  { readonly brand: unique symbol }
>()("FixtureModelDefect", { message: Schema.String }) {}

type CatalogRecord = (typeof records)[number];

const renderRecord = (record: CatalogRecord) =>
  Match.value(record.kind).pipe(
    Match.when("vague", () => `Record label: ${quoteText(record.name)}`),
    Match.orElse(() => `Scientific name: ${quoteText(record.name)}`),
  );

const authoredLabel = (record: CatalogRecord, taxon: string) => {
  const ancestor = HashMap.get(ancestorsByRecordId, record.id).pipe(
    Option.exists((names) => Array.contains(names, taxon)),
  );

  return Match.value({ kind: record.kind, exact: record.name === taxon, ancestor }).pipe(
    Match.when({ kind: "vague" }, () => "undetermined" as const),
    Match.when({ exact: true }, () => "sameTaxon" as const),
    Match.when({ ancestor: true }, () => "withinTaxon" as const),
    Match.orElse(() => "noMatch" as const),
  );
};

const authoredProbabilities = (label: ReturnType<typeof authoredLabel>) => ({
  sameTaxon: label === "sameTaxon" ? 0.94 : 0.01,
  withinTaxon: label === "withinTaxon" ? 0.94 : 0.01,
  noMatch: label === "noMatch" ? 0.95 : 0.02,
  undetermined: label === "undetermined" ? 0.96 : 0.03,
});

const fixturePair = (input: typeof inputSchema.Type, key: string) =>
  String.match(/^r(\d+)t(\d+)$/u)(key).pipe(
    Option.flatMap((indices) => Option.all([Array.get(indices, 1), Array.get(indices, 2)])),
    Option.flatMap(([row, column]) =>
      Option.all([Array.get(input.records, Number(row)), Array.get(input.taxa, Number(column))]),
    ),
  );

const answerForKey = Effect.fnUntraced(function* (input: typeof inputSchema.Type, key: string) {
  const pair = fixturePair(input, key);

  const [recordText, target] = yield* Effect.fromOption(
    pair,
    () => new FixtureModelDefect({ message: "Unexpected fixture decision" }),
  );

  const candidate = Array.findFirst(records, (record) => renderRecord(record) === recordText);

  const record = yield* Effect.fromOption(
    candidate,
    () => new FixtureModelDefect({ message: "Unexpected fixture record" }),
  );

  const label = authoredLabel(record, target.scientificName);

  return [key, Classify({ label, probabilities: authoredProbabilities(label) })] as const;
}, Effect.orDie);

/**
 * Deterministic, offline teaching model using authored placements and illustrative probabilities.
 * It expects the demo's serialized records and indexed decision keys; unexpected input is a defect,
 * not a live taxonomy inference or evidence of natural co-occurrence.
 */
export const FixtureModel = Layer.effect(
  DecisionModel.DecisionModel,
  DecisionModel.make({
    decide: Effect.fnUntraced(function* ({ state, decisions }) {
      const input = yield* Schema.decodeUnknownEffect(inputSchema)(state).pipe(Effect.orDie);
      const keys = Record.keys(decisions);
      const answerEntries = yield* Effect.forEach(keys, (key) => answerForKey(input, key));
      const answers = Record.fromEntries(answerEntries);

      return { answers, usage: { inputTokens: undefined, outputTokens: undefined } };
    }),
  }),
);
