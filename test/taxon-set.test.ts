import { expect, it } from "@effect/vitest";
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Record, Struct, pipe } from "effect";
import { AiError, DecisionModel } from "effect/ai";
import { JudgmentPolicy, TaxonName, TaxonSet } from "../src/index.ts";

it("preserves syntax with fresh parents and shared readonly children", () => {
  const oak = TaxonSet.of(TaxonName.make("Quercus"));
  const beech = TaxonSet.of(TaxonName.make("Fagus"));
  const first = TaxonSet.union(oak, beech);
  const second = TaxonSet.union(oak, beech);
  expect(first).toEqual({ _tag: "Union", operands: [oak, beech] });
  expect(first).not.toBe(second);
  if (first._tag !== "Union" || second._tag !== "Union") throw new Error("Expected unions");
  expect(first.operands).not.toBe(second.operands);
  expect(first.operands[0]).toBe(oak);
  expect(first.operands[1]).toBe(beech);
  const remaining = TaxonSet.difference(first, oak);
  if (remaining._tag !== "Difference") throw new Error("Expected difference");
  expect(remaining.left).toBe(first);
  expect(remaining.right).toBe(oak);
  expect(first.operands).toEqual([oak, beech]);
});

it("preserves literal Empty and derived syntax without normalization", () => {
  const none = TaxonSet.empty();
  expect(none).toEqual({ _tag: "Empty" });
  expect(TaxonSet.empty()).not.toBe(none);
  const a = TaxonSet.of(TaxonName.make("A"));
  const b = TaxonSet.of(TaxonName.make("B"));
  const intersection = TaxonSet.intersection(a, none);
  const another = TaxonSet.intersection(a, none);
  if (intersection._tag !== "Intersection" || another._tag !== "Intersection")
    throw new Error("Expected intersections");
  expect(intersection.operands).toEqual([a, none]);
  expect(intersection.operands[0]).toBe(a);
  expect(intersection.operands[1]).toBe(none);
  expect(intersection.operands).not.toBe(another.operands);
  expect(intersection).not.toBe(another);
  const complement = TaxonSet.complement(a, b);
  expect(complement).toEqual({ _tag: "Difference", left: b, right: a });
  if (complement._tag !== "Difference") throw new Error("Expected difference");
  expect(complement.left).toBe(b);
  expect(complement.right).toBe(a);
  const symmetric = TaxonSet.symmetricDifference(a, b);
  expect(symmetric).toEqual({
    _tag: "Union",
    operands: [
      { _tag: "Difference", left: a, right: b },
      { _tag: "Difference", left: b, right: a },
    ],
  });
  expect(TaxonSet.difference(a, a)).toEqual({ _tag: "Difference", left: a, right: a });
  const nested = TaxonSet.union(TaxonSet.union(a, b), a);
  expect(nested).toEqual({ _tag: "Union", operands: [{ _tag: "Union", operands: [a, b] }, a] });
});

const operations = [
  ["subset", TaxonSet.isSubsetOf, "Yes", "No"],
  ["proper-subset", TaxonSet.isProperSubsetOf, "Yes", "No"],
  ["equivalent", TaxonSet.equivalent, "Yes", "No"],
  ["overlap", TaxonSet.overlaps, "Yes", "No"],
  ["disjoint", TaxonSet.disjoint, "No", "Yes"],
] as const;

// These transport fixtures are not biological predictions.
it.effect.each(operations)(
  "transports distinct original expression sides for %s",
  ([relation, operation]) => {
    const left = TaxonSet.of(TaxonName.make("A"));
    const right = TaxonSet.of(TaxonName.make("C"));
    let calls = 0;
    const layer = Layer.effect(
      DecisionModel.DecisionModel,
      DecisionModel.make({
        decide: ({ state, decisions }) => {
          calls++;
          expect(state).toEqual({
            nodes: [
              { _tag: "Taxon", name: "A" },
              { _tag: "Taxon", name: "C" },
            ],
            left: 0,
            right: 1,
          });
          const question = decisions.relation;
          if (question?._tag !== "Classify") return Effect.die("Expected classification");
          return Effect.succeed({
            answers: {
              relation: {
                _tag: "Classify",
                label: "multipleRight0",
                probabilities: Record.map(question.criteria, (_value, key) =>
                  key === "multipleRight0" ? 1 : 0,
                ),
              },
            },
            usage: { inputTokens: undefined, outputTokens: undefined },
          });
        },
      }),
    );
    return Effect.gen(function* () {
      expect(yield* operation(left, right)).toEqual({
        _tag: "MultipleTaxaInSetName",
        relation,
        side: "right",
        taxonName: "C",
      });
      expect(calls).toBe(1);
    }).pipe(Effect.provide(layer));
  },
);

