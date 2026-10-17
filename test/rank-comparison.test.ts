import { expect, it } from "@effect/vitest";
import { Array, Effect, Layer, Option, Predicate, Record } from "effect";
import { AiError, DecisionModel } from "effect/ai";
import {
  RankComparisonPolicy,
  RecordLabel,
  TaxonId,
  TaxonomicRecord,
  TaxonName,
  Taxonomy,
} from "../src/index.ts";

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
            same: expect.any(String),
            different: expect.any(String),
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
              label: "same",
              probabilities: {
                same: 0.97,
                different: 0.02,
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
                  same: 0,
                  different: 0,
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
              label: "same",
              probabilities: {
                same: 1,
                different: 0,
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

it.effect("abstains when the selected label has less than half the support", () =>
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
        label: "same",
        probabilities: { same: 0.36, different: 0.34, undetermined: 0.3 },
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
        label: "same",
        probabilities: { same: 0.5, different: 0.5, undetermined: 0 },
      }),
    ),
  ),
);

it.effect("species convenience forwards a caller's minimum-margin requirement", () =>
  Effect.gen(function* () {
    const policy = RankComparisonPolicy.make({ minimumSupport: 0.5, minimumMargin: 0.6 });
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
        label: "same",
        probabilities: { same: 0.75, different: 0.25, undetermined: 0 },
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
      _tag: "DifferentTaxaAtRank",
      rank,
    });
    const result = yield* compare(
      RecordLabel.make("Voucher A17"),
      RecordLabel.make("Voucher B42"),
      {
        policy: RankComparisonPolicy.make({ minimumSupport: 0.99, minimumMargin: 0 }),
      },
    );

    expect(result).toEqual({ _tag: "Undetermined", rank });
  }).pipe(
    Effect.provide(
      classificationLayer({
        _tag: "Classify",
        label: "different",
        probabilities: { same: 0.02, different: 0.97, undetermined: 0.01 },
      }),
    ),
  ),
);

it.effect.each([
  {
    behavior: "admits a narrow default win",
    label: "same",
    probabilities: { same: 0.51, different: 0.49, undetermined: 0 },
    expected: "SameTaxonAtRank",
  },
  {
    behavior: "includes half-support when the selected label is the unique leader",
    label: "same",
    probabilities: { same: 0.5, different: 0.25, undetermined: 0.25 },
    expected: "SameTaxonAtRank",
  },
  {
    behavior: "preserves explicit uncertainty despite a different distribution leader",
    label: "undetermined",
    probabilities: { same: 0.94, different: 0.03, undetermined: 0.03 },
    expected: "Undetermined",
  },
  {
    behavior: "does not replace a nonleading selection with the distribution leader",
    label: "different",
    probabilities: { same: 0.94, different: 0.03, undetermined: 0.03 },
    expected: "Undetermined",
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
  { label: "same", probabilities: { same: 0.5, different: 0.5, undetermined: 0 } },
  { label: "same", probabilities: { same: 0.36, different: 0.37, undetermined: 0.27 } },
])("zero thresholds do not accept ties or nonleaders %j", ({ label, probabilities }) =>
  Effect.gen(function* () {
    const policy = RankComparisonPolicy.make({ minimumSupport: 0, minimumMargin: 0 });
    const result = yield* Taxonomy.sameSpecies(
      RecordLabel.make("Voucher A17"),
      RecordLabel.make("Voucher B42"),
      { policy },
    );

    expect(result).toEqual({ _tag: "Undetermined", rank: "species" });
  }).pipe(Effect.provide(classificationLayer({ _tag: "Classify", label, probabilities }))),
);

it.effect.each([
  { support: 0.75, alternative: 0.25, minimumMargin: 0.5 },
  { support: 0.6, alternative: 0.4, minimumMargin: 0.2 },
])(
  "includes support $support and margin $minimumMargin boundaries",
  ({ support, alternative, minimumMargin }) =>
    Effect.gen(function* () {
      const policy = RankComparisonPolicy.make({ minimumSupport: support, minimumMargin });
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
          label: "same",
          probabilities: { same: support, different: alternative, undetermined: 0 },
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
    const policy = RankComparisonPolicy.make({ minimumSupport, minimumMargin });
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
        label: "same",
        probabilities: { same: 0.6, different: 0.4, undetermined: 0 },
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
        label: "same",
        confidence: 0,
        probabilities: { same: 0.97, different: 0.02, undetermined: 0.01 },
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
                same: 0,
                different: 0,
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
        label: "same",
        probabilities: { same: 0.9, different: 0.9, undetermined: 0 },
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
          same: 0,
          different: 0,
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
        probabilities: { same: 0, different: 0, undetermined: 0, [label]: 1 },
      }),
    ),
  ),
);

it.effect.each([
  {
    behavior: "does not combine support for different diagnosis sides",
    label: "multipleLeft",
    probabilities: {
      same: 0,
      different: 0,
      undetermined: 0.03,
      multipleLeft: 0.49,
      multipleRight: 0,
      multipleBoth: 0.48,
    },
  },
  {
    behavior: "abstains when diagnosis choices tie",
    label: "multipleLeft",
    probabilities: {
      same: 0,
      different: 0,
      undetermined: 0,
      multipleLeft: 0.5,
      multipleRight: 0,
      multipleBoth: 0.5,
    },
  },
  {
    behavior: "preserves explicit uncertainty despite leading diagnosis support",
    label: "undetermined",
    probabilities: {
      same: 0,
      different: 0,
      undetermined: 0.1,
      multipleLeft: 0.9,
      multipleRight: 0,
      multipleBoth: 0,
    },
  },
  {
    behavior: "abstains when a same-taxon selection ties a diagnosis",
    label: "same",
    probabilities: {
      same: 0.5,
      different: 0,
      undetermined: 0,
      multipleLeft: 0.5,
      multipleRight: 0,
      multipleBoth: 0,
    },
  },
])("$behavior", ({ label, probabilities }) =>
  Effect.gen(function* () {
    const result = yield* Taxonomy.sameSpecies(
      RecordLabel.make("Voucher A17"),
      RecordLabel.make("Voucher B42"),
    );

    expect(result).toEqual({ _tag: "Undetermined", rank: "species" });
  }).pipe(Effect.provide(classificationLayer({ _tag: "Classify", label, probabilities }))),
);

it.effect("rejects a nonleading diagnosis even with zero thresholds", () =>
  Effect.gen(function* () {
    const policy = RankComparisonPolicy.make({ minimumSupport: 0, minimumMargin: 0 });
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
        label: "multipleLeft",
        probabilities: {
          same: 0,
          different: 0,
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
  { label: "same", minimumMargin: 0.5 },
])(
  "uses competing diagnoses when applying the caller's margin to $label",
  ({ label, minimumMargin }) =>
    Effect.gen(function* () {
      const policy = RankComparisonPolicy.make({ minimumSupport: 0.5, minimumMargin });
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
            same: 0,
            different: 0.05,
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
