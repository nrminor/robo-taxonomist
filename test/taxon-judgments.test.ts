import { expect, it } from "@effect/vitest";
import {
  Array,
  Cause,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Predicate,
  Record,
  Schema,
  Struct,
  pipe,
} from "effect";
import { AiError, DecisionModel } from "effect/ai";
import {
  AcceptancePolicy,
  RecordLabel,
  TaxonId,
  TaxonomicRecord,
  TaxonName,
  Taxonomy,
  TaxonSet,
  type TaxonIdentityJudgment,
  type TaxonContainmentJudgment,
  type TaxonMembershipJudgment,
} from "../src/index.ts";

// Canned transport answers test library contracts, not biological accuracy.
const containmentProbabilities = {
  equal: 0,
  properSubset: 0,
  properSuperset: 0,
  partialOverlap: 0,
  disjoint: 0,
  bothEmpty: 0,
  leftEmpty: 0,
  rightEmpty: 0,
  undetermined: 0,
  multipleLeft: 0,
  multipleRight: 0,
  multipleBoth: 0,
};

it.effect("retains non-containment when the kind of non-containment is uncertain", () => {
  const layer = Layer.effect(
    DecisionModel.DecisionModel,
    DecisionModel.make({
      decide: () =>
        Effect.succeed({
          answers: {
            containment: {
              _tag: "Classify",
              label: "partialOverlap",
              probabilities: {
                equal: 0.1,
                properSubset: 0,
                properSuperset: 0,
                partialOverlap: 0.45,
                disjoint: 0.4,
                bothEmpty: 0,
                leftEmpty: 0,
                rightEmpty: 0,
                undetermined: 0.05,
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
      yield* Taxonomy.taxonWithin(
        TaxonName.make("Quercus robur and Acer saccharum"),
        TaxonName.make("Quercus"),
      ),
    ).toEqual({ _tag: "NotContained" });
  }).pipe(Effect.provide(layer));
});

it.effect.each(["left", "right"] as const)(
  "preserves asymmetric escaped identity and %s diagnosis",
  (side) => {
    const left = TaxonName.make('Oak\n"A"');
    const right = TaxonName.make("Beech\\B");
    const label = side === "left" ? "multipleLeft" : "multipleRight";
    const layer = Layer.effect(
      DecisionModel.DecisionModel,
      DecisionModel.make({
        decide: ({ state, decisions }) => {
          expect(state).toBeNull();
          expect(Record.keys(decisions)).toEqual(["identity"]);
          expect(decisions.identity).toMatchObject({
            _tag: "Classify",
            instructions: expect.stringContaining(
              'Left taxon:\nScientific name: "Oak\\n\\\"A\\\""\nRight taxon:\nScientific name: "Beech\\\\B"',
            ),
            criteria: {
              same: expect.any(String),
            },
          });
          return Effect.succeed({
            answers: {
              identity: {
                _tag: "Classify",
                label,
                probabilities: {
                  same: 0,
                  different: 0,
                  undetermined: 0,
                  multipleLeft: 0,
                  multipleRight: 0,
                  multipleBoth: 0,
                  [label]: 1,
                },
              },
            },
            usage: { inputTokens: undefined, outputTokens: undefined },
          });
        },
      }),
    );
    return Effect.gen(function* () {
      expect(yield* Taxonomy.sameTaxon(left, right)).toEqual({ _tag: "MultipleTaxa", side });
    }).pipe(Effect.provide(layer));
  },
);

it.effect("asks one identity question with quoted names and null state", () => {
  let calls = 0;
  const layer = Layer.effect(
    DecisionModel.DecisionModel,
    DecisionModel.make({
      decide: ({ state, decisions }) => {
        calls++;
        expect(state).toBeNull();
        expect(Record.keys(decisions)).toEqual(["identity"]);
        expect(decisions.identity).toMatchObject({
          _tag: "Classify",
          instructions: expect.stringContaining(
            'Left taxon:\nScientific name: "Oak\\n\\\"A\\\""\nRight taxon:\nScientific name: "Oak\\n\\\"A\\\""',
          ),
        });
        return Effect.succeed({
          answers: {
            identity: {
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
  return Effect.gen(function* () {
    const name = TaxonName.make('Oak\n"A"');
    expect(yield* Taxonomy.sameTaxon(name, name)).toEqual({ _tag: "SameTaxon" });
    expect(calls).toBe(1);
  }).pipe(Effect.provide(layer));
});

it.effect.each([
  ["equal", { _tag: "Contained" }],
  ["properSubset", { _tag: "Contained" }],
  ["properSuperset", { _tag: "PartlyContained" }],
  ["partialOverlap", { _tag: "PartlyContained" }],
  ["disjoint", { _tag: "Disjoint" }],
  ["bothEmpty", { _tag: "Contained" }],
  ["leftEmpty", { _tag: "Contained" }],
  ["rightEmpty", { _tag: "Disjoint" }],
  ["multipleLeft", { _tag: "MultipleTaxa", side: "left" }],
  ["multipleRight", { _tag: "MultipleTaxa", side: "right" }],
  ["multipleBoth", { _tag: "MultipleTaxa", side: "both" }],
  ["undetermined", { _tag: "Undetermined" }],
] as const)("maps containment fixture %s to its original side", ([label, expected]) =>
  Effect.gen(function* () {
    expect(yield* Taxonomy.taxonWithin(TaxonName.make("inner"), TaxonName.make("outer"))).toEqual(
      expected,
    );
  }).pipe(
    Effect.provide(
      scalarLayer("containment", {
        _tag: "Classify",
        label,
        probabilities: {
          ...containmentProbabilities,
          [label]: 1,
        },
      }),
    ),
  ),
);

it.effect("uses projected containment support instead of a nonleading fine selection", () =>
  Effect.gen(function* () {
    expect(
      yield* Taxonomy.taxonWithin(TaxonName.make("A"), TaxonName.make("B"), {
        policy: AcceptancePolicy.make({ minimumSupport: 0, minimumMargin: 0 }),
      }),
    ).toEqual({ _tag: "Contained" });
  }).pipe(
    Effect.provide(
      scalarLayer("containment", {
        _tag: "Classify",
        label: "disjoint",
        probabilities: {
          ...containmentProbabilities,
          equal: 0.6,
          disjoint: 0.4,
        },
      }),
    ),
  ),
);

it.effect.each([
  ["accepts relaxed thresholds", 0, 0, "Contained"],
  ["rejects insufficient support", 0.875, 0, "Undetermined"],
  ["rejects insufficient margin", 0, 0.625, "Undetermined"],
] as const)("threads containment policy: %s", ([_case, minimumSupport, minimumMargin, tag]) =>
  Effect.gen(function* () {
    expect(
      yield* Taxonomy.taxonWithin(TaxonName.make("A"), TaxonName.make("B"), {
        policy: AcceptancePolicy.make({ minimumSupport, minimumMargin }),
      }),
    ).toEqual({ _tag: tag });
  }).pipe(
    Effect.provide(
      scalarLayer("containment", {
        _tag: "Classify",
        label: "equal",
        probabilities: {
          ...containmentProbabilities,
          equal: 0.75,
          disjoint: 0.25,
        },
      }),
    ),
  ),
);

it.effect.each([
  ["notMember", { _tag: "NotMember" }],
  ["mixed", { _tag: "MixedMembership" }],
  ["undetermined", { _tag: "Undetermined" }],
  [
    "multipleTarget0",
    { _tag: "MultipleTaxaInTarget", target: TaxonSet.of(TaxonName.make("A and B")) },
  ],
] as const)("maps whole-record membership fixture %s", ([label, expected]) =>
  Effect.gen(function* () {
    const result = yield* Taxonomy.recordBelongsTo(
      RecordLabel.make("Pooled subjects"),
      TaxonName.make("A and B"),
    );
    expect(result).toEqual(expected);
  }).pipe(
    Effect.provide(
      scalarLayer("record0", {
        _tag: "Classify",
        label,
        probabilities: {
          member: 0,
          notMember: 0,
          mixed: 0,
          undetermined: 0,
          multipleTarget0: 0,
          [label]: 1,
        },
      }),
    ),
  ),
);

it.effect(
  "enumerates unique target nodes in DFS order and returns the original selected node",
  () => {
    const first = TaxonName.make('A "quoted"');
    const second = TaxonName.make("B");
    const third = TaxonName.make("b");
    const a = TaxonSet.of(first);
    const duplicate = TaxonSet.of(first);
    const last = TaxonSet.of(third);
    const target = TaxonSet.difference(
      TaxonSet.union(a, TaxonSet.intersection(TaxonSet.of(second), a)),
      TaxonSet.union(duplicate, last),
    );
    const layer = Layer.effect(
      DecisionModel.DecisionModel,
      DecisionModel.make({
        decide: ({ state, decisions }) => {
          expect(state).toEqual({
            nodes: [
              { _tag: "Difference", left: 1, right: 2 },
              { _tag: "Union", operands: [3, 4] },
              { _tag: "Union", operands: [5, 6] },
              { _tag: "Taxon", record: { scientificName: 'A "quoted"' } },
              { _tag: "Intersection", operands: [7, 3] },
              { _tag: "Taxon", record: { scientificName: 'A "quoted"' } },
              { _tag: "Taxon", record: { scientificName: "b" } },
              { _tag: "Taxon", record: { scientificName: "B" } },
            ],
            target: 0,
          });
          expect(decisions.record0).toMatchObject({
            criteria: {
              multipleTarget0: expect.stringContaining("Target taxon node 3 "),
              multipleTarget1: expect.stringContaining("Target taxon node 7 "),
              multipleTarget2: expect.stringContaining("Target taxon node 5 "),
              multipleTarget3: expect.stringContaining("Target taxon node 6 "),
            },
          });
          const question = Record.get(decisions, "record0").pipe(Option.getOrThrow);
          if (!Predicate.isTagged(question, "Classify"))
            return Effect.die("Expected classification");
          expect(Record.keys(question.criteria)).toEqual([
            "member",
            "notMember",
            "mixed",
            "undetermined",
            "multipleTarget0",
            "multipleTarget1",
            "multipleTarget2",
            "multipleTarget3",
          ]);
          return Effect.succeed({
            answers: {
              record0: {
                _tag: "Classify",
                label: "multipleTarget2",
                probabilities: {
                  member: 0,
                  notMember: 0,
                  mixed: 0,
                  undetermined: 0,
                  multipleTarget0: 0,
                  multipleTarget1: 0,
                  multipleTarget2: 1,
                  multipleTarget3: 0,
                },
              },
            },
            usage: { inputTokens: undefined, outputTokens: undefined },
          });
        },
      }),
    );
    return Effect.gen(function* () {
      const result = yield* Taxonomy.recordBelongsTo(RecordLabel.make("record"), target);
      expect(result).toEqual({
        _tag: "MultipleTaxaInTarget",
        target: duplicate,
      });
      if (result._tag !== "MultipleTaxaInTarget") throw new Error("Expected clarification");
      expect(result.target).toBe(duplicate);
      expect(result.target).not.toBe(a);
    }).pipe(Effect.provide(layer));
  },
);

it.effect(
  "literal Empty membership skips transport and does not validate the other operand",
  () => {
    const layer = Layer.effect(
      DecisionModel.DecisionModel,
      DecisionModel.make({ decide: () => Effect.die("No request expected") }),
    );
    return Effect.gen(function* () {
      // @ts-expect-error Literal Empty does not certify an untyped record.
      expect(yield* Taxonomy.recordBelongsTo({}, TaxonSet.empty())).toEqual({ _tag: "NotMember" });
    }).pipe(Effect.provide(layer));
  },
);

it.effect("a nonliteral zero-name target still asks membership with valid base choices", () => {
  const target = TaxonSet.intersection(TaxonSet.empty(), TaxonSet.empty());
  const layer = Layer.effect(
    DecisionModel.DecisionModel,
    DecisionModel.make({
      decide: ({ state, decisions }) => {
        expect(state).toEqual({
          nodes: [{ _tag: "Intersection", operands: [1, 2] }, { _tag: "Empty" }, { _tag: "Empty" }],
          target: 0,
        });
        const question = Record.get(decisions, "record0").pipe(Option.getOrThrow);
        if (!Predicate.isTagged(question, "Classify")) return Effect.die("Expected classification");
        expect(Record.keys(question.criteria)).toEqual([
          "member",
          "notMember",
          "mixed",
          "undetermined",
        ]);
        return Effect.succeed({
          answers: {
            record0: {
              _tag: "Classify",
              label: "notMember",
              probabilities: { member: 0, notMember: 1, mixed: 0, undetermined: 0 },
            },
          },
          usage: { inputTokens: undefined, outputTokens: undefined },
        });
      },
    }),
  );
  return Effect.gen(function* () {
    expect(yield* Taxonomy.recordBelongsTo(RecordLabel.make("A"), target)).toEqual({
      _tag: "NotMember",
    });
  }).pipe(Effect.provide(layer));
});

it.effect.each([
  [
    "tied diagnosis",
    "multipleTarget0",
    { member: 0.5, multipleTarget0: 0.5 },
    0,
    0,
    "Undetermined",
  ],
  ["nonleading selection", "member", { member: 0.4, notMember: 0.6 }, 0, 0, "Undetermined"],
  ["weak mixed", "mixed", { member: 0.3, notMember: 0.3, mixed: 0.4 }, 0.5, 0, "Undetermined"],
  [
    "explicit uncertainty",
    "undetermined",
    { member: 0.9, undetermined: 0.1 },
    0,
    0,
    "Undetermined",
  ],
  ["decimal margin", "mixed", { mixed: 0.6, member: 0.4 }, 0.6, 0.2, "MixedMembership"],
  ["exact support", "mixed", { mixed: 0.6, member: 0.4 }, 0.6000000000000001, 0, "Undetermined"],
  ["beyond epsilon", "mixed", { mixed: 0.6, member: 0.4 }, 0.6, 0.2000000000000003, "Undetermined"],
] as const)(
  "applies singleton membership policy: %s",
  ([_case, label, probabilities, minimumSupport, minimumMargin, tag]) =>
    Effect.gen(function* () {
      expect(
        yield* Taxonomy.recordBelongsTo(RecordLabel.make("A"), TaxonName.make("B"), {
          policy: AcceptancePolicy.make({ minimumSupport, minimumMargin }),
        }),
      ).toEqual({ _tag: tag });
    }).pipe(
      Effect.provide(
        scalarLayer("record0", {
          _tag: "Classify",
          label,
          probabilities: pipe(
            { member: 0, notMember: 0, mixed: 0, undetermined: 0, multipleTarget0: 0 },
            Struct.assign(probabilities),
          ),
        }),
      ),
    ),
);

it.effect(
  "constructs fresh scalar and membership requests for repeated interleaved executions",
  () => {
    const seen: unknown[] = [];
    const layer = Layer.effect(
      DecisionModel.DecisionModel,
      DecisionModel.make({
        decide: ({ state, decisions }) => {
          seen.push(state);
          const answers = Record.map(
            decisions,
            (question): DecisionModel.ProviderClassifyAnswer => {
              if (!Predicate.isTagged(question, "Classify"))
                throw new Error("Expected classification");
              if (
                Record.has(question.criteria, "multipleTarget0") &&
                !Record.has(question.criteria, "multipleTarget1")
              )
                expect(Record.keys(question.criteria)).toEqual([
                  "member",
                  "notMember",
                  "mixed",
                  "undetermined",
                  "multipleTarget0",
                ]);
              return {
                _tag: "Classify",
                label: "undetermined",
                probabilities: Record.map(question.criteria, (_value, key) =>
                  key === "undetermined" ? 1 : 0,
                ),
              };
            },
          );
          return Effect.succeed({
            answers,
            usage: { inputTokens: undefined, outputTokens: undefined },
          });
        },
      }),
    );
    const first = Taxonomy.recordBelongsTo(RecordLabel.make("A"), TaxonName.make("target1"));
    const second = Taxonomy.recordBelongsTo(
      RecordLabel.make("B"),
      TaxonSet.union(
        TaxonSet.of(TaxonName.make("target2")),
        TaxonSet.of(TaxonName.make("target3")),
      ),
    );
    return Effect.gen(function* () {
      yield* Effect.all(
        [first, second, Taxonomy.sameTaxon(TaxonName.make("C"), TaxonName.make("D"))],
        { concurrency: 3 },
      );
      yield* first;
      expect(seen).toHaveLength(4);
      expect(
        Array.filter(
          seen,
          Schema.is(
            Schema.Struct({
              nodes: Schema.Tuple([Schema.Struct({ _tag: Schema.Literal("Taxon") })]),
            }),
          ),
        ),
      ).toEqual([
        { nodes: [{ _tag: "Taxon", record: { scientificName: "target1" } }], target: 0 },
        { nodes: [{ _tag: "Taxon", record: { scientificName: "target1" } }], target: 0 },
      ]);
      expect(seen).toEqual(
        expect.arrayContaining([
          { nodes: [{ _tag: "Taxon", record: { scientificName: "target1" } }], target: 0 },
          {
            nodes: [
              { _tag: "Union", operands: [1, 2] },
              { _tag: "Taxon", record: { scientificName: "target2" } },
              { _tag: "Taxon", record: { scientificName: "target3" } },
            ],
            target: 0,
          },
          null,
        ]),
      );
    }).pipe(Effect.provide(layer));
  },
);

const nameA = TaxonName.make("A");
const nameB = TaxonName.make("B");
const recordA = RecordLabel.make("A");
type Judgment = TaxonIdentityJudgment | TaxonContainmentJudgment | TaxonMembershipJudgment;
const modelOperations: readonly (readonly [
  string,
  () => Effect.Effect<Judgment, AiError.AiError, DecisionModel.DecisionModel>,
])[] = [
  ["identity", () => Taxonomy.sameTaxon(nameA, nameB)],
  ["containment", () => Taxonomy.taxonWithin(nameA, nameB)],
  ["record0", () => Taxonomy.recordBelongsTo(recordA, nameB)],
];

it.effect(
  "gates Effect-rescaled scalar and membership answers, ignoring optional confidence",
  () => {
    const layer = Layer.effect(
      DecisionModel.DecisionModel,
      DecisionModel.make({
        probabilityPrecision: 1,
        decide: ({ decisions }) =>
          Effect.succeed({
            answers: Record.map(
              decisions,
              (_question, key): DecisionModel.ProviderClassifyAnswer =>
                key === "identity"
                  ? {
                      _tag: "Classify",
                      label: "same",
                      confidence: 0,
                      probabilities: {
                        same: 0.6,
                        different: 0.3,
                        undetermined: 0,
                        multipleLeft: 0,
                        multipleRight: 0,
                        multipleBoth: 0,
                      },
                    }
                  : {
                      _tag: "Classify",
                      label: "mixed",
                      confidence: 0,
                      probabilities: {
                        member: 0.3,
                        notMember: 0,
                        mixed: 0.6,
                        undetermined: 0,
                        multipleTarget0: 0,
                      },
                    },
            ),
            usage: { inputTokens: undefined, outputTokens: undefined },
          }),
      }),
    );
    return Effect.gen(function* () {
      const policy = AcceptancePolicy.make({ minimumSupport: 0.65, minimumMargin: 0.3 });
      expect(yield* Taxonomy.sameTaxon(nameA, nameB, { policy })).toEqual({ _tag: "SameTaxon" });
      expect(yield* Taxonomy.recordBelongsTo(recordA, nameB, { policy })).toEqual({
        _tag: "MixedMembership",
      });
    }).pipe(Effect.provide(layer));
  },
);

it.effect(
  "maps invalid original scalar and membership inputs before presentation or transport",
  () => {
    let calls = 0;
    const layer = Layer.effect(
      DecisionModel.DecisionModel,
      DecisionModel.make({
        decide: () => {
          calls++;
          return Effect.die("No request expected");
        },
      }),
    );
    return Effect.gen(function* () {
      const requests: readonly Effect.Effect<
        Judgment,
        AiError.AiError,
        DecisionModel.DecisionModel
      >[] = [
        // @ts-expect-error Untyped caller with blank name.
        Taxonomy.sameTaxon(" ", nameB),
        // @ts-expect-error Untyped caller with invalid outer name.
        Taxonomy.taxonWithin(nameA, 17),
        // @ts-expect-error Untyped caller with missing record facts.
        Taxonomy.recordBelongsTo({}, nameB),
        // @ts-expect-error Untyped caller with invalid target name.
        Taxonomy.recordBelongsTo(recordA, " "),
        // @ts-expect-error Untyped caller with malformed recursive target.
        Taxonomy.recordBelongsTo(recordA, { _tag: "Difference", left: TaxonSet.of(nameA) }),
      ];
      for (const request of requests)
        expect((yield* Effect.flip(request)).reason._tag).toBe("InvalidUserInputError");
      expect(calls).toBe(0);
    }).pipe(Effect.provide(layer));
  },
);

it.effect.each(modelOperations)("preserves provider failure for %s", ([_key, operation]) => {
  const failure = AiError.make({
    module: "TestProvider",
    method: "decide",
    reason: new AiError.UnknownError({ description: "fixture failure" }),
  });
  let calls = 0;
  const layer = Layer.effect(
    DecisionModel.DecisionModel,
    DecisionModel.make({
      decide: () => {
        calls++;
        return Effect.fail(failure);
      },
    }),
  );
  return Effect.gen(function* () {
    expect(yield* Effect.flip(operation())).toBe(failure);
    expect(calls).toBe(1);
  }).pipe(Effect.provide(layer));
});

for (const [key, operation] of modelOperations) {
  it.effect(`rejects a missing ${key} answer`, () =>
    Effect.gen(function* () {
      const layer = Layer.effect(
        DecisionModel.DecisionModel,
        DecisionModel.make({
          decide: () =>
            Effect.succeed({
              answers: {},
              usage: { inputTokens: undefined, outputTokens: undefined },
            }),
        }),
      );
      expect((yield* Effect.flip(operation().pipe(Effect.provide(layer)))).reason._tag).toBe(
        "InvalidOutputError",
      );
    }),
  );
}

it.effect.each(modelOperations)(
  "preserves interruption without retry for %s",
  ([_key, operation]) =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      let calls = 0;
      const layer = Layer.effect(
        DecisionModel.DecisionModel,
        DecisionModel.make({
          decide: () => {
            calls++;
            return Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never));
          },
        }),
      );
      const fiber = yield* operation().pipe(Effect.provide(layer), Effect.forkChild);
      yield* Deferred.await(started);
      yield* Fiber.interrupt(fiber);
      const exit = yield* Fiber.await(fiber);
      expect(Exit.getCause(exit).pipe(Option.getOrThrow, Cause.hasInterruptsOnly)).toBe(true);
      expect(calls).toBe(1);
    }),
);

it.effect.each(modelOperations)("preserves a provider defect for %s", ([_key, operation]) => {
  const defect = new Error("Provider transport defect fixture");
  let calls = 0;
  const layer = Layer.effect(
    DecisionModel.DecisionModel,
    DecisionModel.make({
      decide: () => {
        calls++;
        return Effect.die(defect);
      },
    }),
  );
  return Effect.gen(function* () {
    const exit = yield* Effect.exit(operation());
    expect(Exit.isFailure(exit)).toBe(true);
    const cause = Exit.getCause(exit).pipe(Option.getOrThrow);
    expect(cause.reasons).toHaveLength(1);
    expect(
      pipe(
        cause.reasons,
        Array.filter(Cause.isDieReason),
        Array.map((reason) => reason.defect),
      ),
    ).toEqual([defect]);
    expect(calls).toBe(1);
  }).pipe(Effect.provide(layer));
});

it.effect("provides shared target once and record facts once in singleton membership", () => {
  let calls = 0;
  const record = TaxonomicRecord.make({
    label: RecordLabel.make('Voucher "A"\nline'),
    scientificName: TaxonName.make("Quercus robur"),
    taxonId: TaxonId.make({ taxonomy: "local", id: "17", release: "2026" }),
  });
  const layer = Layer.effect(
    DecisionModel.DecisionModel,
    DecisionModel.make({
      decide: ({ state, decisions }) => {
        calls++;
        expect(state).toEqual({
          nodes: [{ _tag: "Taxon", record: { scientificName: "Quercus" } }],
          target: 0,
        });
        expect(Record.keys(decisions)).toEqual(["record0"]);
        expect(decisions.record0).toMatchObject({
          _tag: "Classify",
          instructions: expect.stringContaining(
            'Record label: "Voucher \\"A\\"\\nline"\nScientific name: "Quercus robur"\nTaxonomy: "local"\nTaxon ID: "17"\nTaxonomy release: "2026"',
          ),
          criteria: {
            member: expect.any(String),
            notMember: expect.any(String),
            mixed: expect.any(String),
            undetermined: expect.any(String),
            multipleTarget0: expect.stringContaining("Target taxon node 0 "),
          },
        });
        const question = Record.get(decisions, "record0").pipe(Option.getOrThrow);
        if (!Predicate.isTagged(question, "Classify")) return Effect.die("Expected classification");
        for (const field of [
          "Record label",
          "Scientific name",
          "Taxonomy",
          "Taxon ID",
          "Taxonomy release",
        ]) {
          expect(question.instructions.split(`${field}:`), field).toHaveLength(2);
        }
        return Effect.succeed({
          answers: {
            record0: {
              _tag: "Classify",
              label: "member",
              probabilities: {
                member: 1,
                notMember: 0,
                mixed: 0,
                undetermined: 0,
                multipleTarget0: 0,
              },
            },
          },
          usage: { inputTokens: undefined, outputTokens: undefined },
        });
      },
    }),
  );
  return Effect.gen(function* () {
    expect(yield* Taxonomy.recordBelongsTo(record, TaxonName.make("Quercus"))).toEqual({
      _tag: "Member",
    });
    expect(calls).toBe(1);
  }).pipe(Effect.provide(layer));
});

const scalarLayer = (key: string, answer: DecisionModel.ProviderClassifyAnswer) =>
  Layer.effect(
    DecisionModel.DecisionModel,
    DecisionModel.make({
      decide: () =>
        Effect.succeed({
          answers: { [key]: answer },
          usage: { inputTokens: undefined, outputTokens: undefined },
        }),
    }),
  );

it.effect.each([
  ["different", { _tag: "DifferentTaxa" }],
  ["multipleBoth", { _tag: "MultipleTaxa", side: "both" }],
  ["undetermined", { _tag: "Undetermined" }],
] as const)("maps the selected identity fixture %s", ([label, expected]) =>
  Effect.gen(function* () {
    expect(yield* Taxonomy.sameTaxon(TaxonName.make("A"), TaxonName.make("B"))).toEqual(expected);
  }).pipe(
    Effect.provide(
      scalarLayer("identity", {
        _tag: "Classify",
        label,
        probabilities: {
          same: 0,
          different: 0,
          multipleLeft: 0,
          multipleRight: 0,
          multipleBoth: 0,
          undetermined: 0,
          [label]: 1,
        },
      }),
    ),
  ),
);

it.effect.each([
  ["weak", "same", { same: 0.4, different: 0.3, undetermined: 0.3 }, undefined],
  [
    "tie",
    "same",
    { same: 0.5, different: 0.5, undetermined: 0 },
    AcceptancePolicy.make({ minimumSupport: 0, minimumMargin: 0 }),
  ],
  [
    "nonleader",
    "multipleLeft",
    { same: 0.6, multipleLeft: 0.4 },
    AcceptancePolicy.make({ minimumSupport: 0, minimumMargin: 0 }),
  ],
  ["explicit uncertainty", "undetermined", { same: 0.9, undetermined: 0.1 }, undefined],
  [
    "support stays exact",
    "same",
    { same: 0.6, different: 0.4 },
    AcceptancePolicy.make({ minimumSupport: 0.6000000000000001, minimumMargin: 0 }),
  ],
  [
    "margin beyond epsilon",
    "multipleBoth",
    { multipleBoth: 0.6, same: 0.4 },
    AcceptancePolicy.make({ minimumSupport: 0.6, minimumMargin: 0.2000000000000003 }),
  ],
] as const)("abstains for identity %s", ([_case, label, probabilities, policy]) =>
  Effect.gen(function* () {
    expect(
      yield* Taxonomy.sameTaxon(
        TaxonName.make("A"),
        TaxonName.make("B"),
        Option.match(Option.fromUndefinedOr(policy), {
          onNone: () => ({}),
          onSome: (policy) => ({ policy }),
        }),
      ),
    ).toEqual({ _tag: "Undetermined" });
  }).pipe(
    Effect.provide(
      scalarLayer("identity", {
        _tag: "Classify",
        label,
        probabilities: pipe(
          {
            same: 0,
            different: 0,
            undetermined: 0,
            multipleLeft: 0,
            multipleRight: 0,
            multipleBoth: 0,
          },
          Struct.assign(probabilities),
        ),
      }),
    ),
  ),
);

it.effect("accepts inclusive support and decimal margin for a selected diagnosis", () =>
  Effect.gen(function* () {
    expect(
      yield* Taxonomy.sameTaxon(TaxonName.make("A"), TaxonName.make("B"), {
        policy: AcceptancePolicy.make({ minimumSupport: 0.6, minimumMargin: 0.2 }),
      }),
    ).toEqual({ _tag: "MultipleTaxa", side: "right" });
  }).pipe(
    Effect.provide(
      scalarLayer("identity", {
        _tag: "Classify",
        label: "multipleRight",
        probabilities: {
          same: 0.4,
          different: 0,
          undetermined: 0,
          multipleLeft: 0,
          multipleRight: 0.6,
          multipleBoth: 0,
        },
      }),
    ),
  ),
);

it.effect("asks the direct containment question with original left = inner", () => {
  const layer = Layer.effect(
    DecisionModel.DecisionModel,
    DecisionModel.make({
      decide: ({ state, decisions }) => {
        expect(state).toBeNull();
        expect(Record.keys(decisions)).toEqual(["containment"]);
        expect(decisions.containment).toMatchObject({
          _tag: "Classify",
          instructions: expect.stringContaining(
            'Left (inner) taxon:\nScientific name: "A"\nRight (outer) taxon:\nScientific name: "B"',
          ),
          criteria: {
            equal: expect.any(String),
            partialOverlap: expect.any(String),
            disjoint: expect.any(String),
          },
        });
        return Effect.succeed({
          answers: {
            containment: {
              _tag: "Classify",
              label: "equal",
              probabilities: {
                ...containmentProbabilities,
                equal: 1,
              },
            },
          },
          usage: { inputTokens: undefined, outputTokens: undefined },
        });
      },
    }),
  );
  return Effect.gen(function* () {
    expect(yield* Taxonomy.taxonWithin(TaxonName.make("A"), TaxonName.make("B"))).toEqual({
      _tag: "Contained",
    });
  }).pipe(Effect.provide(layer));
});