const relationLayer = (answer: DecisionModel.ProviderClassifyAnswer) =>
  Layer.effect(
    DecisionModel.DecisionModel,
    DecisionModel.make({
      decide: () =>
        Effect.succeed({
          answers: { relation: answer },
          usage: { inputTokens: undefined, outputTokens: undefined },
        }),
    }),
  );

it.effect(
  "shares original nodes across roots without merging equal distinct nodes or name locations",
  () => {
    const a = TaxonSet.of(TaxonName.make("A"));
    const left = TaxonSet.union(a, a);
    const right = TaxonSet.intersection(
      TaxonSet.of(TaxonName.make("B")),
      TaxonSet.difference(left, TaxonSet.of(TaxonName.make("A"))),
    );
    const layer = Layer.effect(
      DecisionModel.DecisionModel,
      DecisionModel.make({
        decide: ({ state, decisions }) => {
          expect(state).toEqual({
            nodes: [
              { _tag: "Taxon", name: "A" },
              { _tag: "Union", operands: [0, 0] },
              { _tag: "Taxon", name: "B" },
              { _tag: "Taxon", name: "A" },
              { _tag: "Difference", left: 1, right: 3 },
              { _tag: "Intersection", operands: [2, 4] },
            ],
            left: 1,
            right: 5,
          });
          const question = decisions.relation;
          if (question?._tag !== "Classify") return Effect.die("Expected classification");
          expect(question.instructions).toContain("References index nodes");
          expect(question.instructions).toContain("Roots are left and right");
          expect(Object.keys(question.criteria)).toEqual([
            "yes",
            "no",
            "undetermined",
            "multipleLeft0",
            "multipleRight0",
            "multipleRight1",
          ]);
          expect(question.criteria.multipleRight0).toContain('"B"');
          expect(question.criteria.multipleRight1).toContain('"A"');
          return Effect.succeed({
            answers: {
              relation: {
                _tag: "Classify",
                label: "multipleRight1",
                probabilities: Record.map(question.criteria, (_value, key) =>
                  key === "multipleRight1" ? 1 : 0,
                ),
              },
            },
            usage: { inputTokens: undefined, outputTokens: undefined },
          });
        },
      }),
    );
    return Effect.gen(function* () {
      expect(yield* TaxonSet.overlaps(left, right)).toEqual({
        _tag: "MultipleTaxaInSetName",
        relation: "overlap",
        side: "right",
        taxonName: "A",
      });
    }).pipe(Effect.provide(layer));
  },
);

it.effect("keeps a bounded shared DAG compact through public equivalence transport", () => {
  let expression = TaxonSet.of(TaxonName.make("A"));
  for (let depth = 0; depth < 12; depth++) {
    expression = TaxonSet.union(expression, expression);
  }
  const layer = Layer.effect(
    DecisionModel.DecisionModel,
    DecisionModel.make({
      decide: ({ state, decisions }) => {
        // One taxon plus twelve distinct unions, shared by both roots.
        expect(state).toHaveProperty("nodes.length", 13);
        expect(state).toMatchObject({ left: 12, right: 12 });
        expect(state).toHaveProperty("nodes.0", { _tag: "Taxon", name: "A" });
        expect(state).toHaveProperty("nodes.1", { _tag: "Union", operands: [0, 0] });
        expect(state).toHaveProperty("nodes.12", { _tag: "Union", operands: [11, 11] });
        const question = decisions.relation;
        if (question?._tag !== "Classify") return Effect.die("Expected classification");
        return Effect.succeed({
          answers: {
            relation: {
              _tag: "Classify",
              label: "yes",
              probabilities: Record.map(question.criteria, (_value, key) =>
                key === "yes" ? 1 : 0,
              ),
            },
          },
          usage: { inputTokens: undefined, outputTokens: undefined },
        });
      },
    }),
  );
  return Effect.gen(function* () {
    expect(yield* TaxonSet.equivalent(expression, expression)).toEqual({
      _tag: "Yes",
      relation: "equivalent",
    });
  }).pipe(Effect.provide(layer));
});

