import { Array, Effect, Exit, Option, Schema } from "effect";
import { AiError } from "effect/ai";
import { TaxonName, taxonSetSchema } from "./schemas.ts";

type Expression = typeof taxonSetSchema.Type;

const fields = Schema.Union([
  Schema.Struct(taxonSetSchema.cases.Empty.fields),
  Schema.Struct(taxonSetSchema.cases.Taxon.fields),
  Schema.Struct(taxonSetSchema.cases.Union.fields),
  Schema.Struct(taxonSetSchema.cases.Intersection.fields),
  Schema.Struct(taxonSetSchema.cases.Difference.fields),
]);
// Check nominal acceptance, then own fields and immediate nominal children only.
const sourceNodeSchema = Schema.toType(taxonSetSchema).pipe(Schema.decodeTo(Schema.toType(fields)));
const nodeRef = Schema.Natural;
const nodeSchema = Schema.TaggedUnion({
  Empty: {},
  Taxon: { name: TaxonName },
  Union: { operands: Schema.NonEmptyArray(nodeRef) },
  Intersection: { operands: Schema.NonEmptyArray(nodeRef) },
  Difference: { left: nodeRef, right: nodeRef },
});
type Node = typeof nodeSchema.Type;

/**
 * Collects exact names from a validated table in one root's expression order.
 * Each call visits shared nodes once and keeps its own name order, independent
 * of other roots and the table's row order.
 */
export const collectTaxonNames = (nodes: readonly Node[], root: number): readonly TaxonName[] => {
  const stack = [root];
  const visited = new Set<number>();
  const names = new Set<TaxonName>();
  while (stack.length > 0) {
    const ref = Option.fromUndefinedOr(stack.pop()).pipe(Option.getOrThrow);
    if (visited.has(ref)) continue;
    visited.add(ref);
    const node = Array.get(nodes, ref).pipe(Option.getOrThrow);
    switch (node._tag) {
      case "Empty":
        break;
      case "Taxon":
        names.add(node.name);
        break;
      case "Union":
      case "Intersection":
        for (let index = node.operands.length - 1; index >= 0; index--) {
          stack.push(Array.get(node.operands, index).pipe(Option.getOrThrow));
        }
        break;
      case "Difference":
        stack.push(node.right, node.left);
        break;
    }
  }
  return [...names];
};

export const membershipTargetSchema = Schema.Struct({
  nodes: Schema.Array(nodeSchema),
  target: nodeRef,
});
export const relationInputSchema = Schema.Struct({
  nodes: Schema.Array(nodeSchema),
  left: nodeRef,
  right: nodeRef,
});
export const instructions =
  "References index nodes; roots select the complete sets. Empty contains no organisms; " +
  "Taxon contains organisms belonging to name; Union combines operands; Intersection keeps their shared organisms; " +
  "Difference keeps left organisms outside right. Node identity is not biological identity.";

type Compiler = {
  readonly add: (source: Expression) => Effect.Effect<number, AiError.InvalidUserInputError>;
};

/**
 * Sequential additions share object identity within this execution, never between executions.
 * A failed or interrupted addition closes compilation, even if the callback catches its failure.
 */
export const compile = Effect.fnUntraced(function* <Roots, E, R>(
  use: (compiler: Compiler) => Effect.Effect<Roots, E, R>,
): Effect.fn.Return<
  { readonly nodes: readonly Node[]; readonly roots: Roots },
  E | AiError.InvalidUserInputError,
  R
> {
  const nodes: Node[] = [];
  const references = new WeakMap<Expression, "visiting" | number>();
  let state: "ready" | "adding" | "closed" = "ready";
  const visit = Effect.fnUntraced(function* (
    source: Expression,
  ): Effect.fn.Return<number, AiError.InvalidUserInputError> {
    const previous = references.get(source);
    if (previous === "visiting")
      return yield* new AiError.InvalidUserInputError({
        description: "Taxon-set expression contains a cycle.",
      });
    if (previous !== undefined) return previous;
    const node = yield* Schema.decodeUnknownEffect(sourceNodeSchema, { reportInput: false })(
      source,
    ).pipe(
      Effect.mapError((error) => new AiError.InvalidUserInputError({ description: error.message })),
    );
    references.set(source, "visiting");
    let row: Node;
    switch (node._tag) {
      case "Empty":
        row = { _tag: "Empty" };
        break;
      case "Taxon":
        row = { _tag: "Taxon", name: node.name };
        break;
      case "Union":
        row = { _tag: "Union", operands: yield* Effect.forEach(node.operands, visit) };
        break;
      case "Intersection":
        row = { _tag: "Intersection", operands: yield* Effect.forEach(node.operands, visit) };
        break;
      case "Difference":
        row = {
          _tag: "Difference",
          left: yield* visit(node.left),
          right: yield* visit(node.right),
        };
        break;
    }
    const ref = nodes.length;
    nodes.push(row);
    references.set(source, ref);
    return ref;
  });
  const add = Effect.fnUntraced(function* (source: Expression) {
    if (state !== "ready") {
      state = "closed";
      return yield* Effect.die("TaxonSetGraph additions must be sequential and inside compile.");
    }
    state = "adding";
    return yield* visit(source).pipe(
      Effect.flatMap((ref) =>
        state === "adding"
          ? Effect.succeed(ref)
          : Effect.die("TaxonSetGraph addition outlived its compilation."),
      ),
      Effect.onExit((exit) =>
        Effect.sync(() => {
          if (Exit.isFailure(exit)) state = "closed";
          else if (state !== "closed") state = "ready";
        }),
      ),
    );
  });
  return yield* Effect.suspend(() => use({ add })).pipe(
    Effect.flatMap((roots) => {
      if (state !== "ready")
        return Effect.die("TaxonSetGraph cannot publish an abandoned compilation.");
      state = "closed";
      return Effect.succeed({ nodes, roots });
    }),
    Effect.ensuring(
      Effect.sync(() => {
        state = "closed";
      }),
    ),
  );
});
