import { expect, it } from "@effect/vitest";
import { Array, Effect, Layer, Option, Predicate, Record } from "effect";
import { AiError, DecisionModel } from "effect/ai";
import {
  AcceptancePolicy,
  RecordLabel,
  TaxonId,
  TaxonomicRecord,
  TaxonName,
  Taxonomy,
} from "../src/index.ts";

it.effect("reports matching taxa without guessing whether they are one or several", () => {
  const layer = Layer.effect(
    DecisionModel.DecisionModel,
    DecisionModel.make({
      decide: () =>
        Effect.succeed({
          answers: {
            comparison: {
              _tag: "Classify",
              label: "equalSingle",
              probabilities: {
                equalSingle: 0.45,
                equalMultiple: 0.45,
                properSubset: 0,
                properSuperset: 0,
                partialOverlap: 0,
                disjoint: 0,
                undetermined: 0.1,
                multipleLeft: 0,
                multipleRight: 0,
                multipleBoth: 0,
              },
            },
          },
          usage: { inputTokens: undefined, outputTokens: undefined },
        }),
    }),
  );
  return Effect.gen(function* () {
    expect(
      yield* Taxonomy.sameSpecies(
        RecordLabel.make("Left assignment"),
        RecordLabel.make("Right assignment"),
      ),
    ).toEqual({ _tag: "SameTaxaAtRank", rank: "species" });
  }).pipe(Effect.provide(layer));
});

it.effect("compares the original record descriptions at the requested rank", () => {
  const first = RecordLabel.make("Voucher A17 | Quercus robur");
  const second = RecordLabel.make("Voucher B42 | Quercus robur");
  const modelLayer = Layer.effect(
    DecisionModel.DecisionModel,
    DecisionModel.make({
      decide: ({ state, decisions }) => {
        expect(state).toBeNull();
        expect(decisions.comparison).toMatchObject({
          _tag: "Classify",
          criteria: {
            equalSingle: expect.any(String),
            equalMultiple: expect.any(String),
            properSubset: expect.any(String),
            properSuperset: expect.any(String),
            partialOverlap: expect.any(String),
            disjoint: expect.any(String),
            undetermined: expect.any(String),
            multipleLeft: expect.any(String),
            multipleRight: expect.any(String),
            multipleBoth: expect.any(String),
          },
        });
        const question = Record.get(decisions, "comparison").pipe(Option.getOrThrow);
        if (!Predicate.isTagged(question, "Classify")) return Effect.die("Expected classification");
        expect(question.instructions).toContain("species rank");
        expect(question.instructions).toContain(
          'Left record:\nRecord label: "Voucher A17 | Quercus robur"',
        );
        expect(question.instructions).toContain(
          'Right record:\nRecord label: "Voucher B42 | Quercus robur"',
        );
        expect(question.instructions.split('"Voucher A17 | Quercus robur"')).toHaveLength(2);
        expect(question.instructions.split('"Voucher B42 | Quercus robur"')).toHaveLength(2);
        expect(Record.keys(decisions)).toEqual(["comparison"]);

        return Effect.succeed({
          answers: {
            comparison: {
              _tag: "Classify",
              label: "equalSingle",
              probabilities: {
                equalSingle: 0.97,
                equalMultiple: 0,
                properSubset: 0,
                properSuperset: 0,
                partialOverlap: 0,
                disjoint: 0.02,
                undetermined: 0.01,
                multipleLeft: 0,
                multipleRight: 0,
                multipleBoth: 0,
              },
            },
          },
          usage: { inputTokens: undefined, outputTokens: undefined },
        });
      },
    }),
  );

  return Effect.gen(function* () {
    const result = yield* Taxonomy.sameTaxonAtRank(first, second, "species");

    expect(result).toEqual({ _tag: "SameTaxonAtRank", rank: "species" });
  }).pipe(Effect.provide(modelLayer));
});

