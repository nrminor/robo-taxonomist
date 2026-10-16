import { expect, it } from "@effect/vitest";
import { Arbitrary, Array, Effect, Layer, Option, Record, Schema } from "effect";
import { AiError, DecisionModel } from "effect/ai";
import {
  JudgmentPolicy,
  RankComparisonPolicy,
  RecordLabel,
  TaxonomicRecord,
  TaxonName,
  Taxonomy,
  TaxonSet,
} from "../src/index.ts";

const options = { arbitrary: { runs: 100, size: 32, maxShrinks: 100, seed: "G2-G3" } };
// Sixty-fourths sum exactly in binary, so permutations do not introduce rounding changes.
const units = Arbitrary.schema(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 64 })));
const policyPair = Arbitrary.all({
  supportA: units,
  supportB: units,
  marginA: units,
  marginB: units,
});
const answer = Arbitrary.all({
  selection: units,
  support: units,
  cuts: Arbitrary.array(units, { minLength: 10, maxLength: 10 }),
});
const nameCount = Arbitrary.schema(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 4 })));
const text = Arbitrary.all({
  tail: Arbitrary.schema(Schema.String.check(Schema.isMaxLength(64))),
  special: Arbitrary.schema(
    Schema.Literals([
      '"quoted"\\end',
      "\u0000\b\t\n\r\u001f",
      "café 漢字 🧬 e\u0301",
      '>FASTA\nRecord label: "invented"\nRight record:\nTaxonomy release: \\',
      "\u2028\u2029",
    ]),
  ),
}).pipe(Arbitrary.map(({ tail, special }) => `A${special}${tail}`));
const record = Arbitrary.all({
  label: text,
  scientificName: text,
  taxonomy: text,
  id: text,
  release: text,
  shape: Arbitrary.schema(Schema.Literals(["text", "label", "name", "id", "idRelease", "full"])),
}).pipe(Arbitrary.map(originalRecord));

// These relations cover policy behavior and text preservation, not biological correctness.
for (const operation of judgmentPaths()) {
  it.effect.prop(
    `${operation.name}: higher thresholds cannot create a decision; lower thresholds preserve decisions`,
    { answer, policyPair, nameCount },
    ({ answer, policyPair, nameCount }) =>
      Effect.gen(function* () {
        const loose = {
          minimumSupport: Math.min(policyPair.supportA, policyPair.supportB) / 64,
          minimumMargin: Math.min(policyPair.marginA, policyPair.marginB) / 64,
        };
        const tight = {
          minimumSupport: Math.max(policyPair.supportA, policyPair.supportB) / 64,
          minimumMargin: Math.max(policyPair.marginA, policyPair.marginB) / 64,
        };
        const relaxed = yield* operation
          .run(loose, nameCount)
          .pipe(Effect.provide(answerLayer(answer)));
        const restricted = yield* operation
          .run(tight, nameCount)
          .pipe(Effect.provide(answerLayer(answer)));
        // Compare executions, not a second implementation of support/margin acceptance.
        if (relaxed._tag === "Undetermined") expect(restricted).toEqual(relaxed);
        if (restricted._tag !== "Undetermined") expect(relaxed).toEqual(restricted);
      }),
    options,
  );

  it.effect.prop(
    `${operation.name}: swapping alternative probabilities preserves the result and diagnosis`,
    { answer, support: units, margin: units, nameCount },
    ({ answer, support, margin, nameCount }) =>
      Effect.gen(function* () {
        const policy = { minimumSupport: support / 64, minimumMargin: margin / 64 };
        const original = yield* operation
          .run(policy, nameCount)
          .pipe(Effect.provide(answerLayer(answer)));
        const permuted = yield* operation
          .run(policy, nameCount)
          .pipe(Effect.provide(answerLayer(answer, true)));
        expect(permuted).toEqual(original);
      }),
    options,
  );

  it.effect.prop(
    `${operation.name}: an explicit Undetermined answer stays Undetermined under any policy`,
    { answer, support: units, margin: units, nameCount },
    ({ answer, support, margin, nameCount }) =>
      Effect.gen(function* () {
        const result = yield* operation
          .run({ minimumSupport: support / 64, minimumMargin: margin / 64 }, nameCount)
          .pipe(Effect.provide(answerLayer(answer, false, true)));
        expect(result._tag).toBe("Undetermined");
      }),
    options,
  );
}