it.effect.each([
  [
    "cycle",
    () => {
      const branch = TaxonSet.union(TaxonSet.empty(), TaxonSet.empty());
      Object.assign(branch, { operands: [branch] });
      return branch;
    },
  ],
  [
    "blank nested name",
    () => {
      const leaf = TaxonSet.of(TaxonName.make("A"));
      const branch = TaxonSet.union(leaf, leaf);
      Object.assign(leaf, { name: " " });
      return branch;
    },
  ],
  [
    "empty operands",
    () => {
      const branch = TaxonSet.union(TaxonSet.empty(), TaxonSet.empty());
      Object.assign(branch, { operands: [] });
      return branch;
    },
  ],
  [
    "primitive child",
    () => {
      const branch = TaxonSet.difference(TaxonSet.empty(), TaxonSet.empty());
      Object.assign(branch, { right: 17 });
      return branch;
    },
  ],
] as const)("rejects a nominal expression with %s before transport", ([_case, make]) => {
  const expression = make();
  const layer = Layer.effect(
    DecisionModel.DecisionModel,
    DecisionModel.make({
      decide: () => Effect.die("No request expected"),
    }),
  );
  return Effect.gen(function* () {
    const error = yield* Effect.flip(
      TaxonSet.overlaps(expression, TaxonSet.of(TaxonName.make("B"))),
    );
    expect(error.module).toBe("TaxonSet");
    expect(error.method).toBe("makeRelationQuestion");
    expect(error.reason._tag).toBe("InvalidUserInputError");
  }).pipe(Effect.provide(layer));
});

it.effect(
  "gates Effect-rescaled set answers without another normalization or confidence gate",
  () => {
    const layer = Layer.effect(
      DecisionModel.DecisionModel,
      DecisionModel.make({
        probabilityPrecision: 1,
        decide: () =>
          Effect.succeed({
            answers: {
              relation: {
                _tag: "Classify",
                label: "yes",
                confidence: 0,
                probabilities: {
                  yes: 0.6,
                  no: 0.3,
                  undetermined: 0,
                  multipleLeft0: 0,
                  multipleRight0: 0,
                },
              },
            },
            usage: { inputTokens: undefined, outputTokens: undefined },
          }),
      }),
    );
    return Effect.gen(function* () {
      const a = TaxonSet.of(TaxonName.make("A"));
      expect(
        yield* TaxonSet.isSubsetOf(a, a, {
          policy: JudgmentPolicy.make({ minimumSupport: 0.65, minimumMargin: 0.3 }),
        }),
      ).toEqual({ _tag: "Yes", relation: "subset" });
    }).pipe(Effect.provide(layer));
  },
);

for (const [relation, operation, yesTag, noTag] of operations) {
  it.effect.each([
    ["yes", { _tag: yesTag, relation }],
    ["no", { _tag: noTag, relation }],
    ["undetermined", { _tag: "Undetermined", relation }],
    ["multipleLeft0", { _tag: "MultipleTaxaInSetName", relation, side: "left", taxonName: "A" }],
    ["multipleRight0", { _tag: "MultipleTaxaInSetName", relation, side: "right", taxonName: "B" }],
  ] as const)(`maps ${relation} selected fixture %s to its original side`, ([label, expected]) =>
    Effect.gen(function* () {
      const left = TaxonSet.of(TaxonName.make("A"));
      const right = TaxonSet.of(TaxonName.make("B"));
      expect(
        yield* operation(left, right).pipe(
          Effect.provide(
            relationLayer({
              _tag: "Classify",
              label,
              probabilities: {
                yes: 0,
                no: 0,
                undetermined: 0,
                multipleLeft0: 0,
                multipleRight0: 0,
                [label]: 1,
              },
            }),
          ),
        ),
      ).toEqual(expected);
    }),
  );
}