it.effect(
  "quotes multiline facts and keeps conflicting supplied fields together without changing records",
  () => {
    const taxonId = TaxonId.make({ taxonomy: "local\\taxonomy", id: 'id"17', release: "2026\n01" });
    const first = {
      ...TaxonomicRecord.make({
        label: RecordLabel.make('Voucher "A17"\nFagus sylvatica'),
        scientificName: TaxonName.make("Quercus robur"),
        taxonId,
      }),
      sampleId: "caller-only",
    };
    const second = TaxonomicRecord.make({ scientificName: TaxonName.make("Quercus petraea") });
    const original = { ...first };
    const modelLayer = Layer.effect(
      DecisionModel.DecisionModel,
      DecisionModel.make({
        decide: ({ state, decisions }) => {
          expect(state).toBeNull();
          expect(decisions.comparison).toMatchObject({
            instructions: expect.stringContaining(
              'Left record:\nRecord label: "Voucher \\"A17\\"\\nFagus sylvatica"\n' +
                'Scientific name: "Quercus robur"\nTaxonomy: "local\\\\taxonomy"\n' +
                'Taxon ID: "id\\"17"\nTaxonomy release: "2026\\n01"\n' +
                'Right record:\nScientific name: "Quercus petraea"',
            ),
          });
          expect(decisions.comparison).toMatchObject({
            instructions: expect.stringContaining("genus rank"),
          });
          const question = Record.get(decisions, "comparison").pipe(Option.getOrThrow);
          if (!Predicate.isTagged(question, "Classify"))
            return Effect.die("Expected classification");
          expect(question.instructions).not.toContain("caller-only");
          for (const field of [
            "Record label",
            "Scientific name",
            "Taxonomy",
            "Taxon ID",
            "Taxonomy release",
          ]) {
            expect(question.instructions.split(`${field}:`), field).toHaveLength(
              field === "Scientific name" ? 3 : 2,
            );
          }
          return Effect.succeed({
            answers: {
              comparison: {
                _tag: "Classify",
                label: "undetermined",
                probabilities: {
                  equalSingle: 0,
                  equalMultiple: 0,
                  properSubset: 0,
                  properSuperset: 0,
                  partialOverlap: 0,
                  disjoint: 0,
                  undetermined: 1,
                  multipleLeft: 0,
                  multipleRight: 0,
                  multipleBoth: 0,
                },
              },
            },
            usage: { inputTokens: undefined, outputTokens: undefined },
          });
        },
      }),
    );

    return Effect.gen(function* () {
      expect(yield* Taxonomy.sameGenus(first, second)).toEqual({
        _tag: "Undetermined",
        rank: "genus",
      });
      expect(first).toEqual(original);
      expect(first.taxonId).toBe(original.taxonId);
      expect(second).toEqual({ scientificName: "Quercus petraea" });
    }).pipe(Effect.provide(modelLayer));
  },
);

it.effect("validates the original rank and operands before provider transport", () => {
  let calls = 0;
  const modelLayer = Layer.effect(
    DecisionModel.DecisionModel,
    DecisionModel.make({
      decide: () => {
        calls += 1;
        return Effect.die("Invalid input must not reach transport");
      },
    }),
  );

  return Effect.gen(function* () {
    const label = RecordLabel.make("Voucher A17");
    const invalidRequests = [
      // @ts-expect-error Exercise an unsupported rank supplied by untyped callers.
      Taxonomy.sameTaxonAtRank(label, label, "strain"),
      // @ts-expect-error Exercise a blank label supplied by untyped callers.
      Taxonomy.sameSpecies("  ", label),
      // @ts-expect-error Exercise a record with no identifying fields.
      Taxonomy.sameSpecies(label, {}),
      // Identifier strings are checked at runtime, even with a valid label.
      Taxonomy.sameSpecies({ label, taxonId: { taxonomy: "ncbi", id: " " } }, label),
    ];
    for (const request of invalidRequests) {
      const error = yield* Effect.flip(request);
      expect(error.module).toBe("Taxonomy");
      expect(error.method).toBe("sameTaxonAtRank");
      expect(error.reason._tag).toBe("InvalidUserInputError");
    }
    expect(calls).toBe(0);
  }).pipe(Effect.provide(modelLayer));
});

