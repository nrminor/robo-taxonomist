import { expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
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
      decide: ({ state }) => {
        expect(state).toEqual({ left: first, right: second, rank: "species" });

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

it.effect("uses the caller's acceptance policy instead of the default", () =>
  Effect.gen(function* () {
    const policy = RankComparisonPolicy.make({ minimumSupport: 0.95, minimumMargin: 0.25 });
    const result = yield* Taxonomy.sameTaxonAtRank(
      RecordLabel.make("Voucher A17"),
      RecordLabel.make("Voucher B42"),
      "species",
      { policy },
    );

    expect(result).toEqual({ _tag: "Undetermined", rank: "species" });
  }).pipe(
    Effect.provide(
      classificationLayer({
        _tag: "Classify",
        label: "same",
        probabilities: { same: 0.51, different: 0.49, undetermined: 0 },
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
])("compares at the $rank convenience's requested rank", ({ rank, compare }) =>
  Effect.gen(function* () {
    const result = yield* compare(RecordLabel.make("Voucher A17"), RecordLabel.make("Voucher B42"));

    expect(result).toEqual({ _tag: "DifferentTaxaAtRank", rank });
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
      decide: ({ state }) => {
        expect(state).toEqual({
          left: {
            label: "Voucher A17",
            scientificName: "Quercus robur",
            taxonId: { taxonomy: "example-taxonomy", id: "oak-17", release: "2026-01" },
          },
          right: { taxonId: { taxonomy: "example-taxonomy", id: "oak-18" } },
          rank: "family",
        });

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