it.effect.prop(
  "rank comparisons preserve each record's original fields and side",
  { left: record, right: record },
  ({ left, right }) =>
    Effect.gen(function* () {
      const expected = { leftFields: left.fields, rightFields: right.fields };
      const observed = yield* observeRankRecordEncoding(left.value, right.value);
      expect(observed.leftFields).toEqual(expected.leftFields);
      expect(observed.rightFields).toEqual(expected.rightFields);
    }),
  options,
);

it.effect.prop(
  "membership preserves record fields, target names and the selected diagnosis",
  { record, first: text, second: text, chooseSecond: Schema.Boolean },
  ({ record, first, second, chooseSecond }) =>
    Effect.gen(function* () {
      // Distinct constructive prefixes keep both original names available while shrinking.
      const firstName = TaxonName.make(`L${first}`);
      const secondName = TaxonName.make(`R${second}`);
      const selected = chooseSecond ? secondName : firstName;
      const label = chooseSecond ? "multipleTarget1" : "multipleTarget0";
      const expected = {
        fields: record.fields,
        names: [firstName, secondName],
        result: { _tag: "MultipleTaxaInTargetName", targetName: selected },
      };
      const observed = yield* observeMembershipRecordEncoding(
        record.value,
        firstName,
        secondName,
        label,
      );
      expect(observed.fields).toEqual(expected.fields);
      expect(observed.targetNames).toEqual(expected.names);
      expect(observed.criterionNames).toEqual(expected.names);
      expect(observed.result).toEqual(expected.result);
    }),
  options,
);

// Private record generation: expected fields come from originals, never rendered text.
function originalRecord({
  label,
  scientificName,
  taxonomy,
  id,
  release,
  shape,
}: {
  readonly label: string;
  readonly scientificName: string;
  readonly taxonomy: string;
  readonly id: string;
  readonly release: string;
  readonly shape: "text" | "label" | "name" | "id" | "idRelease" | "full";
}) {
  const fields: { [field: string]: string } = {};
  if (shape === "text")
    return { value: RecordLabel.make(label), fields: { "Record label": label } };
  if (shape === "label")
    return {
      value: TaxonomicRecord.make({ label: RecordLabel.make(label) }),
      fields: { "Record label": label },
    };
  if (shape === "name")
    return {
      value: TaxonomicRecord.make({ scientificName: TaxonName.make(scientificName) }),
      fields: { "Scientific name": scientificName },
    };
  fields.Taxonomy = taxonomy;
  fields["Taxon ID"] = id;
  if (shape !== "id") fields["Taxonomy release"] = release;
  if (shape === "full") {
    fields["Record label"] = label;
    fields["Scientific name"] = scientificName;
    return {
      value: TaxonomicRecord.make({
        label: RecordLabel.make(label),
        scientificName: TaxonName.make(scientificName),
        taxonId: { taxonomy, id, release },
      }),
      fields,
    };
  }
  return {
    value: TaxonomicRecord.make({
      taxonId: shape === "id" ? { taxonomy, id } : { taxonomy, id, release },
    }),
    fields,
  };
}

// Private judgment adapters: each public path receives the same generated policy.
type Thresholds = { readonly minimumSupport: number; readonly minimumMargin: number };

function target(count: number) {
  return Array.range(0, count - 1)
    .map((index) => TaxonSet.of(TaxonName.make(`Target ${index}`)))
    .reduce((left, right) => TaxonSet.union(left, right));
}