it.effect("builds fresh direct context for repeated and interleaved executions", () => {
  const seen: string[] = [];
  const modelLayer = Layer.effect(
    DecisionModel.DecisionModel,
    DecisionModel.make({
      decide: ({ state, decisions }) => {
        expect(state).toBeNull();
        const question = Record.get(decisions, "comparison").pipe(Option.getOrThrow);
        if (!Predicate.isTagged(question, "Classify"))
          return Effect.die("Expected a classification");
        seen.push(question.instructions);
        return Effect.succeed({
          answers: {
            comparison: {
              _tag: "Classify",
              label: "equalSingle",
              probabilities: {
                equalSingle: 1,
                equalMultiple: 0,
                properSubset: 0,
                properSuperset: 0,
                partialOverlap: 0,
                disjoint: 0,
                undetermined: 0,
                multipleLeft: 0,
                multipleRight: 0,
                multipleBoth: 0,
              },
            },
          },
          usage: { inputTokens: undefined, outputTokens: undefined },
        });
      },
    }),
  );
  const first = Taxonomy.sameSpecies(RecordLabel.make("A"), RecordLabel.make("B"));
  const second = Taxonomy.sameFamily(RecordLabel.make("C"), RecordLabel.make("D"));

  return Effect.gen(function* () {
    yield* Effect.all([first, second], { concurrency: 2 });
    yield* first;
    expect(seen).toHaveLength(3);
    const species = Array.filter(seen, (text) => text.includes('Left record:\nRecord label: "A"'));
    const family = Array.filter(seen, (text) => text.includes('Left record:\nRecord label: "C"'));
    expect(species).toHaveLength(2);
    expect(family).toHaveLength(1);
    for (const text of species) {
      expect(text).toContain("species rank");
      expect(text).toContain('Right record:\nRecord label: "B"');
    }
    for (const text of family) {
      expect(text).toContain("family rank");
      expect(text).toContain('Right record:\nRecord label: "D"');
    }
  }).pipe(Effect.provide(modelLayer));
});

const classificationLayer = (answer: DecisionModel.ProviderClassifyAnswer) =>
  Layer.effect(
    DecisionModel.DecisionModel,
    DecisionModel.make({
      decide: () =>
        Effect.succeed({
          answers: {
            comparison: {
              ...answer,
              probabilities: {
                equalSingle: 0,
                equalMultiple: 0,
                properSubset: 0,
                properSuperset: 0,
                partialOverlap: 0,
                disjoint: 0,
                undetermined: 0,
                multipleLeft: 0,
                multipleRight: 0,
                multipleBoth: 0,
                ...answer.probabilities,
              },
            },
          },
          usage: { inputTokens: undefined, outputTokens: undefined },
        }),
    }),
  );

it.effect.each([
  ["decimal terms", { equalSingle: 0.1, equalMultiple: 0.7, properSubset: 0.2 }],
  ["scientific notation", { equalSingle: 1e-7, equalMultiple: 0.7999999, properSubset: 0.2 }],
] as const)("accepts grouped support at its inclusive boundary: %s", ([_case, probabilities]) =>
  Effect.gen(function* () {
    expect(
      yield* Taxonomy.sameSpecies(RecordLabel.make("A"), RecordLabel.make("B"), {
        policy: AcceptancePolicy.make({ minimumSupport: 0.8, minimumMargin: 0 }),
      }),
    ).toEqual({ _tag: "SameTaxaAtRank", rank: "species" });
  }).pipe(
    Effect.provide(
      classificationLayer({
        _tag: "Classify",
        label: "equalMultiple",
        probabilities,
      }),
    ),
  ),
);

