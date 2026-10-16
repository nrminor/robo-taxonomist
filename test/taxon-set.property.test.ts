// Checks public set transport and original-name diagnosis, not biological truth.
// Expected bitmasks and observed Set arithmetic calculate membership independently.
import { expect, it } from "@effect/vitest";
import { Arbitrary, Effect, Layer, Record, Schema } from "effect";
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
const answerModes = Schema.Literals(["meaning", "left", "right"]);
const constructions = Arbitrary.flatMap(Arbitrary.schema(bounded(6)), (extra) =>
  Arbitrary.flatMap(constructionSteps(extra + 1), (steps) =>
    Arbitrary.map(
      Arbitrary.schema(
        Schema.Struct({
          masks: Schema.Struct({ A: bounded(255), B: bounded(255) }),
          right: bounded(steps.length + 3),
        }),
      ),
      (rest) => ({ ...rest, steps }),
    ),
  ),
);

it.effect.prop(
  "keeps set members, shared nodes and original name choices in the public request",
  { construction: constructions, mode: answerModes },
  ({ construction, mode }) =>
    Effect.gen(function* () {
      const expected = expectedComparison(construction, mode);
      const observed = yield* observeSetComparison(construction, expected.nameChoice);
      expect(observed.meaning).toEqual(expected.meaning);
      expectSameGraphIdentity(observed.wire, expected.construction);
      expect(observed.names).toEqual(expected.names);
      expect(observed.nameCounts).toEqual({
        left: expected.names.left.size,
        right: expected.names.right.size,
      });
      expect(observed.result).toEqual(expected.result);
      expect(observed.calls).toBe(1);
    }),
  { arbitrary: { runs: 150, seed: "G1-meaning-v1", maxShrinks: 100, size: 24 } },
);

it.effect("keeps an empty result empty after subtracting overlapping sets", () =>
  Effect.gen(function* () {
    const expected = expectedComparison(emptyAfterDifference);
    const observed = yield* observeSetComparison(emptyAfterDifference);
    expect(observed.meaning).toEqual(expected.meaning);
    expectSameGraphIdentity(observed.wire, expected.construction);
    expect(observed.names).toEqual(expected.names);
    expect(observed.nameCounts).toEqual({
      left: expected.names.left.size,
      right: expected.names.right.size,
    });
    expect(observed.result).toEqual(expected.result);
    expect(observed.calls).toBe(1);
  }),
);

it.effect("can diagnose an original left name even when its members cancel out", () =>
  Effect.gen(function* () {
    const expected = expectedComparison(cancelledNamesWithSharedNodes, "left");
    const observed = yield* observeSetComparison(
      cancelledNamesWithSharedNodes,
      expected.nameChoice,
    );
    expect(observed.meaning).toEqual(expected.meaning);
    expectSameGraphIdentity(observed.wire, expected.construction);
    expect(observed.names).toEqual(expected.names);
    expect(observed.nameCounts).toEqual({
      left: expected.names.left.size,
      right: expected.names.right.size,
    });
    expect(observed.result).toEqual(expected.result);
    expect(observed.calls).toBe(1);
  }),
);

it("checks both independent set calculators against literal member answers", () => {
  const actual = evaluateWire(
    {
      nodes: [
        { _tag: "Taxon", name: "A" },
        { _tag: "Taxon", name: "B" },
        { _tag: "Difference", left: 0, right: 1 },
        { _tag: "Intersection", operands: [0, 1] },
      ],
      left: 2,
      right: 3,
    },
    { A: 3, B: 6 },
  );
  expect(actual.left).toEqual(new Set([0]));
  expect(actual.right).toEqual(new Set([1]));
  const source = expectedConstruction({
    masks: { A: 3, B: 6 },
    steps: [{ op: "Difference", left: 1, right: 3 }],
    right: 0,
  });
  expect(at(source.sources, source.left).mask).toBe(1);
});