it.effect(
  "deduplicates literal names per side only, retaining expression order and original side",
  () => {
    const a = TaxonSet.of(TaxonName.make("A"));
    const b = TaxonSet.of(TaxonName.make("B"));
    const c = TaxonSet.of(TaxonName.make("C"));
    const left = TaxonSet.difference(
      TaxonSet.union(a, TaxonSet.intersection(b, a)),
      TaxonSet.of(TaxonName.make("A")),
    );
    const right = TaxonSet.union(c, TaxonSet.difference(a, c));
    let calls = 0;
    const layer = Layer.effect(
      DecisionModel.DecisionModel,
      DecisionModel.make({
        decide: ({ decisions }) => {
          calls++;
          const question = decisions.relation;
          if (question?._tag !== "Classify") return Effect.die("Expected classification");
          expect(Object.keys(question.criteria)).toEqual([
            "yes",
            "no",
            "undetermined",
            "multipleLeft0",
            "multipleLeft1",
            "multipleRight0",
            "multipleRight1",
          ]);
          expect(question.criteria).toMatchObject({
            multipleLeft0: expect.stringContaining('left-set name "A"'),
            multipleLeft1: expect.stringContaining('left-set name "B"'),
            multipleRight0: expect.stringContaining('right-set name "C"'),
            multipleRight1: expect.stringContaining('right-set name "A"'),
          });
          return Effect.succeed({
            answers: {
              relation: {
                _tag: "Classify",
                label: "multipleRight1",
                probabilities: {
                  yes: 0,
                  no: 0,
                  undetermined: 0,
                  multipleLeft0: 0,
                  multipleLeft1: 0,
                  multipleRight0: 0,
                  multipleRight1: 1,
                },
              },
            },
            usage: { inputTokens: undefined, outputTokens: undefined },
          });
        },
      }),
    );
    return Effect.gen(function* () {
      expect(yield* TaxonSet.isSubsetOf(left, right)).toEqual({
        _tag: "MultipleTaxaInSetName",
        relation: "subset",
        side: "right",
        taxonName: "A",
      });
      expect(calls).toBe(1);
    }).pipe(Effect.provide(layer));
  },
);

it.effect("uses only the listed literal Empty shortcuts, without certifying other inputs", () => {
  const empty = TaxonSet.empty();
  const problematic = TaxonSet.of(TaxonName.make("A and B"));
  const layer = Layer.effect(
    DecisionModel.DecisionModel,
    DecisionModel.make({ decide: () => Effect.die("No requests expected") }),
  );
  return Effect.gen(function* () {
    expect(yield* TaxonSet.isSubsetOf(empty, problematic)).toEqual({
      _tag: "Yes",
      relation: "subset",
    });
    expect(yield* TaxonSet.isProperSubsetOf(problematic, empty)).toEqual({
      _tag: "No",
      relation: "proper-subset",
    });
    expect(yield* TaxonSet.equivalent(empty, empty)).toEqual({
      _tag: "Yes",
      relation: "equivalent",
    });
    expect(yield* TaxonSet.overlaps(empty, problematic)).toEqual({
      _tag: "No",
      relation: "overlap",
    });
    expect(yield* TaxonSet.overlaps(problematic, empty)).toEqual({
      _tag: "No",
      relation: "overlap",
    });
    expect(yield* TaxonSet.disjoint(empty, problematic)).toEqual({
      _tag: "Yes",
      relation: "disjoint",
    });
    expect(yield* TaxonSet.disjoint(problematic, empty)).toEqual({
      _tag: "Yes",
      relation: "disjoint",
    });
    // @ts-expect-error Shortcut facts do not validate the unused right operand.
    expect(yield* TaxonSet.isSubsetOf(empty, {})).toEqual({ _tag: "Yes", relation: "subset" });
  }).pipe(Effect.provide(layer));
});