it.effect.each([
  { label: "equalSingle", expected: "SameTaxonAtRank" },
  { label: "equalMultiple", expected: "SameMultipleTaxaAtRank" },
  { label: "properSubset", expected: "LeftTaxaWithinRightAtRank" },
  { label: "properSuperset", expected: "RightTaxaWithinLeftAtRank" },
  { label: "partialOverlap", expected: "PartlySharedTaxaAtRank" },
  { label: "disjoint", expected: "NoSharedTaxaAtRank" },
])("maps unit support for $label to $expected", ({ label, expected }) =>
  Effect.gen(function* () {
    expect(
      yield* Taxonomy.sameSpecies(
        RecordLabel.make("Left assignment"),
        RecordLabel.make("Right assignment"),
      ),
    ).toEqual({ _tag: expected, rank: "species" });
  }).pipe(
    Effect.provide(
      classificationLayer({
        _tag: "Classify",
        label,
        probabilities: { [label]: 1 },
      }),
    ),
  ),
);

it.effect.each([
  {
    behavior: "reports unequal sets without inventing a detailed relation",
    label: "properSubset",
    probabilities: {
      equalSingle: 0.1,
      properSubset: 0.35,
      properSuperset: 0.3,
      partialOverlap: 0.15,
      disjoint: 0.1,
    },
    policy: AcceptancePolicy.make({ minimumSupport: 0.5, minimumMargin: 0 }),
    expected: "DifferentTaxaAtRank",
  },
  {
    behavior: "gates a fine leader on a tied parent comparison first",
    label: "equalSingle",
    probabilities: { equalSingle: 0.5, properSubset: 0.25, disjoint: 0.25 },
    policy: AcceptancePolicy.make({ minimumSupport: 0.5, minimumMargin: 0 }),
    expected: "Undetermined",
  },
  {
    behavior: "applies margin against grouped inequality before refining equality",
    label: "equalSingle",
    probabilities: { equalSingle: 0.6, properSubset: 0.2, disjoint: 0.2 },
    policy: AcceptancePolicy.make({ minimumSupport: 0.5, minimumMargin: 0.3 }),
    expected: "Undetermined",
  },
  {
    behavior: "does not renormalize away uncertainty or clarification support",
    label: "equalSingle",
    probabilities: { equalSingle: 0.2, equalMultiple: 0.2, undetermined: 0.3, multipleLeft: 0.3 },
    policy: AcceptancePolicy.make({ minimumSupport: 0.5, minimumMargin: 0 }),
    expected: "Undetermined",
  },
  {
    behavior: "keeps uncertainty and clarification as separate margin competitors",
    label: "equalSingle",
    probabilities: { equalSingle: 0.3, equalMultiple: 0.3, undetermined: 0.2, multipleLeft: 0.2 },
    policy: AcceptancePolicy.make({ minimumSupport: 0.5, minimumMargin: 0.3 }),
    expected: "SameTaxaAtRank",
  },
])("$behavior", ({ label, probabilities, policy, expected }) =>
  Effect.gen(function* () {
    expect(
      yield* Taxonomy.sameSpecies(
        RecordLabel.make("Left assignment"),
        RecordLabel.make("Right assignment"),
        { policy },
      ),
    ).toEqual({ _tag: expected, rank: "species" });
  }).pipe(Effect.provide(classificationLayer({ _tag: "Classify", label, probabilities }))),
);

it.effect("abstains when the leading group has less than half the support", () =>
  Effect.gen(function* () {
    const result = yield* Taxonomy.sameTaxonAtRank(
      RecordLabel.make("Voucher A17"),
      RecordLabel.make("Voucher B42"),
      "species",
    );

    expect(result).toEqual({ _tag: "Undetermined", rank: "species" });
  }).pipe(
    Effect.provide(
      classificationLayer({
        _tag: "Classify",
        label: "equalSingle",
        probabilities: { equalSingle: 0.36, disjoint: 0.34, undetermined: 0.3 },
      }),
    ),
  ),
);

it.effect("abstains rather than breaking a tied distribution", () =>
  Effect.gen(function* () {
    const result = yield* Taxonomy.sameTaxonAtRank(
      RecordLabel.make("Voucher A17"),
      RecordLabel.make("Voucher B42"),
      "species",
    );

    expect(result).toEqual({ _tag: "Undetermined", rank: "species" });
  }).pipe(
    Effect.provide(
      classificationLayer({
        _tag: "Classify",
        label: "equalSingle",
        probabilities: { equalSingle: 0.5, disjoint: 0.5, undetermined: 0 },
      }),
    ),
  ),
);

