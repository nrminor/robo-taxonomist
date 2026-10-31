import { expect, it } from "@effect/vitest";
import { Effect, Layer, Predicate, Record, Schema } from "effect";
import { DecisionModel } from "effect/ai";
import { RecordLabel, TaxonId, TaxonName, TaxonSet, Taxonomy } from "../src/index.ts";

// Exercise the real DecisionModel contract with deterministic transport, not biological accuracy.
const modelLayer = (
  label: string,
  inspect: (state: unknown, instructions: readonly string[]) => void = () => {},
) =>
  Layer.effect(
    DecisionModel.DecisionModel,
    DecisionModel.make({
      decide: ({ state, decisions }) => {
        const instructions: string[] = [];
        const answers = Record.map(decisions, (question): DecisionModel.ProviderClassifyAnswer => {
          if (!Predicate.isTagged(question, "Classify")) throw new Error("Expected classification");
          instructions.push(question.instructions);
          expect(Record.keys(question.criteria)).toContain(label);
          return {
            _tag: "Classify",
            label,
            probabilities: Record.map(question.criteria, (_criterion, key) =>
              key === label ? 1 : 0,
            ),
          };
        });
        inspect(state, instructions);
        return Effect.succeed({
          answers,
          usage: { inputTokens: undefined, outputTokens: undefined },
        });
      },
    }),
  );

const assignment = () => ({
  label: RecordLabel.make('Voucher "A17"'),
  scientificName: TaxonName.make("Quercus robur"),
  taxonId: TaxonId.make({ taxonomy: "local-taxonomy", id: "oak-17", release: "2026-01" }),
  sampleId: "private-target-metadata",
});

it("constructs structured targets locally and retains each original record and metadata", () => {
  const full = assignment();
  const idOnly = { taxonId: TaxonId.make({ taxonomy: "ncbi", id: "9606" }), sampleId: "id-only" };
  const labelOnly = { label: RecordLabel.make("Unresolved voucher"), abundance: 7 };
  for (const record of [full, idOnly, labelOnly]) {
    const target = TaxonSet.of(record);
    expect(target._tag).toBe("Taxon");
    expect(target.record).toBe(record);
  }
  expect(TaxonSet.of(full).record.sampleId).toBe("private-target-metadata");
  expect(TaxonSet.of(labelOnly).record.abundance).toBe(7);
  expect(TaxonSet.of(TaxonName.make("Quercus")).record).toEqual({ scientificName: "Quercus" });
});

it("rejects an invalid optional identifier rather than falling back to a valid name", () => {
  expect(() =>
    TaxonSet.of({
      scientificName: TaxonName.make("Quercus robur"),
      taxonId: { taxonomy: "ncbi", id: " " },
    }),
  ).toThrow();
});

it.effect.each(["identity", "containment"] as const)(
  "preserves both structured operands as identifying evidence for %s, excluding metadata",
  (operation) => {
    const left = assignment();
    const right = {
      label: RecordLabel.make("Outer voucher"),
      scientificName: TaxonName.make("Fagus sylvatica"),
      taxonId: TaxonId.make({ taxonomy: "other-taxonomy", id: "beech-42", release: "2025-12" }),
      sampleId: "private-right-metadata",
    };
    let calls = 0;
    const layer = modelLayer(operation === "identity" ? "same" : "equal", (state, instructions) => {
      calls++;
      expect(state).toBeNull();
      expect(instructions).toHaveLength(1);
      const text = instructions.join("\n");
      for (const evidence of [
        'Voucher \\"A17\\"',
        "Quercus robur",
        "local-taxonomy",
        "oak-17",
        "2026-01",
        "Outer voucher",
        "Fagus sylvatica",
        "other-taxonomy",
        "beech-42",
        "2025-12",
      ])
        expect(text).toContain(evidence);
      expect(text).not.toContain("private-target-metadata");
      expect(text).not.toContain("private-right-metadata");
      expect(text.indexOf("oak-17")).toBeLessThan(text.indexOf("beech-42"));
    });
    return Effect.gen(function* () {
      const result = yield* operation === "identity"
        ? Taxonomy.sameTaxon(left, right)
        : Taxonomy.taxonWithin(left, right);
      expect(result).toEqual({ _tag: operation === "identity" ? "SameTaxon" : "Contained" });
      expect(calls).toBe(1);
      expect(left.sampleId).toBe("private-target-metadata");
    }).pipe(Effect.provide(layer));
  },
);