it.effect("does not invent emptiness or inhabitation from nonliteral syntax", () => {
  const empty = TaxonSet.empty();
  const a = TaxonSet.of(TaxonName.make("A"));
  const nonliteralEmpty = TaxonSet.difference(a, a);
  const zeroNames = TaxonSet.union(empty, empty);
  const seen: unknown[] = [];
  const layer = Layer.effect(
    DecisionModel.DecisionModel,
    DecisionModel.make({
      decide: ({ state, decisions }) => {
        seen.push(state);
        const question = decisions.relation;
        if (question?._tag !== "Classify") return Effect.die("Expected classification");
        expect(Object.keys(decisions)).toEqual(["relation"]);
        if (seen.length === 5)
          expect(Object.keys(question.criteria)).toEqual(["yes", "no", "undetermined"]);
        return Effect.succeed({
          answers: {
            relation: {
              _tag: "Classify",
              label: "yes",
              probabilities: Record.map(question.criteria, (_value, key) =>
                key === "yes" ? 1 : 0,
              ),
            },
          },
          usage: { inputTokens: undefined, outputTokens: undefined },
        });
      },
    }),
  );
  return Effect.gen(function* () {
    expect(yield* TaxonSet.isSubsetOf(nonliteralEmpty, empty)).toEqual({
      _tag: "Yes",
      relation: "subset",
    });
    expect(yield* TaxonSet.equivalent(empty, a)).toEqual({ _tag: "Yes", relation: "equivalent" });
    expect(yield* TaxonSet.equivalent(a, empty)).toEqual({ _tag: "Yes", relation: "equivalent" });
    expect(yield* TaxonSet.isProperSubsetOf(empty, nonliteralEmpty)).toEqual({
      _tag: "Yes",
      relation: "proper-subset",
    });
    expect(yield* TaxonSet.overlaps(zeroNames, zeroNames)).toEqual({
      _tag: "Yes",
      relation: "overlap",
    });
    expect(yield* TaxonSet.disjoint(nonliteralEmpty, nonliteralEmpty)).toEqual({
      _tag: "No",
      relation: "disjoint",
    });
    expect(seen).toHaveLength(6);
    expect(seen[4]).toEqual({
      nodes: [{ _tag: "Empty" }, { _tag: "Union", operands: [0, 0] }],
      left: 1,
      right: 1,
    });
  }).pipe(Effect.provide(layer));
});

for (const [relation, operation] of operations) {
  it.effect.each([
    ["weak", "yes", { yes: 0.4, no: 0.3, undetermined: 0.3 }, 0.5, 0],
    ["tied", "multipleLeft0", { multipleLeft0: 0.5, yes: 0.5 }, 0, 0],
    ["nonleading", "no", { yes: 0.6, no: 0.4 }, 0, 0],
    ["uncertain", "undetermined", { yes: 0.9, undetermined: 0.1 }, 0, 0],
    [
      "split diagnoses not summed",
      "multipleLeft0",
      { multipleLeft0: 0.4, multipleRight0: 0.35, yes: 0.25 },
      0.5,
      0,
    ],
    ["exact support", "yes", { yes: 0.6, no: 0.4 }, 0.6000000000000001, 0],
    ["beyond epsilon", "yes", { yes: 0.6, no: 0.4 }, 0.6, 0.2000000000000003],
  ] as const)(
    `applies ${relation} policy: %s`,
    ([_case, label, probabilities, minimumSupport, minimumMargin]) =>
      Effect.gen(function* () {
        const a = TaxonSet.of(TaxonName.make("A"));
        const b = TaxonSet.of(TaxonName.make("B"));
        expect(
          yield* operation(a, b, {
            policy: JudgmentPolicy.make({ minimumSupport, minimumMargin }),
          }).pipe(
            Effect.provide(
              relationLayer({
                _tag: "Classify",
                label,
                probabilities: pipe(
                  { yes: 0, no: 0, undetermined: 0, multipleLeft0: 0, multipleRight0: 0 },
                  Struct.assign(probabilities),
                ),
              }),
            ),
          ),
        ).toEqual({ _tag: "Undetermined", relation });
      }),
  );
  it.effect(`accepts ${relation} exact support and margin boundary`, () =>
    Effect.gen(function* () {
      const a = TaxonSet.of(TaxonName.make("A"));
      const b = TaxonSet.of(TaxonName.make("B"));
      expect(
        yield* operation(a, b, {
          policy: JudgmentPolicy.make({ minimumSupport: 0.6, minimumMargin: 0.2 }),
        }).pipe(
          Effect.provide(
            relationLayer({
              _tag: "Classify",
              label: "multipleRight0",
              probabilities: {
                yes: 0.4,
                no: 0,
                undetermined: 0,
                multipleLeft0: 0,
                multipleRight0: 0.6,
              },
            }),
          ),
        ),
      ).toEqual({ _tag: "MultipleTaxaInSetName", relation, side: "right", taxonName: "B" });
    }),
  );
}

