// Checks transport of public expressions, not constructor semantics or biological truth.
import { expect, it } from "@effect/vitest";
import { Arbitrary, Array, Effect, Layer, Match, Option, Predicate, Record, Schema } from "effect";
import { DecisionModel } from "effect/ai";
import { TaxonName, TaxonSet } from "../src/index.ts";

// Registration needs these generators initialized; private functions are below the tests.
const operators = Schema.Literals([
  "Union",
  "Intersection",
  "Difference",
  "Complement",
  "SymmetricDifference",
]);
const constructions = Arbitrary.flatMap(Arbitrary.schema(bounded(6)), (extra) =>
  Arbitrary.flatMap(constructionSteps(extra + 1), (steps) =>
    Arbitrary.map(Arbitrary.schema(bounded(steps.length + 3)), (right) => ({ steps, right })),
  ),
);

it.effect.prop(
  "preserves public expression structure and object identity in the request",
  { construction: constructions },
  ({ construction }) =>
    Effect.gen(function* () {
      const roots = publicRoots(construction);
      const observed = yield* observeRequest(roots);
      expect(observed.calls).toBe(1);
      expectSameGraph(observed.wire, roots);
    }),
  { arbitrary: { runs: 150, seed: "G1-meaning-v1", maxShrinks: 100, size: 24 } },
);

it("rejects split sharing, merged equal objects and extra rows in a literal wire fixture", () => {
  const a = TaxonSet.of(TaxonName.make("A"));
  const roots = { left: TaxonSet.union(a, a), right: TaxonSet.of(TaxonName.make("A")) };
  // A legal topological order need not be the compiler's particular traversal order.
  const wire: Wire = {
    nodes: [
      { _tag: "Taxon", name: "A" },
      { _tag: "Taxon", name: "A" },
      { _tag: "Union", operands: [0, 0] },
    ],
    left: 2,
    right: 1,
  };
  expectSameGraph(wire, roots);
  expect(() => expectSameGraph({ ...wire, right: 0 }, roots)).toThrow();
  expect(() =>
    expectSameGraph(
      { ...wire, nodes: [...wire.nodes.slice(0, 2), { _tag: "Union", operands: [1, 0] }] },
      roots,
    ),
  ).toThrow();
  expect(() =>
    expectSameGraph({ ...wire, nodes: [...wire.nodes, { _tag: "Empty" }] }, roots),
  ).toThrow();
});

interface Step {
  readonly op: typeof operators.Type;
  readonly left: number;
  readonly right: number;
}
interface Construction {
  readonly steps: ReadonlyArray<Step>;
  readonly right: number;
}

function bounded(maximum: number) {
  return Schema.Natural.check(Schema.isLessThanOrEqualTo(maximum));
}

// Shorter constructions regenerate dependent references. Every step selects only
// earlier handles, including while shrinking; repeated indices preserve aliases.
function constructionSteps(length: number): Arbitrary.Arbitrary<ReadonlyArray<Step>> {
  return length === 0
    ? Arbitrary.Constant<ReadonlyArray<Step>>([])
    : Arbitrary.flatMap(constructionSteps(length - 1), (prior) =>
        Arbitrary.map(
          Arbitrary.schema(
            Schema.Struct({
              op: operators,
              left: bounded(prior.length + 3),
              right: bounded(prior.length + 3),
            }),
          ),
          (step) => [...prior, step],
        ),
      );
}

function at<A>(values: ReadonlyArray<A>, index: number): A {
  return Option.getOrThrowWith(
    Array.get(values, index),
    () => new Error(`Missing handle or wire ref ${index}`),
  );
}

// Build fresh public objects on every execution and shrink replay. At least one
// parent step keeps the left root nonliteral, even when its set meaning is empty.
function publicRoots(construction: Construction) {
  const handles = [
    TaxonSet.empty(),
    TaxonSet.of(TaxonName.make("A")),
    TaxonSet.of(TaxonName.make("A")),
    TaxonSet.of(TaxonName.make("B")),
  ];
  for (const step of construction.steps) {
    const left = at(handles, step.left);
    const right = at(handles, step.right);
    handles.push(
      Match.value(step.op).pipe(
        Match.when("Union", () => TaxonSet.union(left, right)),
        Match.when("Intersection", () => TaxonSet.intersection(left, right)),
        Match.when("Difference", () => TaxonSet.difference(left, right)),
        Match.when("Complement", () => TaxonSet.complement(left, right)),
        Match.when("SymmetricDifference", () => TaxonSet.symmetricDifference(left, right)),
        Match.exhaustive,
      ),
    );
  }
  return { left: at(handles, handles.length - 1), right: at(handles, construction.right) };
}