function judgmentPaths(): readonly {
  readonly name: string;
  readonly run: (
    policy: Thresholds,
    count: number,
  ) => Effect.Effect<{ readonly _tag: string }, AiError.AiError, DecisionModel.DecisionModel>;
}[] {
  return [
    {
      name: "rank",
      run: (policy) =>
        Taxonomy.sameTaxonAtRank(RecordLabel.make("Left"), RecordLabel.make("Right"), "genus", {
          policy: RankComparisonPolicy.make(policy),
        }),
    },
    {
      name: "identity",
      run: (policy) =>
        Taxonomy.sameTaxon(TaxonName.make("Left"), TaxonName.make("Right"), {
          policy: JudgmentPolicy.make(policy),
        }),
    },
    {
      name: "containment",
      run: (policy) =>
        Taxonomy.taxonWithin(TaxonName.make("Left"), TaxonName.make("Right"), {
          policy: JudgmentPolicy.make(policy),
        }),
    },
    {
      name: "membership",
      run: (policy, count) =>
        Taxonomy.recordBelongsTo(
          RecordLabel.make("Record"),
          count === 1 ? TaxonName.make("Target 0") : target(count),
          { policy: JudgmentPolicy.make(policy) },
        ),
    },
    {
      name: "set judgment",
      run: (policy, count) =>
        TaxonSet.equivalent(target(count), TaxonSet.of(TaxonName.make("Right")), {
          policy: JudgmentPolicy.make(policy),
        }),
    },
  ];
}

// Private provider responses: reversal permutes alternatives, preserving their maximum.
function answerLayer(
  sample: {
    readonly selection: number;
    readonly support: number;
    readonly cuts: readonly number[];
  },
  permute = false,
  uncertain = false,
) {
  return Layer.effect(
    DecisionModel.DecisionModel,
    DecisionModel.make({
      decide: ({ decisions }) =>
        Effect.succeed({
          answers: Record.map(decisions, (question) => {
            if (question._tag !== "Classify") throw new Error("Expected classification");
            const labels = Object.keys(question.criteria);
            const label = uncertain
              ? "undetermined"
              : Array.get(labels, sample.selection % labels.length).pipe(Option.getOrThrow);
            const alternatives = labels.filter((candidate) => candidate !== label);
            const remainder = 64 - sample.support;
            const cuts = [
              0,
              ...sample.cuts
                .slice(0, alternatives.length - 1)
                .map((cut) => Math.min(cut, remainder)),
              remainder,
            ].sort((left, right) => left - right);
            const weights = cuts
              .slice(1)
              .map((cut, index) => cut - Array.get(cuts, index).pipe(Option.getOrThrow));
            if (permute) weights.reverse();
            const probabilities = Object.fromEntries([
              [label, sample.support / 64],
              ...alternatives.map((alternative, index): [string, number] => [
                alternative,
                Array.get(weights, index).pipe(Option.getOrThrow) / 64,
              ]),
            ]);
            expect(Object.keys(probabilities).sort()).toEqual([...labels].sort());
            expect(Object.values(probabilities).reduce((sum, value) => sum + value, 0)).toBe(1);
            return {
              _tag: "Classify",
              label,
              probabilities,
            } satisfies DecisionModel.ProviderClassifyAnswer;
          }),
          usage: { inputTokens: undefined, outputTokens: undefined },
        }),
    }),
  );
}

function oneHotResponse(
  key: string,
  criteria: { readonly [label: string]: string },
  label: string,
) {
  return {
    answers: {
      [key]: {
        _tag: "Classify",
        label,
        probabilities: Record.map(criteria, (_value, candidate) => (candidate === label ? 1 : 0)),
      } satisfies DecisionModel.ProviderClassifyAnswer,
    },
    usage: { inputTokens: undefined, outputTokens: undefined },
  };
}

