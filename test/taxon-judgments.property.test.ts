import { expect, it } from "@effect/vitest";
import {
  Arbitrary,
  Array,
  Effect,
  Iterable,
  Layer,
  Option,
  Predicate,
  Record,
  Schema,
  pipe,
} from "effect";
import { DecisionModel } from "effect/ai";
import {
  RecordLabel,
  TaxonId,
  TaxonomicRecord,
  TaxonName,
  Taxonomy,
  TaxonSet,
} from "../src/index.ts";

const options = { arbitrary: { runs: 100, size: 32, maxShrinks: 100, seed: "G2-G3" } };
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
}).pipe(Arbitrary.map(originalRecord));

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

// Sparse presence is fixed separately so generated hostile text always exercises every field.
it.effect.each([
  ["bare label", RecordLabel.make("label"), { "Record label": "label" }],
  [
    "record label only",
    TaxonomicRecord.make({ label: RecordLabel.make("label") }),
    { "Record label": "label" },
  ],
  [
    "name only",
    TaxonomicRecord.make({ scientificName: TaxonName.make("name") }),
    { "Scientific name": "name" },
  ],
  [
    "ID without release",
    TaxonomicRecord.make({ taxonId: TaxonId.make({ taxonomy: "local", id: "17" }) }),
    { Taxonomy: "local", "Taxon ID": "17" },
  ],
  [
    "ID with release",
    TaxonomicRecord.make({ taxonId: TaxonId.make({ taxonomy: "local", id: "17", release: "v1" }) }),
    { Taxonomy: "local", "Taxon ID": "17", "Taxonomy release": "v1" },
  ],
] as const)("preserves only supplied fields for %s", ([_case, value, fields]) =>
  Effect.gen(function* () {
    const expected = { fields, rightFields: { "Record label": "right" } };
    const rank = yield* observeRankRecordEncoding(value, RecordLabel.make("right"));
    const membership = yield* observeMembershipRecordEncoding(
      value,
      TaxonName.make("first"),
      TaxonName.make("second"),
      "multipleTarget0",
    );
    expect(rank.leftFields).toEqual(expected.fields);
    expect(rank.rightFields).toEqual(expected.rightFields);
    expect(membership.fields).toEqual(expected.fields);
  }),
);

// Private record generation: expected fields come from originals, never rendered text.
function originalRecord({
  label,
  scientificName,
  taxonomy,
  id,
  release,
}: {
  readonly label: string;
  readonly scientificName: string;
  readonly taxonomy: string;
  readonly id: string;
  readonly release: string;
}) {
  return {
    value: TaxonomicRecord.make({
      label: RecordLabel.make(label),
      scientificName: TaxonName.make(scientificName),
      taxonId: TaxonId.make({ taxonomy, id, release }),
    }),
    fields: {
      "Record label": label,
      "Scientific name": scientificName,
      Taxonomy: taxonomy,
      "Taxon ID": id,
      "Taxonomy release": release,
    },
  };
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
  const entries = pipe(
    instructions.matchAll(
      /^(Record label|Scientific name|Taxonomy|Taxon ID|Taxonomy release):([^\n]*)$/gm,
    ),
    Iterable.map((match): [string, unknown] => {
      const field = Array.get(match, 1).pipe(Option.getOrThrow);
      const literal = Array.get(match, 2).pipe(Option.getOrThrow);
      const decoded: unknown = JSON.parse(literal);
      expect(typeof decoded, field).toBe("string");
      return [field, decoded];
    }),
    Array.fromIterable,
  );
  const fields = Record.fromEntries(entries);
  expect(Record.size(fields)).toBe(entries.length);
  return fields;
}

const observeRankRecordEncoding = Effect.fnUntraced(function* (
  left: RecordLabel | TaxonomicRecord,
  right: RecordLabel | TaxonomicRecord,
) {
  let observation: Option.Option<{
    leftFields: { [field: string]: unknown };
    rightFields: { [field: string]: unknown };
  }> = Option.none();
  const layer = Layer.effect(
    DecisionModel.DecisionModel,
    DecisionModel.make({
      decide: ({ decisions }) => {
        const question = Record.get(decisions, "comparison").pipe(Option.getOrThrow);
        if (!Predicate.isTagged(question, "Classify")) return Effect.die("Expected comparison");
        const boundary = question.instructions.indexOf("\nRight record:\n");
        expect(boundary).toBeGreaterThan(0);
        observation = Option.some({
          leftFields: decodeQuotedRecordFields(question.instructions.slice(0, boundary)),
          rightFields: decodeQuotedRecordFields(question.instructions.slice(boundary)),
        });
        return Effect.succeed(oneHotResponse("comparison", question.criteria, "undetermined"));
      },
    }),
  );
  yield* Taxonomy.sameTaxonAtRank(left, right, "species").pipe(Effect.provide(layer));
  return Option.getOrThrow(observation);
});

const observeMembershipRecordEncoding = Effect.fnUntraced(function* (
  recordValue: RecordLabel | TaxonomicRecord,
  firstName: TaxonName,
  secondName: TaxonName,
  label: string,
) {
  let observation: Option.Option<{
    fields: { [field: string]: unknown };
    targetNames: string[];
    criterionNames: unknown[];
  }> = Option.none();
  const layer = Layer.effect(
    DecisionModel.DecisionModel,
    DecisionModel.make({
      decide: ({ state, decisions }) => {
        const TaxonNode = Schema.TaggedStruct("Taxon", { name: Schema.String });
        const input = Schema.decodeUnknownSync(
          Schema.Struct({
            nodes: Schema.Array(
              Schema.Union([
                TaxonNode,
                Schema.TaggedStruct("Union", {
                  operands: Schema.Array(Schema.Int),
                }),
              ]),
            ),
            target: Schema.Int,
          }),
        )(state);
        const question = Record.get(decisions, "record0").pipe(Option.getOrThrow);
        if (!Predicate.isTagged(question, "Classify")) return Effect.die("Expected membership");
        const criterionNames = Array.map(["multipleTarget0", "multipleTarget1"], (key) => {
          const criterion = Record.get(question.criteria, key).pipe(Option.getOrThrow);
          const literal = Option.fromNullOr(criterion.match(/"(?:[^"\\\r\n]|\\.)*"/u)).pipe(
            Option.flatMap(Array.head),
            Option.getOrThrow,
          );
          const decoded: unknown = JSON.parse(literal);
          return decoded;
        });
        observation = Option.some({
          fields: decodeQuotedRecordFields(question.instructions),
          targetNames: pipe(
            input.nodes,
            Array.filter(Schema.is(TaxonNode)),
            Array.map((node) => node.name),
          ),
          criterionNames,
        });
        return Effect.succeed(oneHotResponse("record0", question.criteria, label));
      },
    }),
  );
  const result = yield* Taxonomy.recordBelongsTo(
    recordValue,
    TaxonSet.union(TaxonSet.of(firstName), TaxonSet.of(secondName)),
  ).pipe(Effect.provide(layer));
  return { ...Option.getOrThrow(observation), result };
});