it.effect(
  "rejects invalid optional identifiers in comparisons and direct targets before transport",
  () => {
    let calls = 0;
    const invalid = {
      scientificName: TaxonName.make("Quercus"),
      taxonId: { taxonomy: "ncbi", id: " " },
    };
    const valid = assignment();
    const layer = modelLayer("undetermined", () => {
      calls++;
    });
    return Effect.gen(function* () {
      const failures = [
        Effect.flip(Taxonomy.sameTaxon(invalid, valid)),
        Effect.flip(Taxonomy.sameTaxon(valid, invalid)),
        Effect.flip(Taxonomy.taxonWithin(invalid, valid)),
        Effect.flip(Taxonomy.taxonWithin(valid, invalid)),
        Effect.flip(Taxonomy.recordBelongsTo(RecordLabel.make("specimen"), invalid)),
      ];
      for (const failure of failures) {
        const error = yield* failure;
        expect(error.reason._tag).toBe("InvalidUserInputError");
      }
      expect(calls).toBe(0);
    }).pipe(Effect.provide(layer));
  },
);

it.effect("accepts a structured direct membership target without leaking metadata", () => {
  const target = assignment();
  let calls = 0;
  const layer = modelLayer("member", (state) => {
    calls++;
    expect(state).toEqual({
      nodes: [
        {
          _tag: "Taxon",
          record: {
            label: 'Voucher "A17"',
            scientificName: "Quercus robur",
            taxonId: { taxonomy: "local-taxonomy", id: "oak-17", release: "2026-01" },
          },
        },
      ],
      target: 0,
    });
  });
  return Effect.gen(function* () {
    const result = yield* Taxonomy.recordBelongsTo(RecordLabel.make("Oak specimen"), target);
    expect(result).toEqual({
      _tag: "Member",
    });
    expect(calls).toBe(1);
  }).pipe(Effect.provide(layer));
});

it.effect("identifies the original ID-only target node without fabricating a name", () => {
  const record = {
    taxonId: TaxonId.make({ taxonomy: "local", id: "pooled-17" }),
    sampleId: "private-id",
  };
  const target = TaxonSet.of(record);
  const layer = modelLayer("multipleTarget0", (state) => {
    expect(state).toEqual({
      nodes: [{ _tag: "Taxon", record: { taxonId: { taxonomy: "local", id: "pooled-17" } } }],
      target: 0,
    });
  });
  return Effect.gen(function* () {
    const result = yield* Taxonomy.recordBelongsTo(RecordLabel.make("specimen"), target);
    expect(result).toEqual({ _tag: "MultipleTaxaInTarget", target });
    if (result._tag !== "MultipleTaxaInTarget") throw new Error("Expected target clarification");
    expect(result.target).toBe(target);
    expect(result.target.record).toBe(record);
  }).pipe(Effect.provide(layer));
});

it.effect(
  "target clarification follows DFS source-node order, not deduplicated identifying values",
  () => {
    const first = TaxonSet.of({ taxonId: TaxonId.make({ taxonomy: "local", id: "same-id" }) });
    const second = TaxonSet.of({
      taxonId: TaxonId.make({ taxonomy: "local", id: "same-id" }),
      sampleId: "second",
    });
    const target = TaxonSet.difference(
      TaxonSet.union(first, TaxonSet.intersection(second, first)),
      second,
    );
    return Effect.gen(function* () {
      const result = yield* Taxonomy.recordBelongsTo(RecordLabel.make("specimen"), target);
      expect(result).toEqual({ _tag: "MultipleTaxaInTarget", target: second });
      if (result._tag !== "MultipleTaxaInTarget") throw new Error("Expected target clarification");
      expect(result.target).toBe(second);
      expect(result.target.record).toBe(second.record);
    }).pipe(Effect.provide(modelLayer("multipleTarget1")));
  },
);