// Handles start with empty, A, a distinct A, B; each step adds one handle.
const emptyAfterDifference: Construction = {
  masks: { A: 3, B: 6 },
  steps: [
    { op: "Difference", left: 1, right: 3 },
    { op: "Intersection", left: 4, right: 3 },
  ],
  right: 0,
};
const cancelledNamesWithSharedNodes: Construction = {
  masks: { A: 3, B: 6 },
  steps: [
    { op: "Union", left: 1, right: 1 },
    { op: "Intersection", left: 4, right: 2 },
    { op: "Difference", left: 5, right: 3 },
    { op: "Complement", left: 6, right: 3 },
    { op: "SymmetricDifference", left: 7, right: 4 },
    { op: "Union", left: 8, right: 0 },
    { op: "Difference", left: 9, right: 9 },
  ],
  right: 4,
};

// Legal construction descriptions and shrinking.
interface Step {
  readonly op: typeof operators.Type;
  readonly left: number;
  readonly right: number;
}
interface Construction {
  readonly masks: { readonly A: number; readonly B: number };
  readonly steps: ReadonlyArray<Step>;
  readonly right: number;
}

function bounded(maximum: number) {
  return Schema.Natural.check(Schema.isLessThanOrEqualTo(maximum));
}

// Shorter constructions regenerate dependent references. Each step can only
// select earlier handles, including while shrinking, so every replay stays legal.
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

// Construction expectations: bitmasks, identity and original names, without
// reading the public graph. Equal leaves retain distinct construction IDs.
type ConstructionRow =
  | { readonly _tag: "Empty" }
  | { readonly _tag: "Taxon"; readonly name: "A" | "B" }
  | { readonly _tag: "Union" | "Intersection"; readonly operands: ReadonlyArray<number> }
  | { readonly _tag: "Difference"; readonly left: number; readonly right: number };

interface Source {
  readonly row: ConstructionRow;
  readonly mask: number;
  readonly reachable: ReadonlySet<number>;
  readonly names: ReadonlySet<string>;
}

function at<A>(values: ReadonlyArray<A>, id: number): A {
  const value = values[id];
  if (value === undefined) throw new Error(`Missing construction ID or wire ref ${id}`);
  return value;
}

function children(row: ConstructionRow): ReadonlyArray<number> {
  switch (row._tag) {
    case "Empty":
    case "Taxon":
      return [];
    case "Difference":
      return [row.left, row.right];
    default:
      return row.operands;
  }
}

function atoms(mask: number) {
  return new Set(
    Array.from({ length: 8 }, (_, atom) => atom).filter((atom) => (mask & (1 << atom)) !== 0),
  );
}

function expectedConstruction(construction: Construction) {
  const sources: Source[] = [];
  const add = (row: ConstructionRow, mask: number) => {
    const id = sources.length;
    const inputs = children(row).map((child) => at(sources, child));
    sources.push({
      row,
      mask,
      reachable: new Set([id, ...inputs.flatMap((input) => [...input.reachable])]),
      names: new Set([
        ...(row._tag === "Taxon" ? [row.name] : []),
        ...inputs.flatMap((input) => [...input.names]),
      ]),
    });
    return id;
  };
  add({ _tag: "Empty" }, 0);
  for (const name of ["A", "A", "B"] satisfies ReadonlyArray<"A" | "B">) {
    add({ _tag: "Taxon", name }, construction.masks[name]);
  }
  const handles = [0, 1, 2, 3];
  for (const step of construction.steps) {
    const left = at(handles, step.left);
    const right = at(handles, step.right);
    const leftMask = at(sources, left).mask;
    const rightMask = at(sources, right).mask;
    let result: number;
    switch (step.op) {
      case "Union":
        result = add({ _tag: "Union", operands: [left, right] }, leftMask | rightMask);
        break;
      case "Intersection":
        result = add({ _tag: "Intersection", operands: [left, right] }, leftMask & rightMask);
        break;
      case "Difference":
        result = add({ _tag: "Difference", left, right }, leftMask & ~rightMask);
        break;
      case "Complement":
        result = add({ _tag: "Difference", left: right, right: left }, rightMask & ~leftMask);
        break;
      case "SymmetricDifference": {
        const forward = add({ _tag: "Difference", left, right }, leftMask & ~rightMask);
        const reverse = add(
          { _tag: "Difference", left: right, right: left },
          rightMask & ~leftMask,
        );
        result = add({ _tag: "Union", operands: [forward, reverse] }, leftMask ^ rightMask);
        break;
      }
    }
    handles.push(result);
  }
  return { sources, left: sources.length - 1, right: at(handles, construction.right) };
}