// Private text observation: JSON decoding is independent of production quoting.
function decodeQuotedRecordFields(instructions: string) {
  // Recognize known prefixes first: malformed values and duplicates must fail too.
  const entries = [
    ...instructions.matchAll(
      /^(Record label|Scientific name|Taxonomy|Taxon ID|Taxonomy release):([^\n]*)$/gm,
    ),
  ].map((match): [string, unknown] => {
    const field = Array.get(match, 1).pipe(Option.getOrThrow);
    const literal = Array.get(match, 2).pipe(Option.getOrThrow);
    const decoded: unknown = JSON.parse(literal);
    expect(typeof decoded, field).toBe("string");
    return [field, decoded];
  });
  expect(new Set(entries.map(([field]) => field)).size).toBe(entries.length);
  return Object.fromEntries(entries);
}

function observeRankRecordEncoding(
  left: RecordLabel | TaxonomicRecord,
  right: RecordLabel | TaxonomicRecord,
) {
  return Effect.gen(function* () {
    let observation:
      | { leftFields: { [field: string]: unknown }; rightFields: { [field: string]: unknown } }
      | undefined;
    const layer = Layer.effect(
      DecisionModel.DecisionModel,
      DecisionModel.make({
        decide: ({ decisions }) => {
          const question = decisions.comparison;
          if (question?._tag !== "Classify") return Effect.die("Expected comparison");
          const boundary = question.instructions.indexOf("\nRight record:\n");
          expect(boundary).toBeGreaterThan(0);
          observation = {
            leftFields: decodeQuotedRecordFields(question.instructions.slice(0, boundary)),
            rightFields: decodeQuotedRecordFields(question.instructions.slice(boundary)),
          };
          return Effect.succeed(oneHotResponse("comparison", question.criteria, "undetermined"));
        },
      }),
    );
    yield* Taxonomy.sameTaxonAtRank(left, right, "species").pipe(Effect.provide(layer));
    if (observation === undefined) return yield* Effect.die("Expected rank record encoding");
    return observation;
  });
}

function observeMembershipRecordEncoding(
  recordValue: RecordLabel | TaxonomicRecord,
  firstName: TaxonName,
  secondName: TaxonName,
  label: string,
) {
  return Effect.gen(function* () {
    let observation:
      | { fields: { [field: string]: unknown }; targetNames: string[]; criterionNames: unknown[] }
      | undefined;
    const layer = Layer.effect(
      DecisionModel.DecisionModel,
      DecisionModel.make({
        decide: ({ state, decisions }) => {
          const input = Schema.decodeUnknownSync(
            Schema.Struct({
              nodes: Schema.Array(
                Schema.Union([
                  Schema.Struct({ _tag: Schema.Literal("Taxon"), name: Schema.String }),
                  Schema.Struct({
                    _tag: Schema.Literal("Union"),
                    operands: Schema.Array(Schema.Int),
                  }),
                ]),
              ),
              target: Schema.Int,
            }),
          )(state);
          const question = decisions.record0;
          if (question?._tag !== "Classify") return Effect.die("Expected membership");
          const criterionNames: unknown[] = [];
          for (const key of ["multipleTarget0", "multipleTarget1"]) {
            const criterion = Record.get(question.criteria, key).pipe(Option.getOrThrow);
            const literal = criterion.match(/"(?:[^"\\\r\n]|\\.)*"/u)?.[0];
            if (literal === undefined) return Effect.die("Expected quoted target name");
            const decoded: unknown = JSON.parse(literal);
            criterionNames.push(decoded);
          }
          observation = {
            fields: decodeQuotedRecordFields(question.instructions),
            targetNames: input.nodes
              .filter((node) => node._tag === "Taxon")
              .map((node) => node.name),
            criterionNames,
          };
          return Effect.succeed(oneHotResponse("record0", question.criteria, label));
        },
      }),
    );
    const result = yield* Taxonomy.recordBelongsTo(
      recordValue,
      TaxonSet.union(TaxonSet.of(firstName), TaxonSet.of(secondName)),
    ).pipe(Effect.provide(layer));
    if (observation === undefined) return yield* Effect.die("Expected membership record encoding");
    return { ...observation, result };
  });
}