it.effect("species convenience forwards a caller's minimum-margin requirement", () =>
  Effect.gen(function* () {
    const policy = AcceptancePolicy.make({ minimumSupport: 0.5, minimumMargin: 0.6 });
    const result = yield* Taxonomy.sameSpecies(
      RecordLabel.make("Voucher A17"),
      RecordLabel.make("Voucher B42"),
      { policy },
    );

    expect(result).toEqual({ _tag: "Undetermined", rank: "species" });
  }).pipe(
    Effect.provide(
      classificationLayer({
        _tag: "Classify",
        label: "equalSingle",
        probabilities: { equalSingle: 0.75, disjoint: 0.25, undetermined: 0 },
      }),
    ),
  ),
);

it.effect.each([
  { rank: "domain", compare: Taxonomy.sameDomain },
  { rank: "kingdom", compare: Taxonomy.sameKingdom },
  { rank: "phylum", compare: Taxonomy.samePhylum },
  { rank: "class", compare: Taxonomy.sameClass },
  { rank: "order", compare: Taxonomy.sameOrder },
  { rank: "family", compare: Taxonomy.sameFamily },
  { rank: "genus", compare: Taxonomy.sameGenus },
])("forwards policy at the $rank convenience's requested rank", ({ rank, compare }) =>
  Effect.gen(function* () {
    expect(
      yield* compare(RecordLabel.make("Voucher A17"), RecordLabel.make("Voucher B42")),
    ).toEqual({
      _tag: "NoSharedTaxaAtRank",
      rank,
    });
    const result = yield* compare(
      RecordLabel.make("Voucher A17"),
      RecordLabel.make("Voucher B42"),
      {
        policy: AcceptancePolicy.make({ minimumSupport: 0.99, minimumMargin: 0 }),
      },
    );

    expect(result).toEqual({ _tag: "Undetermined", rank });
  }).pipe(
    Effect.provide(
      classificationLayer({
        _tag: "Classify",
        label: "disjoint",
        probabilities: { equalSingle: 0.02, disjoint: 0.97, undetermined: 0.01 },
      }),
    ),
  ),
);

it.effect.each([
  {
    behavior: "admits a narrow default win",
    label: "equalSingle",
    probabilities: { equalSingle: 0.51, disjoint: 0.49, undetermined: 0 },
    expected: "SameTaxonAtRank",
  },
  {
    behavior: "includes half-support when the equality group is the unique leader",
    label: "equalSingle",
    probabilities: { equalSingle: 0.5, disjoint: 0.25, undetermined: 0.25 },
    expected: "SameTaxonAtRank",
  },
  {
    behavior: "uses leading equality despite a selected uncertainty label",
    label: "undetermined",
    probabilities: { equalSingle: 0.94, disjoint: 0.03, undetermined: 0.03 },
    expected: "SameTaxonAtRank",
  },
  {
    behavior: "replaces a nonleading selection with the distribution leader",
    label: "disjoint",
    probabilities: { equalSingle: 0.94, disjoint: 0.03, undetermined: 0.03 },
    expected: "SameTaxonAtRank",
  },
])("$behavior", ({ label, probabilities, expected }) =>
  Effect.gen(function* () {
    const result = yield* Taxonomy.sameSpecies(
      RecordLabel.make("Quercus robur"),
      RecordLabel.make("Quercus robur"),
    );

    expect(result).toEqual({ _tag: expected, rank: "species" });
  }).pipe(Effect.provide(classificationLayer({ _tag: "Classify", label, probabilities }))),
);