it.effect.each(["left", "right"] as const)(
  "set clarification retains the original structured taxon on the %s",
  (side) => {
    const taxon = TaxonSet.of(assignment());
    const left = TaxonSet.union(TaxonSet.empty(), taxon);
    const right = TaxonSet.of({ taxonId: TaxonId.make({ taxonomy: "ncbi", id: "9606" }) });
    return Effect.gen(function* () {
      const result = yield* side === "left"
        ? TaxonSet.equivalent(left, right)
        : TaxonSet.equivalent(right, left);
      expect(result).toEqual({ _tag: "MultipleTaxaInSet", relation: "equivalent", side, taxon });
      if (result._tag !== "MultipleTaxaInSet") throw new Error("Expected set clarification");
      expect(result.taxon).toBe(taxon);
    }).pipe(Effect.provide(modelLayer(side === "left" ? "multipleLeft0" : "multipleRight0")));
  },
);

it.effect(
  "classification uses all target fields, preserves original matches, and requires explicit composition",
  () => {
    const source = { ...assignment(), label: RecordLabel.make("Quercus and Fagus assignments") };
    const first = TaxonSet.of(source);
    const second = TaxonSet.of({
      taxonId: TaxonId.make({ taxonomy: "ncbi", id: "9606" }),
      sampleId: "private-id",
    });
    const specimen = { label: RecordLabel.make("Specimen 17"), abundance: 9 };
    const stateSchema = Schema.Struct({
      records: Schema.Array(Schema.String),
      taxa: Schema.Array(
        Schema.Struct({
          label: Schema.optionalKey(Schema.String),
          scientificName: Schema.optionalKey(Schema.String),
          taxonId: Schema.optionalKey(
            Schema.Struct({
              taxonomy: Schema.String,
              id: Schema.String,
              release: Schema.optionalKey(Schema.String),
            }),
          ),
        }),
      ),
    });
    let calls = 0;
    const layer = Layer.effect(
      DecisionModel.DecisionModel,
      DecisionModel.make({
        decide: ({ state, decisions }) => {
          calls++;
          const input = Schema.decodeUnknownSync(stateSchema)(state);
          expect(input.records).toEqual(['Record label: "Specimen 17"']);
          expect(input.taxa).toHaveLength(calls === 1 ? 1 : 2);
          expect(input.taxa[0]).toEqual({
            label: "Quercus and Fagus assignments",
            scientificName: "Quercus robur",
            taxonId: { taxonomy: "local-taxonomy", id: "oak-17", release: "2026-01" },
          });
          if (calls === 2)
            expect(input.taxa[1]).toEqual({ taxonId: { taxonomy: "ncbi", id: "9606" } });
          expect(JSON.stringify(state)).not.toContain("private-target-metadata");
          expect(JSON.stringify(state)).not.toContain("private-id");
          expect(JSON.stringify(state)).not.toContain("abundance");
          return Effect.succeed({
            answers: Record.map(decisions, (question): DecisionModel.ProviderClassifyAnswer => {
              if (!Predicate.isTagged(question, "Classify"))
                throw new Error("Expected classification");
              expect(Record.keys(question.criteria)).toEqual([
                "sameTaxon",
                "withinTaxon",
                "noMatch",
                "undetermined",
              ]);
              return {
                _tag: "Classify",
                label: "undetermined",
                probabilities: { sameTaxon: 0, withinTaxon: 0, noMatch: 0, undetermined: 1 },
              };
            }),
            usage: { inputTokens: undefined, outputTokens: undefined },
          });
        },
      }),
    );
    return Effect.gen(function* () {
      for (const panel of [first, TaxonSet.union(first, second)]) {
        const result = yield* Taxonomy.classifyRecords([specimen], panel);
        expect(result.panel).toBe(panel);
        expect(result.records[0]?.record).toBe(specimen);
        const matches = result.records[0]?.taxa ?? [];
        expect(matches).toHaveLength(calls === 1 ? 1 : 2);
        expect(matches[0]?.taxon).toBe(first);
        expect(matches[0]?.taxon.record).toBe(source);
        expect(matches[0]?.record).toBe(specimen);
        if (calls === 2) {
          expect(matches[1]?.taxon).toBe(second);
          expect(matches[1]?.taxon.record).toBe(second.record);
        }
        for (const match of matches) {
          expect(match.judgment).toEqual({ _tag: "Undetermined" });
          expect(match.answer.probabilities).toEqual({
            sameTaxon: 0,
            withinTaxon: 0,
            noMatch: 0,
            undetermined: 1,
          });
        }
      }
      expect(calls).toBe(2);
    }).pipe(Effect.provide(layer));
  },
);