function expectedComparison(description: Construction, mode: typeof answerModes.Type = "meaning") {
  const construction = expectedConstruction(description);
  const left = at(construction.sources, construction.left);
  const right = at(construction.sources, construction.right);
  const selectedName =
    mode === "meaning" ? undefined : [...(mode === "left" ? left.names : right.names)].sort()[0];
  const nameChoice =
    mode === "meaning" || selectedName === undefined
      ? undefined
      : { side: mode, name: selectedName };
  return {
    construction,
    meaning: { left: atoms(left.mask), right: atoms(right.mask) },
    names: { left: left.names, right: right.names },
    nameChoice,
    result:
      nameChoice === undefined
        ? { _tag: left.mask === right.mask ? "Yes" : "No", relation: "equivalent" }
        : {
            _tag: "MultipleTaxaInSetName",
            relation: "equivalent",
            side: nameChoice.side,
            taxonName: nameChoice.name,
          },
  };
}

// Decode and evaluate the public request with ordinary Sets, not mask operations.
const rowSchema = Schema.TaggedUnion({
  Empty: {},
  Taxon: { name: Schema.Literals(["A", "B"]) },
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

// Every edge must point backwards; empty intersections and missing references
// are malformed requests, not empty sets.
function evaluateWire(wire: Wire, masks: Construction["masks"]) {
  const meanings: Set<number>[] = [];
  for (const [ref, row] of wire.nodes.entries()) {
    for (const child of children(row)) expect(child).toBeLessThan(ref);
    switch (row._tag) {
      case "Empty":
        meanings.push(new Set());
        break;
      case "Taxon":
        meanings.push(atoms(masks[row.name]));
        break;
      case "Union":
        meanings.push(new Set(row.operands.flatMap((child) => [...at(meanings, child)])));
        break;
      case "Intersection": {
        const [first, ...rest] = row.operands;
        if (first === undefined) throw new Error("Expected nonempty intersection");
        meanings.push(
          new Set(
            [...at(meanings, first)].filter((atom) =>
              rest.every((child) => at(meanings, child).has(atom)),
            ),
          ),
        );
        break;
      }
      case "Difference":
        meanings.push(
          new Set([...at(meanings, row.left)].filter((atom) => !at(meanings, row.right).has(atom))),
        );
        break;
    }
  }
  return { left: at(meanings, wire.left), right: at(meanings, wire.right) };
}

// Pair ordered edges, not row numbers: preserve sharing without merging distinct
// equal nodes, and require exactly the construction's reachable inventory.
function expectSameGraphIdentity(wire: Wire, source: ReturnType<typeof expectedConstruction>) {
  const forward = new Map<number, number>();
  const reverse = new Map<number, number>();
  const pending = [
    [source.left, wire.left],
    [source.right, wire.right],
  ];
  while (pending.length > 0) {
    const pair = pending.pop();
    if (pair === undefined) throw new Error("Missing pair");
    const id = at(pair, 0);
    const ref = at(pair, 1);
    if (forward.has(id)) {
      expect(forward.get(id)).toBe(ref);
      continue;
    }
    expect(reverse.has(ref)).toBe(false);
    forward.set(id, ref);
    reverse.set(ref, id);
    const expected = at(source.sources, id).row;
    const actual = at(wire.nodes, ref);
    expect(actual._tag).toBe(expected._tag);
    if (expected._tag === "Taxon") expect(actual).toEqual(expected);
    const expectedChildren = children(expected);
    const actualChildren = children(actual);
    expect(actualChildren).toHaveLength(expectedChildren.length);
    expectedChildren.forEach((child, index) => pending.push([child, at(actualChildren, index)]));
  }
  const reachable = new Set([
    ...at(source.sources, source.left).reachable,
    ...at(source.sources, source.right).reachable,
  ]);
  expect(new Set(forward.keys())).toEqual(reachable);
  expect(wire.nodes).toHaveLength(reachable.size);
  expect(reverse.size).toBe(wire.nodes.length);
}

// Fresh public values and a fresh provider for each run, including shrink replays.
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
    switch (step.op) {
      case "Union":
        handles.push(TaxonSet.union(left, right));
        break;
      case "Intersection":
        handles.push(TaxonSet.intersection(left, right));
        break;
      case "Difference":
        handles.push(TaxonSet.difference(left, right));
        break;
      case "Complement":
        handles.push(TaxonSet.complement(left, right));
        break;
      case "SymmetricDifference": {
        const value = TaxonSet.symmetricDifference(left, right);
        if (value._tag !== "Union") throw new Error("Expected symmetric difference union");
        handles.push(value);
        break;
      }
    }
  }
  return { left: at(handles, handles.length - 1), right: at(handles, construction.right) };
}

