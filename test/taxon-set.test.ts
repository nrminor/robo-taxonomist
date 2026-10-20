import { expect, it } from "@effect/vitest";
import {
  Array,
  Cause,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Iterable,
  Layer,
  MutableRef,
  Option,
  Predicate,
  Record,
  String,
} from "effect";
import { AiError, Decision, DecisionModel } from "effect/ai";
import { AcceptancePolicy, TaxonName, TaxonSet } from "../src/index.ts";

function relationQuestion(decisions: Readonly<Record<string, Decision.Any>>) {
  const question = Option.getOrThrow(Record.get(decisions, "relation"));
  if (!Predicate.isTagged(question, "Classify")) throw new Error("Expected classification");
  return question;
}

it("preserves syntax with fresh parents and shared readonly children", () => {
  const oak = TaxonSet.of(TaxonName.make("Quercus"));
  const beech = TaxonSet.of(TaxonName.make("Fagus"));
  const first = TaxonSet.union(oak, beech);
  const second = TaxonSet.union(oak, beech);
  expect(first).toEqual({ _tag: "Union", operands: [oak, beech] });
  expect(first).not.toBe(second);
  if (!Predicate.isTagged(first, "Union") || !Predicate.isTagged(second, "Union"))
    throw new Error("Expected unions");
  expect(first.operands).not.toBe(second.operands);
  expect(first.operands[0]).toBe(oak);
  expect(first.operands[1]).toBe(beech);
  const remaining = TaxonSet.difference(first, oak);
  if (!Predicate.isTagged(remaining, "Difference")) throw new Error("Expected difference");
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
  if (
    !Predicate.isTagged(intersection, "Intersection") ||
    !Predicate.isTagged(another, "Intersection")
  )
    throw new Error("Expected intersections");
  expect(intersection.operands).toEqual([a, none]);
  expect(intersection.operands[0]).toBe(a);
  expect(intersection.operands[1]).toBe(none);
  expect(intersection.operands).not.toBe(another.operands);
  expect(intersection).not.toBe(another);
  const complement = TaxonSet.complement(a, b);
  expect(complement).toEqual({ _tag: "Difference", left: b, right: a });
  if (!Predicate.isTagged(complement, "Difference")) throw new Error("Expected difference");
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
  ["subset", TaxonSet.isSubsetOf, "Yes", "No", "properSubset", "disjoint"],
  ["proper-subset", TaxonSet.isProperSubsetOf, "Yes", "No", "properSubset", "equal"],
  ["equivalent", TaxonSet.equivalent, "Yes", "No", "equal", "properSubset"],
  ["overlap", TaxonSet.overlaps, "Yes", "No", "partialOverlap", "disjoint"],
  ["disjoint", TaxonSet.disjoint, "No", "Yes", "partialOverlap", "disjoint"],
] as const;

// Literal provider protocol, independent of production criteria and projection tables.
const baseRelationLabels = [
  "equal",
  "properSubset",
  "properSuperset",
  "partialOverlap",
  "disjoint",
  "bothEmpty",
  "leftEmpty",
  "rightEmpty",
  "undetermined",
] as const;

function relationProbabilities(
  probabilities: Readonly<Record<string, number>>,
  diagnoses: Readonly<Record<string, number>> = { multipleLeft0: 0, multipleRight0: 0 },
) {
  return {
    equal: 0,
    properSubset: 0,
    properSuperset: 0,
    partialOverlap: 0,
    disjoint: 0,
    bothEmpty: 0,
    leftEmpty: 0,
    rightEmpty: 0,
    undetermined: 0,
    ...diagnoses,
    ...probabilities,
  };
}

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
          const question = relationQuestion(decisions);
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

it.effect.each([
  ["equal", ["Yes", "No", "Yes", "Yes", "No"]],
  ["properSubset", ["Yes", "Yes", "No", "Yes", "No"]],
  ["properSuperset", ["No", "No", "No", "Yes", "No"]],
  ["partialOverlap", ["No", "No", "No", "Yes", "No"]],
  ["disjoint", ["No", "No", "No", "No", "Yes"]],
  ["bothEmpty", ["Yes", "No", "Yes", "No", "Yes"]],
  ["leftEmpty", ["Yes", "Yes", "No", "No", "Yes"]],
  ["rightEmpty", ["No", "No", "No", "No", "Yes"]],
] as const)("projects the model's %s answer for nonliteral expressions", ([label, expected]) =>
  Effect.gen(function* () {
    const left = TaxonSet.union(TaxonSet.of(TaxonName.make("A")), TaxonSet.empty());
    const right = TaxonSet.union(TaxonSet.of(TaxonName.make("B")), TaxonSet.empty());
    for (const [index, [relation, operation]] of operations.entries()) {
      expect(yield* operation(left, right)).toEqual({
        _tag: Array.getUnsafe(expected, index),
        relation,
      });
    }
  }).pipe(
    Effect.provide(
      relationLayer({
        _tag: "Classify",
        label,
        probabilities: relationProbabilities({ [label]: 1 }),
      }),
    ),
  ),
);

it.effect.each([
  ["Yes", "disjoint", { equal: 0.3, properSubset: 0.3, disjoint: 0.35, undetermined: 0.05 }],
  ["No", "equal", { equal: 0.35, properSuperset: 0.3, partialOverlap: 0.3, undetermined: 0.05 }],
] as const)(
  "accepts grouped subset support for %s despite a different selected label",
  ([_tag, label, probabilities]) =>
    Effect.gen(function* () {
      expect(
        yield* TaxonSet.isSubsetOf(
          TaxonSet.of(TaxonName.make("A")),
          TaxonSet.of(TaxonName.make("B")),
        ),
      ).toEqual({ _tag, relation: "subset" });
    }).pipe(
      Effect.provide(
        relationLayer({
          _tag: "Classify",
          label,
          probabilities: relationProbabilities(probabilities),
        }),
      ),
    ),
);

it.effect("keeps a grouped probability tie unresolved", () =>
  Effect.gen(function* () {
    expect(
      yield* TaxonSet.isSubsetOf(
        TaxonSet.of(TaxonName.make("A")),
        TaxonSet.of(TaxonName.make("B")),
      ),
    ).toEqual({ _tag: "Undetermined", relation: "subset" });
  }).pipe(
    Effect.provide(
      relationLayer({
        _tag: "Classify",
        label: "properSuperset",
        probabilities: relationProbabilities({
          equal: 0.1,
          properSubset: 0.2,
          bothEmpty: 0.15,
          leftEmpty: 0.05,
          properSuperset: 0.5,
        }),
      }),
    ),
  ),
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
              { _tag: "Union", operands: [1, 1] },
              { _tag: "Taxon", name: "A" },
              { _tag: "Intersection", operands: [3, 4] },
              { _tag: "Taxon", name: "B" },
              { _tag: "Difference", left: 0, right: 5 },
              { _tag: "Taxon", name: "A" },
            ],
            left: 0,
            right: 2,
          });
          const question = relationQuestion(decisions);
          expect(Record.keys(question.criteria)).toEqual([
            ...baseRelationLabels,
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

it.effect("keeps a shared DAG compact with bounded source-name reads", () => {
  const name = TaxonName.make("A");
  const leaf = TaxonSet.of(name);
  const expression = Iterable.reduce(Iterable.range(1, 12), leaf, (previous) =>
    TaxonSet.union(previous, previous),
  );
  const leafReads = MutableRef.make(0);
  // Observe preparation, not construction; every read returns the original valid name.
  Object.defineProperty(leaf, "name", {
    enumerable: true,
    configurable: true,
    get: () => {
      MutableRef.increment(leafReads);
      return name;
    },
  });
  const layer = Layer.effect(
    DecisionModel.DecisionModel,
    DecisionModel.make({
      decide: ({ state, decisions }) => {
        // One taxon plus twelve distinct unions, shared by both roots.
        expect(state).toHaveProperty("nodes.length", 13);
        expect(state).toMatchObject({ left: 0, right: 0 });
        expect(state).toHaveProperty("nodes.0", { _tag: "Union", operands: [1, 1] });
        expect(state).toHaveProperty("nodes.11", { _tag: "Union", operands: [12, 12] });
        expect(state).toHaveProperty("nodes.12", { _tag: "Taxon", name: "A" });
        const question = relationQuestion(decisions);
        return Effect.succeed({
          answers: {
            relation: {
              _tag: "Classify",
              label: "equal",
              probabilities: Record.map(question.criteria, (_value, key) =>
                key === "equal" ? 1 : 0,
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
    expect(MutableRef.get(leafReads)).toBeLessThanOrEqual(64);
  }).pipe(Effect.provide(layer));
});

// Deliberate mutation bypasses public constructors to exercise malformed nominal graphs.
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

it.effect("accepts an Effect-rescaled set answer despite zero confidence", () => {
  const layer = Layer.effect(
    DecisionModel.DecisionModel,
    DecisionModel.make({
      probabilityPrecision: 1,
      decide: () =>
        Effect.succeed({
          answers: {
            relation: {
              _tag: "Classify",
              label: "properSubset",
              confidence: 0,
              probabilities: relationProbabilities({ properSubset: 0.6, disjoint: 0.3 }),
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
        policy: AcceptancePolicy.make({ minimumSupport: 0.65, minimumMargin: 0.3 }),
      }),
    ).toEqual({ _tag: "Yes", relation: "subset" });
  }).pipe(Effect.provide(layer));
});

for (const [relation, operation, yesTag, noTag, yesLabel, noLabel] of operations) {
  it.effect.each([
    [yesLabel, { _tag: yesTag, relation }],
    [noLabel, { _tag: noTag, relation }],
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
              probabilities: relationProbabilities({ [label]: 1 }),
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
          const question = relationQuestion(decisions);
          expect(Record.keys(question.criteria)).toEqual([
            ...baseRelationLabels,
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
                probabilities: relationProbabilities(
                  { multipleRight1: 1 },
                  { multipleLeft0: 0, multipleLeft1: 0, multipleRight0: 0, multipleRight1: 0 },
                ),
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
        const question = relationQuestion(decisions);
        expect(Record.keys(decisions)).toEqual(["relation"]);
        if (seen.length === 5) expect(Record.keys(question.criteria)).toEqual(baseRelationLabels);
        return Effect.succeed({
          answers: {
            relation: {
              _tag: "Classify",
              label: seen.length === 4 ? "properSubset" : "equal",
              probabilities: Record.map(question.criteria, (_value, key) =>
                key === (seen.length === 4 ? "properSubset" : "equal") ? 1 : 0,
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
      nodes: [{ _tag: "Union", operands: [1, 1] }, { _tag: "Empty" }],
      left: 0,
      right: 0,
    });
  }).pipe(Effect.provide(layer));
});

for (const [relation, operation, yesTag, , yesLabel, noLabel] of operations) {
  it.effect.each([
    [
      "weak",
      yesLabel,
      { [yesLabel]: 0.4, [noLabel]: 0.3, undetermined: 0.3 },
      0.5,
      0,
      "Undetermined",
    ],
    ["tied", "multipleLeft0", { multipleLeft0: 0.5, [yesLabel]: 0.5 }, 0, 0, "Undetermined"],
    ["nonleading provider selection", noLabel, { [yesLabel]: 0.6, [noLabel]: 0.4 }, 0, 0, yesTag],
    [
      "nonleading uncertain selection",
      "undetermined",
      { [yesLabel]: 0.9, undetermined: 0.1 },
      0,
      0,
      yesTag,
    ],
    [
      "split diagnoses not summed",
      "multipleLeft0",
      { multipleLeft0: 0.4, multipleRight0: 0.35, [yesLabel]: 0.25 },
      0.5,
      0,
      "Undetermined",
    ],
    [
      "exact support",
      yesLabel,
      { [yesLabel]: 0.6, [noLabel]: 0.4 },
      0.6000000000000001,
      0,
      "Undetermined",
    ],
    [
      "beyond epsilon",
      yesLabel,
      { [yesLabel]: 0.6, [noLabel]: 0.4 },
      0.6,
      0.2000000000000003,
      "Undetermined",
    ],
  ] as const)(
    `applies ${relation} policy: %s`,
    ([_case, label, probabilities, minimumSupport, minimumMargin, expectedTag]) =>
      Effect.gen(function* () {
        const a = TaxonSet.of(TaxonName.make("A"));
        const b = TaxonSet.of(TaxonName.make("B"));
        expect(
          yield* operation(a, b, {
            policy: AcceptancePolicy.make({ minimumSupport, minimumMargin }),
          }).pipe(
            Effect.provide(
              relationLayer({
                _tag: "Classify",
                label,
                probabilities: relationProbabilities(probabilities),
              }),
            ),
          ),
        ).toEqual({ _tag: expectedTag, relation });
      }),
  );
  it.effect(`accepts ${relation} exact support and margin boundary`, () =>
    Effect.gen(function* () {
      const a = TaxonSet.of(TaxonName.make("A"));
      const b = TaxonSet.of(TaxonName.make("B"));
      expect(
        yield* operation(a, b, {
          policy: AcceptancePolicy.make({ minimumSupport: 0.6, minimumMargin: 0.2 }),
        }).pipe(
          Effect.provide(
            relationLayer({
              _tag: "Classify",
              label: "multipleRight0",
              probabilities: relationProbabilities({ [yesLabel]: 0.4, multipleRight0: 0.6 }),
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
        const question = relationQuestion(decisions);
        seen.push(Record.keys(question.criteria));
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
    expect(
      Array.sort(
        Iterable.map(seen, (keys) => keys.join(",")),
        String.Order,
      ),
    ).toEqual(
      Array.sort(
        Iterable.map(
          [
            [...baseRelationLabels, "multipleLeft0", "multipleRight0"],
            [...baseRelationLabels, "multipleLeft0", "multipleLeft1"],
            [...baseRelationLabels, "multipleLeft0", "multipleRight0"],
          ],
          (keys) => keys.join(","),
        ),
        String.Order,
      ),
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

it.effect.each(operations)("rejects a missing answer for %s", ([_relation, operation]) =>
  Effect.gen(function* () {
    const a = TaxonSet.of(TaxonName.make("A"));
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
    expect((yield* Effect.flip(operation(a, a).pipe(Effect.provide(layer)))).reason._tag).toBe(
      "InvalidOutputError",
    );
  }),
);

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
    const cause = Option.getOrThrow(Exit.getCause(exit));
    expect(cause.reasons).toHaveLength(1);
    expect(
      Array.fromIterable(
        Iterable.map(Iterable.filter(cause.reasons, Cause.isDieReason), (reason) => reason.defect),
      ),
    ).toEqual([defect]);
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
        expect(Record.keys(decisions)).toEqual(["relation"]);
        return Effect.succeed({
          answers: {
            relation: {
              _tag: "Classify",
              label: "partialOverlap",
              probabilities: relationProbabilities({ partialOverlap: 1 }),
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
        expect(Record.keys(decisions)).toEqual(["relation"]);
        expect(decisions.relation).toMatchObject({
          criteria: {
            partialOverlap: expect.any(globalThis.String),
            disjoint: expect.any(globalThis.String),
          },
        });
        return Effect.succeed({
          answers: {
            relation: {
              _tag: "Classify",
              label: "disjoint",
              probabilities: relationProbabilities({ disjoint: 1 }),
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
        expect(Record.keys(decisions)).toEqual(["relation"]);
        expect(decisions.relation).toMatchObject({
          criteria: { equal: expect.any(globalThis.String) },
        });
        return Effect.succeed({
          answers: {
            relation: {
              _tag: "Classify",
              label: "equal",
              probabilities: relationProbabilities({ equal: 1 }),
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
        expect(Record.keys(decisions)).toEqual(["relation"]);
        expect(decisions.relation).toMatchObject({
          criteria: {
            properSubset: expect.any(globalThis.String),
            leftEmpty: expect.any(globalThis.String),
          },
        });
        return Effect.succeed({
          answers: {
            relation: {
              _tag: "Classify",
              label: "equal",
              probabilities: relationProbabilities({ equal: 1 }, { multipleRight0: 0 }),
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
              { _tag: "Union", operands: [1, 2] },
              { _tag: "Taxon", name: "A" },
              { _tag: "Taxon", name: "B" },
              { _tag: "Taxon", name: "C" },
            ],
            left: 0,
            right: 3,
          });
          expect(Record.keys(decisions)).toEqual(["relation"]);
          expect(decisions.relation).toMatchObject({
            _tag: "Classify",
            criteria: {
              equal: expect.any(globalThis.String),
              properSubset: expect.any(globalThis.String),
              disjoint: expect.any(globalThis.String),
              undetermined: expect.any(globalThis.String),
              multipleLeft0: expect.stringContaining('left-set name "A"'),
              multipleLeft1: expect.stringContaining('left-set name "B"'),
              multipleRight0: expect.stringContaining('right-set name "C"'),
            },
          });
          const question = relationQuestion(decisions);
          return Effect.succeed({
            answers: {
              relation: {
                _tag: "Classify",
                label: "properSubset",
                probabilities: Record.map(question.criteria, (_value, key) =>
                  key === "properSubset" ? 1 : 0,
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
