import { Array, Effect, Match, Option, Predicate, Record, Schema } from "effect";
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
// Check nominal acceptance before the node's fields and immediate children.
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
 * Collect exact names from one root of a validated table, in expression order.
 * Visit shared nodes once per root and retain the first occurrence of each exact name.
 */
export const collectTaxonNames = (nodes: readonly Node[], root: number): readonly TaxonName[] => {
  const stack = [root];
  const visited = new Set<number>();
  const names = new Set<TaxonName>();
  const pushOperands = ({ operands }: { readonly operands: readonly number[] }) => {
    for (let index = operands.length - 1; index >= 0; index--) {
      stack.push(Array.getUnsafe(operands, index));
    }
  };
  while (stack.length > 0) {
    const ref = Option.fromUndefinedOr(stack.pop()).pipe(Option.getOrThrow);
    if (visited.has(ref)) continue;
    visited.add(ref);
    nodeSchema.match(Array.getUnsafe(nodes, ref), {
      Empty: () => {},
      Taxon: ({ name }) => {
        names.add(name);
      },
      Union: pushOperands,
      Intersection: pushOperands,
      Difference: ({ left, right }) => {
        stack.push(right, left);
      },
    });
  }
  return Array.fromIterable(names);
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
  "Difference keeps left organisms outside right. Node identity is not biological identity. " +
  "Each Taxon-node name must identify one taxon; synonyms and acronyms for that taxon are valid. " +
  "If a Taxon-node name clearly describes several distinct taxa together, select its multiple-name criterion before judging the relationship or membership. " +
  "Preserve supplied names instead of splitting them or silently interpreting them as unions. " +
  "Intentional combinations use explicit set operators. " +
  "Use undetermined when you cannot answer the relationship or membership question and cannot identify a Taxon-node name that clearly refers to several distinct taxa.";

// Keep the recursive input named in emitted declarations.
type CompileFn = <K extends string>(
  sources: Readonly<Record<K, Expression>>,
) => Effect.Effect<
  { readonly nodes: readonly Node[]; readonly roots: Readonly<Record<K, number>> },
  AiError.InvalidUserInputError
>;

/**
 * Compile the named roots sequentially into one shared node table.
 * Keep compilation data local to each execution.
 */
export const compile: CompileFn = Effect.fnUntraced(function* <K extends string>(
  sources: Readonly<Record<K, Expression>>,
) {
  const nodes: Node[] = [];
  const references = new WeakMap<Expression, "visiting" | number>();
  const compileNode = Effect.fnUntraced(function* (
    source: Expression,
  ): Effect.fn.Return<number, AiError.InvalidUserInputError> {
    const previous = references.get(source);
    if (previous === "visiting")
      return yield* new AiError.InvalidUserInputError({
        description: "Taxon-set expression contains a cycle.",
      });
    if (previous !== undefined) return previous;
    const node = yield* Schema.decodeEffect(sourceNodeSchema, { reportInput: false })(source).pipe(
      Effect.mapError((error) => new AiError.InvalidUserInputError({ description: error.message })),
    );
    references.set(source, "visiting");
    const row = yield* Match.value(node).pipe(
      Match.tagsExhaustive({
        Empty: () => Effect.succeed(nodeSchema.cases.Empty.make({})),
        Taxon: ({ name }) => Effect.succeed(nodeSchema.cases.Taxon.make({ name })),
        Union: ({ operands }) =>
          Effect.forEach(operands, compileNode).pipe(
            Effect.map((operands) => nodeSchema.cases.Union.make({ operands })),
          ),
        Intersection: ({ operands }) =>
          Effect.forEach(operands, compileNode).pipe(
            Effect.map((operands) => nodeSchema.cases.Intersection.make({ operands })),
          ),
        Difference: ({ left, right }) =>
          Effect.gen(function* () {
            return nodeSchema.cases.Difference.make({
              left: yield* compileNode(left),
              right: yield* compileNode(right),
            });
          }),
      }),
    );
    const ref = nodes.length;
    nodes.push(row);
    references.set(source, ref);
    return ref;
  });
  yield* Effect.forEach(Record.values(sources), compileNode, {
    concurrency: 1,
    discard: true,
  });
  return {
    nodes,
    roots: Record.map(sources, (source) =>
      Option.fromUndefinedOr(references.get(source)).pipe(
        Option.filter(Predicate.isNumber),
        Option.getOrThrow,
      ),
    ),
  };
});