it.effect("builds per-execution name inventories for repeated and interleaved set requests", () => {
  const a = TaxonSet.of(TaxonName.make("A"));
  const b = TaxonSet.of(TaxonName.make("B"));
  const seen: string[][] = [];
  const layer = Layer.effect(
    DecisionModel.DecisionModel,
    DecisionModel.make({
      decide: ({ decisions }) => {
        const question = decisions.relation;
        if (question?._tag !== "Classify") return Effect.die("Expected classification");
        seen.push(Object.keys(question.criteria));
        return Effect.succeed({
          answers: {
            relation: {
              _tag: "Classify",
              label: "undetermined",
              probabilities: Record.map(question.criteria, (_value, key) =>
                key === "undetermined" ? 1 : 0,
              ),
            },
          },
          usage: { inputTokens: undefined, outputTokens: undefined },
        });
      },
    }),
  );
  const first = TaxonSet.overlaps(a, a);
  const second = TaxonSet.equivalent(TaxonSet.union(a, b), TaxonSet.empty());
  return Effect.gen(function* () {
    yield* Effect.all([first, second], { concurrency: 2 });
    yield* first;
    expect(seen.map((keys) => keys.join(",")).sort()).toEqual(
      [
        ["yes", "no", "undetermined", "multipleLeft0", "multipleRight0"],
        ["yes", "no", "undetermined", "multipleLeft0", "multipleLeft1"],
        ["yes", "no", "undetermined", "multipleLeft0", "multipleRight0"],
      ]
        .map((keys) => keys.join(","))
        .sort(),
    );
  }).pipe(Effect.provide(layer));
});

it.effect.each(operations)(
  "rejects invalid attempted %s input before traversal or transport",
  ([_relation, operation]) => {
    let calls = 0;
    const layer = Layer.effect(
      DecisionModel.DecisionModel,
      DecisionModel.make({
        decide: () => {
          calls++;
          return Effect.die("No requests expected");
        },
      }),
    );
    return Effect.gen(function* () {
      const error = yield* Effect.flip(
        // @ts-expect-error Malformed untyped expression lacks the right operand.
        operation({ _tag: "Difference", left: TaxonSet.empty() }, TaxonSet.of(TaxonName.make("A"))),
      );
      expect(error.reason._tag).toBe("InvalidUserInputError");
      expect(error.module).toBe("TaxonSet");
      expect(calls).toBe(0);
    }).pipe(Effect.provide(layer));
  },
);

it.effect.each(operations)(
  "preserves attempted provider failure for %s",
  ([_relation, operation]) => {
    const failure = AiError.make({
      module: "TestProvider",
      method: "decide",
      reason: new AiError.UnknownError({ description: "fixture unavailable" }),
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
      const a = TaxonSet.of(TaxonName.make("A"));
      expect(yield* Effect.flip(operation(a, a))).toBe(failure);
      expect(calls).toBe(1);
    }).pipe(Effect.provide(layer));
  },
);

for (const [relation, operation] of operations) {
  const invalidOutputs = [
    ["missing", undefined],
    [
      "unknown label",
      { _tag: "Classify" as const, label: "invented", probabilities: { invented: 1 } },
    ],
    [
      "invalid probabilities",
      {
        _tag: "Classify" as const,
        label: "yes",
        probabilities: {
          yes: 0.9,
          no: 0.9,
          undetermined: 0,
          multipleLeft0: 0,
          multipleRight0: 0,
        },
      },
    ],
  ] as const;
  it.effect.each(
    invalidOutputs.filter(
      // Missing answers exercise every wrapper; the other cases sample real model validation.
      ([kind]) =>
        kind === "missing" ||
        (kind === "unknown label" && relation === "overlap") ||
        (kind === "invalid probabilities" && relation === "subset"),
    ),
  )(`rejects ${relation} output: %s`, ([_case, answer]) =>
    Effect.gen(function* () {
      const a = TaxonSet.of(TaxonName.make("A"));
      const layer = Layer.effect(
        DecisionModel.DecisionModel,
        DecisionModel.make({
          decide: () =>
            Effect.succeed({
              answers: answer === undefined ? {} : { relation: answer },
              usage: { inputTokens: undefined, outputTokens: undefined },
            }),
        }),
      );
      expect((yield* Effect.flip(operation(a, a).pipe(Effect.provide(layer)))).reason._tag).toBe(
        "InvalidOutputError",
      );
    }),
  );
}