it.effect.each([
  {
    label: "equalSingle",
    probabilities: { equalSingle: 0.5, disjoint: 0.5, undetermined: 0 },
    expected: "Undetermined",
  },
  {
    label: "equalSingle",
    probabilities: { equalSingle: 0.36, disjoint: 0.37, undetermined: 0.27 },
    expected: "NoSharedTaxaAtRank",
  },
])(
  "zero thresholds use the unique distribution leader, not the selected label %j",
  ({ label, probabilities, expected }) =>
    Effect.gen(function* () {
      const policy = AcceptancePolicy.make({ minimumSupport: 0, minimumMargin: 0 });
      const result = yield* Taxonomy.sameSpecies(
        RecordLabel.make("Voucher A17"),
        RecordLabel.make("Voucher B42"),
        { policy },
      );

      expect(result).toEqual({ _tag: expected, rank: "species" });
    }).pipe(Effect.provide(classificationLayer({ _tag: "Classify", label, probabilities }))),
);

it.effect.each([
  { support: 0.75, alternative: 0.25, minimumMargin: 0.5 },
  { support: 0.6, alternative: 0.4, minimumMargin: 0.2 },
])(
  "includes support $support and margin $minimumMargin boundaries",
  ({ support, alternative, minimumMargin }) =>
    Effect.gen(function* () {
      const policy = AcceptancePolicy.make({ minimumSupport: support, minimumMargin });
      const result = yield* Taxonomy.sameSpecies(
        RecordLabel.make("Voucher A17"),
        RecordLabel.make("Voucher B42"),
        { policy },
      );

      expect(result).toEqual({ _tag: "SameTaxonAtRank", rank: "species" });
    }).pipe(
      Effect.provide(
        classificationLayer({
          _tag: "Classify",
          label: "equalSingle",
          probabilities: { equalSingle: support, disjoint: alternative, undetermined: 0 },
        }),
      ),
    ),
);

it.effect.each([
  {
    behavior: "does not round away an unmet support threshold",
    minimumSupport: 0.6000000000000001,
    minimumMargin: 0.2,
  },
  {
    behavior: "does not accept a margin shortfall beyond machine precision",
    minimumSupport: 0.6,
    minimumMargin: 0.200000000000001,
  },
])("$behavior", ({ minimumSupport, minimumMargin }) =>
  Effect.gen(function* () {
    const policy = AcceptancePolicy.make({ minimumSupport, minimumMargin });
    const result = yield* Taxonomy.sameSpecies(
      RecordLabel.make("Voucher A17"),
      RecordLabel.make("Voucher B42"),
      { policy },
    );

    expect(result).toEqual({ _tag: "Undetermined", rank: "species" });
  }).pipe(
    Effect.provide(
      classificationLayer({
        _tag: "Classify",
        label: "equalSingle",
        probabilities: { equalSingle: 0.6, disjoint: 0.4, undetermined: 0 },
      }),
    ),
  ),
);

it.effect("does not use provider-defined confidence as an acceptance gate", () =>
  Effect.gen(function* () {
    const result = yield* Taxonomy.sameSpecies(
      RecordLabel.make("Voucher A17"),
      RecordLabel.make("Voucher B42"),
    );

    expect(result).toEqual({ _tag: "SameTaxonAtRank", rank: "species" });
  }).pipe(
    Effect.provide(
      classificationLayer({
        _tag: "Classify",
        label: "equalSingle",
        confidence: 0,
        probabilities: { equalSingle: 0.97, disjoint: 0.02, undetermined: 0.01 },
      }),
    ),
  ),
);

