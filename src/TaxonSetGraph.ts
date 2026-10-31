import * as AiError from "effect/ai/AiError";
import * as Array from "effect/Array";
import * as Effect from "effect/Effect";
import * as Graph from "effect/Graph";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Record from "effect/Record";
import * as Schema from "effect/Schema";
import { TaxonomicRecord, taxonSetSchema, type Expression, type Taxon } from "./schemas.ts";

const fields = Schema.Union([
  Schema.Struct(taxonSetSchema.cases.Empty.fields),
  Schema.Struct(taxonSetSchema.cases.Taxon.fields),
  Schema.Struct(taxonSetSchema.cases.Union.fields),
  Schema.Struct(taxonSetSchema.cases.Intersection.fields),
  Schema.Struct(taxonSetSchema.cases.Difference.fields),
]);
// Check nominal acceptance before the node's fields and immediate children.
const sourceNodeSchema = Schema.toType(taxonSetSchema).pipe(Schema.decodeTo(Schema.toType(fields)));
type SourceNode = typeof fields.Type;
const nodeRef = Schema.Natural;
const nodeSchema = Schema.TaggedUnion({
  Empty: {},
  Taxon: { record: TaxonomicRecord },
  Union: { operands: Schema.NonEmptyArray(nodeRef) },
  Intersection: { operands: Schema.NonEmptyArray(nodeRef) },
  Difference: { left: nodeRef, right: nodeRef },
});
type Node = typeof nodeSchema.Type;

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
  "Taxon contains organisms belonging to the single taxonomic entity identified by record; " +
  "Union combines operands; Intersection keeps their shared organisms; " +
  "Difference keeps left organisms outside right. Node identity is not biological identity. " +
  "Flag a taxon entry that identifies multiple entities for clarification.";

// Keep the recursive input named in emitted declarations.
type CompileFn = <K extends string, R extends TaxonomicRecord>(
  sources: Readonly<Record<K, Expression<R>>>,
) => Effect.Effect<
  {
    readonly nodes: readonly Node[];
    readonly roots: Readonly<Record<K, number>>;
    readonly taxa: Readonly<Record<K, readonly Taxon<R>[]>>;
    readonly nodeIds: Pick<WeakMap<Expression, number>, "get">;
  },
  AiError.InvalidUserInputError
>;

/**
 * Compile named roots into one shared node table. Finish each root before starting the next.
 * Collect original taxon entries in traversal order independently for each root.
 * Shared entries occur once per root; graph data stays local to preparation.
 * @example
 * import { TaxonName, TaxonSet } from "robo-taxonomist";
 * import { compile } from "./TaxonSetGraph.ts";
 * export const prepared = compile({ target: TaxonSet.of(TaxonName.make("Quercus")) });
 */
export const compile: CompileFn = Effect.fnUntraced(function* <
  K extends string,
  R extends TaxonomicRecord,
>(sources: Readonly<Record<K, Expression<R>>>) {
  const mutable = Graph.beginMutation(Graph.directed<SourceNode, void>());
  const references = new WeakMap<Expression, number>();
  const originals: Expression<R>[] = [];
  const intern = Effect.fnUntraced(function* (
    source: Expression<R>,
  ): Effect.fn.Return<number, AiError.InvalidUserInputError> {
    const previous = references.get(source);
    if (previous !== undefined) return previous;
    const node = yield* Schema.decodeEffect(sourceNodeSchema, { reportInput: false })(source).pipe(
      Effect.mapError((error) => new AiError.InvalidUserInputError({ description: error.message })),
    );
    const id = Graph.addNode(mutable, node);
    originals.push(source);
    references.set(source, id);
    return id;
  });
  const nodes: Node[] = [];
  const graph = yield* Effect.gen(function* () {
    for (const source of Record.values(sources)) {
      yield* intern(source);
      // Append-only Graph IDs are table offsets. New children extend the graph.
      while (nodes.length < Graph.nodeCount(mutable)) {
        const id = nodes.length;
        const source = Array.getUnsafe(originals, id);
        const link = Effect.fnUntraced(function* (child: Expression<R>) {
          const target = yield* intern(child);
          Graph.addEdge(mutable, id, target, undefined);
          return target;
        });
        const node = yield* Match.value(source).pipe(
          Match.tagsExhaustive({
            Empty: () => Effect.succeed(nodeSchema.cases.Empty.make({})),
            Taxon: ({ record }) => Effect.succeed(nodeSchema.cases.Taxon.make({ record })),
            Union: ({ operands }) =>
              Effect.forEach(operands, link).pipe(
                Effect.map((operands) => nodeSchema.cases.Union.make({ operands })),
              ),
            Intersection: ({ operands }) =>
              Effect.forEach(operands, link).pipe(
                Effect.map((operands) => nodeSchema.cases.Intersection.make({ operands })),
              ),
            Difference: ({ left, right }) =>
              Effect.gen(function* () {
                const leftRef = yield* link(left);
                const rightRef = yield* link(right);
                return nodeSchema.cases.Difference.make({
                  left: leftRef,
                  right: rightRef,
                });
              }),
          }),
        );
        nodes.push(node);
      }
    }
    return Graph.endMutation(mutable);
  }).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        if (mutable.mutable) Graph.endMutation(mutable);
      }),
    ),
  );
  if (!Graph.isAcyclic(graph))
    return yield* new AiError.InvalidUserInputError({
      description: "Taxon-set expression contains a cycle.",
    });
  const roots = Record.map(sources, (source) =>
    Option.fromUndefinedOr(references.get(source)).pipe(Option.getOrThrow),
  );
  const taxa = Record.map(roots, (root) => {
    const taxa: Taxon<R>[] = [];
    for (const ref of Graph.indices(Graph.dfs(graph, { start: [root] }))) {
      const source = Array.getUnsafe(originals, ref);
      if (Predicate.isTagged(source, "Taxon")) taxa.push(source);
    }
    return taxa;
  });
  return { nodes, roots, taxa, nodeIds: references };
});