it.effect.each(operations)(
  "keeps pending %s interruption without retry or fallback",
  ([_relation, operation]) =>
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
      const a = TaxonSet.of(TaxonName.make("A"));
      const fiber = yield* operation(a, a).pipe(Effect.provide(layer), Effect.forkChild);
      yield* Deferred.await(started);
      yield* Fiber.interrupt(fiber);
      const exit = yield* Fiber.await(fiber);
      expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
      expect(calls).toBe(1);
    }),
);

it.effect.each(operations)("preserves a provider defect for %s", ([_relation, operation]) => {
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
    const a = TaxonSet.of(TaxonName.make("A"));
    const exit = yield* Effect.exit(operation(a, a));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(exit.cause.reasons).toHaveLength(1);
      expect(exit.cause.reasons.filter(Cause.isDieReason).map((reason) => reason.defect)).toEqual([
        defect,
      ]);
    }
    expect(calls).toBe(1);
  }).pipe(Effect.provide(layer));
});

it.effect("maps a single overlap observation to disjoint without another classification", () => {
  let calls = 0;
  const set = TaxonSet.of(TaxonName.make("A"));
  const layer = Layer.effect(
    DecisionModel.DecisionModel,
    DecisionModel.make({
      decide: ({ decisions }) => {
        calls++;
        expect(Object.keys(decisions)).toEqual(["relation"]);
        expect(decisions.relation).toMatchObject({
          instructions: expect.stringContaining("share any organisms"),
        });
        return Effect.succeed({
          answers: {
            relation: {
              _tag: "Classify",
              label: "yes",
              probabilities: {
                yes: 1,
                no: 0,
                undetermined: 0,
                multipleLeft0: 0,
                multipleRight0: 0,
              },
            },
          },
          usage: { inputTokens: undefined, outputTokens: undefined },
        });
      },
    }),
  );
  return Effect.gen(function* () {
    expect(yield* TaxonSet.disjoint(set, set)).toEqual({ _tag: "No", relation: "disjoint" });
    expect(calls).toBe(1);
  }).pipe(Effect.provide(layer));
});

it.effect("asks overlap directly with one complete-expression classification", () => {
  let calls = 0;
  const set = TaxonSet.of(TaxonName.make("A"));
  const layer = Layer.effect(
    DecisionModel.DecisionModel,
    DecisionModel.make({
      decide: ({ decisions }) => {
        calls++;
        expect(Object.keys(decisions)).toEqual(["relation"]);
        expect(decisions.relation).toMatchObject({
          instructions: expect.stringContaining("share any organisms"),
          criteria: {
            yes: expect.stringContaining("At least one organism belongs to both sets"),
            no: expect.stringContaining("No organism belongs to both sets"),
          },
        });
        return Effect.succeed({
          answers: {
            relation: {
              _tag: "Classify",
              label: "no",
              probabilities: {
                yes: 0,
                no: 1,
                undetermined: 0,
                multipleLeft0: 0,
                multipleRight0: 0,
              },
            },
          },
          usage: { inputTokens: undefined, outputTokens: undefined },
        });
      },
    }),
  );
  return Effect.gen(function* () {
    expect(yield* TaxonSet.overlaps(set, set)).toEqual({ _tag: "No", relation: "overlap" });
    expect(calls).toBe(1);
  }).pipe(Effect.provide(layer));
});

it.effect("asks organism-set equivalence directly even for the same expression", () => {
  let calls = 0;
  const set = TaxonSet.of(TaxonName.make("A"));
  const layer = Layer.effect(
    DecisionModel.DecisionModel,
    DecisionModel.make({
      decide: ({ decisions }) => {
        calls++;
        expect(Object.keys(decisions)).toEqual(["relation"]);
        expect(decisions.relation).toMatchObject({
          instructions: expect.stringContaining("contain exactly the same organisms"),
          criteria: { yes: expect.stringContaining("contain exactly the same organisms") },
        });
        return Effect.succeed({
          answers: {
            relation: {
              _tag: "Classify",
              label: "yes",
              probabilities: {
                yes: 1,
                no: 0,
                undetermined: 0,
                multipleLeft0: 0,
                multipleRight0: 0,
              },
            },
          },
          usage: { inputTokens: undefined, outputTokens: undefined },
        });
      },
    }),
  );
  return Effect.gen(function* () {
    expect(yield* TaxonSet.equivalent(set, set)).toEqual({ _tag: "Yes", relation: "equivalent" });
    expect(calls).toBe(1);
  }).pipe(Effect.provide(layer));
});