it.effect("passes all supplied metadata to the model without adding missing fields", () => {
  const first = TaxonomicRecord.make({
    label: RecordLabel.make("Voucher A17"),
    scientificName: TaxonName.make("Quercus robur"),
    taxonId: TaxonId.make({ taxonomy: "example-taxonomy", id: "oak-17", release: "2026-01" }),
  });
  const second = TaxonomicRecord.make({
    taxonId: TaxonId.make({ taxonomy: "example-taxonomy", id: "oak-18" }),
  });
  const modelLayer = Layer.effect(
    DecisionModel.DecisionModel,
    DecisionModel.make({
      decide: ({ state, decisions }) => {
        expect(state).toBeNull();
        expect(decisions.comparison).toMatchObject({
          instructions: expect.stringContaining(
            'Left record:\nRecord label: "Voucher A17"\n' +
              'Scientific name: "Quercus robur"\nTaxonomy: "example-taxonomy"\n' +
              'Taxon ID: "oak-17"\nTaxonomy release: "2026-01"\n' +
              'Right record:\nTaxonomy: "example-taxonomy"\nTaxon ID: "oak-18"',
          ),
        });
        const question = Record.get(decisions, "comparison").pipe(Option.getOrThrow);
        if (!Predicate.isTagged(question, "Classify")) return Effect.die("Expected classification");
        expect(question.instructions).toContain("family rank");
        expect(question.instructions.split("Taxonomy release:")).toHaveLength(2);
        expect(question.instructions.split("Record label:")).toHaveLength(2);
        expect(question.instructions.split("Scientific name:")).toHaveLength(2);

        return Effect.succeed({
          answers: {
            comparison: {
              _tag: "Classify",
              label: "undetermined",
              probabilities: {
                equalSingle: 0,
                equalMultiple: 0,
                properSubset: 0,
                properSuperset: 0,
                partialOverlap: 0,
                disjoint: 0,
                undetermined: 1,
                multipleLeft: 0,
                multipleRight: 0,
                multipleBoth: 0,
              },
            },
          },
          usage: { inputTokens: undefined, outputTokens: undefined },
        });
      },
    }),
  );

  return Effect.gen(function* () {
    const result = yield* Taxonomy.sameFamily(first, second);

    expect(result).toEqual({ _tag: "Undetermined", rank: "family" });
  }).pipe(Effect.provide(modelLayer));
});

it.effect("preserves a provider failure instead of reporting semantic uncertainty", () => {
  const failure = AiError.make({
    module: "TestProvider",
    method: "decide",
    reason: new AiError.UnknownError({ description: "Provider unavailable" }),
  });
  const modelLayer = Layer.effect(
    DecisionModel.DecisionModel,
    DecisionModel.make({ decide: () => Effect.fail(failure) }),
  );

  return Effect.gen(function* () {
    const error = yield* Effect.flip(
      Taxonomy.sameSpecies(RecordLabel.make("Voucher A17"), RecordLabel.make("Voucher B42")),
    );

    expect(error).toBe(failure);
  }).pipe(Effect.provide(modelLayer));
});

it.effect("keeps invalid provider output in the error channel", () =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(
      Taxonomy.sameSpecies(RecordLabel.make("Voucher A17"), RecordLabel.make("Voucher B42")),
    );

    expect(error.reason._tag).toBe("InvalidOutputError");
  }).pipe(
    Effect.provide(
      classificationLayer({
        _tag: "Classify",
        label: "equalSingle",
        probabilities: { equalSingle: 0.9, disjoint: 0.9, undetermined: 0 },
      }),
    ),
  ),
);

it.effect("reports a left-side diagnosis even when the other record is unidentified", () =>
  Effect.gen(function* () {
    const result = yield* Taxonomy.sameSpecies(
      RecordLabel.make("Pooled Quercus robur and Quercus petraea specimens"),
      RecordLabel.make("Unidentified voucher A17"),
    );

    expect(result).toEqual({ _tag: "MultipleTaxaAtRank", rank: "species", side: "left" });
  }).pipe(
    Effect.provide(
      classificationLayer({
        _tag: "Classify",
        label: "multipleLeft",
        probabilities: {
          equalSingle: 0,
          disjoint: 0,
          undetermined: 0.05,
          multipleLeft: 0.7,
          multipleRight: 0.05,
          multipleBoth: 0.2,
        },
      }),
    ),
  ),
);

it.effect.each([
  { label: "multipleRight", side: "right" },
  { label: "multipleBoth", side: "both" },
])("maps an accepted $label diagnosis to $side at the requested rank", ({ label, side }) =>
  Effect.gen(function* () {
    const result = yield* Taxonomy.sameGenus(
      RecordLabel.make("Voucher A17"),
      RecordLabel.make("Voucher B42"),
    );

    expect(result).toEqual({ _tag: "MultipleTaxaAtRank", rank: "genus", side });
  }).pipe(
    Effect.provide(
      classificationLayer({
        _tag: "Classify",
        label,
        probabilities: { equalSingle: 0, disjoint: 0, undetermined: 0, [label]: 1 },
      }),
    ),
  ),
);