function originalNameLabels(criteria: { readonly [label: string]: string }) {
  const labels = { left: new Map<string, string>(), right: new Map<string, string>() };
  const names = { left: new Set<string>(), right: new Set<string>() };
  const counts = { left: 0, right: 0 };
  // Match criterion text without depending on numeric label indices or traversal order.
  for (const side of ["left", "right"] satisfies ReadonlyArray<"left" | "right">) {
    const prefix = side === "left" ? "multipleLeft" : "multipleRight";
    for (const [label, criterion] of Object.entries(criteria)) {
      if (!label.startsWith(prefix)) continue;
      const name = ["A", "B"].find((name) => criterion.includes(`${side}-set name "${name}"`));
      if (name === undefined) throw new Error("Unrecognized original name");
      counts[side]++;
      names[side].add(name);
      labels[side].set(name, label);
    }
  }
  return { labels, names, counts };
}

// The provider answers from decoded Set meaning or an original-name choice;
// expected masks and construction inventory do not decide its equivalence answer.
const observeSetComparison = Effect.fnUntraced(function* (
  construction: Construction,
  choice?: { readonly side: "left" | "right"; readonly name: string },
) {
  const roots = publicRoots(construction);
  const requests: Array<{
    readonly wire: Wire;
    readonly meaning: ReturnType<typeof evaluateWire>;
    readonly names: ReturnType<typeof originalNameLabels>["names"];
    readonly nameCounts: ReturnType<typeof originalNameLabels>["counts"];
  }> = [];
  const layer = Layer.effect(
    DecisionModel.DecisionModel,
    DecisionModel.make({
      decide: ({ state, decisions }) =>
        Effect.gen(function* () {
          const wire = yield* Schema.decodeUnknownEffect(wireSchema)(state).pipe(Effect.orDie);
          const meaning = evaluateWire(wire, construction.masks);
          const question = decisions.relation;
          if (question?._tag !== "Classify") return yield* Effect.die("Expected classification");
          const inventory = originalNameLabels(question.criteria);
          requests.push({ wire, meaning, names: inventory.names, nameCounts: inventory.counts });
          const diagnosisLabel =
            choice === undefined ? undefined : inventory.labels[choice.side].get(choice.name);
          if (choice !== undefined && diagnosisLabel === undefined)
            return yield* Effect.die("Missing diagnosis choice");
          const equal =
            meaning.left.size === meaning.right.size &&
            [...meaning.left].every((atom) => meaning.right.has(atom));
          const label = diagnosisLabel ?? (equal ? "yes" : "no");
          return {
            answers: {
              relation: {
                _tag: "Classify",
                label,
                probabilities: Record.map(question.criteria, (_value, key) =>
                  key === label ? 1 : 0,
                ),
              },
            },
            usage: { inputTokens: undefined, outputTokens: undefined },
          };
        }),
    }),
  );
  const result = yield* TaxonSet.equivalent(roots.left, roots.right).pipe(Effect.provide(layer));
  return { ...at(requests, 0), result, calls: requests.length };
});