// Decode the provider boundary independently of the private production graph codec.
const rowSchema = Schema.TaggedUnion({
  Empty: {},
  Taxon: { name: Schema.String },
  Union: { operands: Schema.Array(Schema.Natural) },
  Intersection: { operands: Schema.Array(Schema.Natural) },
  Difference: { left: Schema.Natural, right: Schema.Natural },
});
const wireSchema = Schema.Struct({
  nodes: Schema.Array(rowSchema),
  left: Schema.Natural,
  right: Schema.Natural,
});
type Wire = typeof wireSchema.Type;

// Source edges come from the public objects, never from the received node table.
function sourceChildren(source: TaxonSet.TaxonSet): ReadonlyArray<TaxonSet.TaxonSet> {
  return Match.value(source).pipe(
    Match.tagsExhaustive({
      Empty: () => [],
      Taxon: () => [],
      Union: ({ operands }) => operands,
      Intersection: ({ operands }) => operands,
      Difference: ({ left, right }) => [left, right],
    }),
  );
}

const wireChildren = rowSchema.match({
  Empty: () => [],
  Taxon: () => [],
  Union: ({ operands }) => operands,
  Intersection: ({ operands }) => operands,
  Difference: ({ left, right }) => [left, right],
});

// Pair ordered roots and edges directly. Each reachable source object has one wire ref
// and vice versa, without predicting compiler row numbers.
function expectSameGraph(
  wire: Wire,
  roots: { readonly left: TaxonSet.TaxonSet; readonly right: TaxonSet.TaxonSet },
) {
  const forward = new Map<TaxonSet.TaxonSet, number>();
  const usedRefs = new Set<number>();
  const pending: Array<readonly [TaxonSet.TaxonSet, number]> = [
    [roots.left, wire.left],
    [roots.right, wire.right],
  ];
  while (pending.length > 0) {
    const pair = Option.getOrThrowWith(
      Option.fromUndefinedOr(pending.pop()),
      () => new Error("Missing source/wire pair"),
    );
    const [source, ref] = pair;
    if (forward.has(source)) {
      expect(forward.get(source)).toBe(ref);
      continue;
    }
    expect(usedRefs.has(ref)).toBe(false);
    forward.set(source, ref);
    usedRefs.add(ref);
    const row = at(wire.nodes, ref);
    expect(row._tag).toBe(source._tag);
    if (Predicate.isTagged(source, "Taxon") && rowSchema.guards.Taxon(row))
      expect(row.name).toBe(source.name);
    const expectedChildren = sourceChildren(source);
    const actualChildren = wireChildren(row);
    expect(actualChildren).toHaveLength(expectedChildren.length);
    expectedChildren.forEach((child, index) => {
      const childRef = at(actualChildren, index);
      expect(childRef).toBeLessThan(ref);
      pending.push([child, childRef]);
    });
  }
  // Every visited ref exists, is unique, and is reachable; equal sizes exclude extra rows.
  expect(usedRefs.size).toBe(wire.nodes.length);
}

// Each execution owns its observer and real DecisionModel adapter. Its canned
// answer has no set calculator or name-selection oracle behind it.
const observeRequest = Effect.fnUntraced(function* (roots: {
  readonly left: TaxonSet.TaxonSet;
  readonly right: TaxonSet.TaxonSet;
}) {
  let calls = 0;
  const requests: Wire[] = [];
  const layer = Layer.effect(
    DecisionModel.DecisionModel,
    DecisionModel.make({
      decide: Effect.fnUntraced(function* ({ state, decisions }) {
        calls++;
        const wire = yield* Schema.decodeUnknownEffect(wireSchema)(state).pipe(Effect.orDie);
        requests.push(wire);
        const question = Option.getOrThrow(Record.get(decisions, "relation"));
        if (!Predicate.isTagged(question, "Classify"))
          return yield* Effect.die("Expected classification");
        return {
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
        };
      }),
    }),
  );
  yield* TaxonSet.equivalent(roots.left, roots.right).pipe(Effect.provide(layer));
  return { wire: at(requests, 0), calls };
});