it.effect.each([
  {
    behavior: "does not combine support for different diagnosis sides",
    expected: { _tag: "Undetermined", rank: "species" },
    label: "multipleLeft",
    probabilities: {
      equalSingle: 0,
      disjoint: 0,
      undetermined: 0.03,
      multipleLeft: 0.49,
      multipleRight: 0,
      multipleBoth: 0.48,
    },
  },
  {
    behavior: "abstains when diagnosis choices tie",
    expected: { _tag: "Undetermined", rank: "species" },
    label: "multipleLeft",
    probabilities: {
      equalSingle: 0,
      disjoint: 0,
      undetermined: 0,
      multipleLeft: 0.5,
      multipleRight: 0,
      multipleBoth: 0.5,
    },
  },
  {
    behavior: "uses leading diagnosis support despite a selected uncertainty label",
    expected: { _tag: "MultipleTaxaAtRank", rank: "species", side: "left" },
    label: "undetermined",
    probabilities: {
      equalSingle: 0,
      disjoint: 0,
      undetermined: 0.1,
      multipleLeft: 0.9,
      multipleRight: 0,
      multipleBoth: 0,
    },
  },
  {
    behavior: "abstains when a same-taxon selection ties a diagnosis",
    expected: { _tag: "Undetermined", rank: "species" },
    label: "equalSingle",
    probabilities: {
      equalSingle: 0.5,
      disjoint: 0,
      undetermined: 0,
      multipleLeft: 0.5,
      multipleRight: 0,
      multipleBoth: 0,
    },
  },
])("$behavior", ({ label, probabilities, expected }) =>
  Effect.gen(function* () {
    const result = yield* Taxonomy.sameSpecies(
      RecordLabel.make("Voucher A17"),
      RecordLabel.make("Voucher B42"),
    );

    expect(result).toEqual(expected);
  }).pipe(Effect.provide(classificationLayer({ _tag: "Classify", label, probabilities }))),
);

it.effect("uses the leading diagnosis side even when another side was selected", () =>
  Effect.gen(function* () {
    const policy = AcceptancePolicy.make({ minimumSupport: 0, minimumMargin: 0 });
    const result = yield* Taxonomy.sameSpecies(
      RecordLabel.make("Voucher A17"),
      RecordLabel.make("Voucher B42"),
      { policy },
    );

    expect(result).toEqual({ _tag: "MultipleTaxaAtRank", rank: "species", side: "both" });
  }).pipe(
    Effect.provide(
      classificationLayer({
        _tag: "Classify",
        label: "multipleLeft",
        probabilities: {
          equalSingle: 0,
          disjoint: 0,
          undetermined: 0.1,
          multipleLeft: 0.3,
          multipleRight: 0,
          multipleBoth: 0.6,
        },
      }),
    ),
  ),
);

it.effect.each([
  { label: "multipleLeft", minimumMargin: 0.5 },
  { label: "equalSingle", minimumMargin: 0.5 },
])(
  "uses competing diagnoses when applying the caller's margin to $label",
  ({ label, minimumMargin }) =>
    Effect.gen(function* () {
      const policy = AcceptancePolicy.make({ minimumSupport: 0.5, minimumMargin });
      const result = yield* Taxonomy.sameSpecies(
        RecordLabel.make("Voucher A17"),
        RecordLabel.make("Voucher B42"),
        { policy },
      );

      expect(result).toEqual({ _tag: "Undetermined", rank: "species" });
    }).pipe(
      Effect.provide(
        classificationLayer({
          _tag: "Classify",
          label,
          probabilities: {
            equalSingle: 0,
            disjoint: 0.05,
            undetermined: 0.05,
            multipleLeft: 0,
            multipleRight: 0,
            multipleBoth: 0.3,
            [label]: 0.6,
          },
        }),
      ),
    ),
);