it.effect("asks proper subset directly, including unequal organism sets", () => {
  let calls = 0;
  const layer = Layer.effect(
    DecisionModel.DecisionModel,
    DecisionModel.make({
      decide: ({ decisions }) => {
        calls++;
        expect(Object.keys(decisions)).toEqual(["relation"]);
        expect(decisions.relation).toMatchObject({
          instructions: expect.stringContaining(
            "left organism set a proper subset of the complete right organism set",
          ),
          criteria: {
            yes: expect.stringContaining("Every organism in the left set belongs to the right set"),
          },
        });
        const question = decisions.relation;
        if (question?._tag !== "Classify") return Effect.die("Expected classification");
        expect(question.criteria.yes).toContain(
          "at least one organism in the right set is outside the left set",
        );
        return Effect.succeed({
          answers: {
            relation: {
              _tag: "Classify",
              label: "no",
              probabilities: { yes: 0, no: 1, undetermined: 0, multipleRight0: 0 },
            },
          },
          usage: { inputTokens: undefined, outputTokens: undefined },
        });
      },
    }),
  );
  return Effect.gen(function* () {
    expect(
      yield* TaxonSet.isProperSubsetOf(TaxonSet.empty(), TaxonSet.of(TaxonName.make("A"))),
    ).toEqual({ _tag: "No", relation: "proper-subset" });
    expect(calls).toBe(1);
  }).pipe(Effect.provide(layer));
});

it.effect(
  "asks one subset classification with complete encoded expressions and direct original-name choices",
  () => {
    let calls = 0;
    const left = TaxonSet.union(TaxonSet.of(TaxonName.make("A")), TaxonSet.of(TaxonName.make("B")));
    const right = TaxonSet.of(TaxonName.make("C"));
    const layer = Layer.effect(
      DecisionModel.DecisionModel,
      DecisionModel.make({
        decide: ({ state, decisions }) => {
          calls++;
          expect(state).toEqual({
            nodes: [
              { _tag: "Taxon", name: "A" },
              { _tag: "Taxon", name: "B" },
              { _tag: "Union", operands: [0, 1] },
              { _tag: "Taxon", name: "C" },
            ],
            left: 2,
            right: 3,
          });
          expect(Object.keys(decisions)).toEqual(["relation"]);
          expect(decisions.relation).toMatchObject({
            _tag: "Classify",
            instructions: expect.stringContaining(
              "left organism set a subset of the complete right organism set",
            ),
            criteria: {
              yes: expect.stringContaining(
                "Every organism in the left set also belongs to the right set",
              ),
              no: expect.stringContaining(
                "At least one organism in the left set does not belong to the right set",
              ),
              undetermined: expect.stringContaining("information is insufficient"),
              multipleLeft0: expect.stringContaining('left-set name "A"'),
              multipleLeft1: expect.stringContaining('left-set name "B"'),
              multipleRight0: expect.stringContaining('right-set name "C"'),
            },
          });
          const question = decisions.relation;
          if (question?._tag !== "Classify") return Effect.die("Expected classification");
          expect(question.criteria.yes).toContain("equality counts");
          for (const label of ["multipleLeft0", "multipleLeft1", "multipleRight0"]) {
            expect(question.criteria[label]).toContain(
              "jointly names distinct taxa, rather than one taxon",
            );
          }
          return Effect.succeed({
            answers: {
              relation: {
                _tag: "Classify",
                label: "yes",
                probabilities: Record.map(question.criteria, (_value, key) =>
                  key === "yes" ? 1 : 0,
                ),
              },
            },
            usage: { inputTokens: undefined, outputTokens: undefined },
          });
        },
      }),
    );
    return Effect.gen(function* () {
      expect(yield* TaxonSet.isSubsetOf(left, right)).toEqual({ _tag: "Yes", relation: "subset" });
      expect(calls).toBe(1);
    }).pipe(Effect.provide(layer));
  },
);
