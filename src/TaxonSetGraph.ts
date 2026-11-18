import * as AiError from "effect/ai/AiError";
import * as Effect from "effect/Effect";
import * as Graph from "effect/Graph";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Record from "effect/Record";
import * as Schema from "effect/Schema";
import * as Errors from "./errors.ts";
import {
  TaxonomicRecord,
  TaxonomyHint,
  taxonSetSchema,
  type Expression,
  type Taxon,
} from "./schemas.ts";

const sourceNodeFields = Schema.Union([
  Schema.Struct(taxonSetSchema.cases.Empty.fields),
  Schema.Struct(taxonSetSchema.cases.Taxon.fields),
  Schema.Struct(taxonSetSchema.cases.Union.fields),
  Schema.Struct(taxonSetSchema.cases.Intersection.fields),
  Schema.Struct(taxonSetSchema.cases.Difference.fields),
]);
// Check nominal acceptance before the node's fields and immediate children.
const sourceNodeSchema = Schema.toType(taxonSetSchema).pipe(
  Schema.decodeTo(Schema.toType(sourceNodeFields)),
);
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
  hints: Schema.optionalKey(Schema.NonEmptyArray(TaxonomyHint)),
  instructions: Schema.optionalKey(Schema.String),
});
export const relationInputSchema = Schema.Struct({
  nodes: Schema.Array(nodeSchema),
  left: nodeRef,
  right: nodeRef,
  hints: Schema.optionalKey(Schema.NonEmptyArray(TaxonomyHint)),
  instructions: Schema.optionalKey(Schema.String),
});
export const instructions =
  "References index nodes; roots select the complete sets. Empty contains no organisms; " +
  "Taxon contains organisms belonging to the single taxonomic entity identified by record; " +
  "Union combines operands; Intersection keeps their shared organisms; " +
  "Difference keeps left organisms outside right. Node identity is not biological identity. " +
  "Flag a taxon entry that identifies multiple entities for clarification.";

type SourceGraph<R extends TaxonomicRecord> = {
  readonly graph: Graph.MutableDirectedGraph<Expression<R>, void>;
  readonly nodeIds: WeakMap<Expression, Graph.NodeIndex>;
};

const intern = Effect.fnUntraced(function* <R extends TaxonomicRecord>(
  sourceGraph: SourceGraph<R>,
  source: Expression<R>,
): Effect.fn.Return<Graph.NodeIndex, Errors.InvalidInput> {
  const existingId = sourceGraph.nodeIds.get(source);
  if (existingId !== undefined) return existingId;

  // Validate the shape, then retain the caller's original object.
  yield* Schema.decodeEffect(sourceNodeSchema, { reportInput: false })(source).pipe(
    Effect.mapError(Errors.InvalidInput.from),
  );

  const nodeId = Graph.addNode(sourceGraph.graph, source);
  sourceGraph.nodeIds.set(source, nodeId);

  return nodeId;
});

const linkChild = Effect.fnUntraced(function* <R extends TaxonomicRecord>(
  sourceGraph: SourceGraph<R>,
  parentId: Graph.NodeIndex,
  child: Expression<R>,
): Effect.fn.Return<Graph.NodeIndex, Errors.InvalidInput> {
  const childId = yield* intern(sourceGraph, child);

  Graph.addEdge(sourceGraph.graph, parentId, childId, undefined);

  return childId;
});

const compileNode = <R extends TaxonomicRecord>(
  sourceGraph: SourceGraph<R>,
  nodeId: Graph.NodeIndex,
): Effect.Effect<Node, Errors.InvalidInput> => {
  const source = Graph.getNode(sourceGraph.graph, nodeId).pipe(Option.getOrThrow);

  return Match.value(source).pipe(
    Match.tagsExhaustive({
      Empty: () => Effect.succeed(nodeSchema.cases.Empty.make({})),

      Taxon: ({ record }) => Effect.succeed(nodeSchema.cases.Taxon.make({ record })),

      Union: ({ operands }) =>
        Effect.forEach(operands, (child) => linkChild(sourceGraph, nodeId, child)).pipe(
          Effect.map((operandIds) => nodeSchema.cases.Union.make({ operands: operandIds })),
        ),

      Intersection: ({ operands }) =>
        Effect.forEach(operands, (child) => linkChild(sourceGraph, nodeId, child)).pipe(
          Effect.map((operandIds) => nodeSchema.cases.Intersection.make({ operands: operandIds })),
        ),

      Difference: ({ left, right }) =>
        Effect.gen(function* () {
          const leftId = yield* linkChild(sourceGraph, nodeId, left);
          const rightId = yield* linkChild(sourceGraph, nodeId, right);

          return nodeSchema.cases.Difference.make({ left: leftId, right: rightId });
        }),
    }),
  );
};

const collectTaxa = <R extends TaxonomicRecord>(
  graph: Graph.DirectedGraph<Expression<R>, void>,
  root: Graph.NodeIndex,
): Taxon<R>[] => {
  const reachableExpressions = graph.pipe(Graph.dfs({ start: [root] }), Graph.values);
  const taxa: Taxon<R>[] = [];

  for (const source of reachableExpressions) {
    if (Predicate.isTagged(source, "Taxon")) {
      taxa.push(source);
    }
  }

  return taxa;
};

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
  Errors.TaxonomyError
>;

/**
 * Compile named roots into one shared node table.
 * Finish each root's pending nodes before starting the next.
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
  const mutableGraph = Graph.directed<Expression<R>, void>().pipe(Graph.beginMutation);
  const nodeIds = new WeakMap<Expression, Graph.NodeIndex>();

  const sourceGraph: SourceGraph<R> = {
    graph: mutableGraph,
    nodeIds,
  };

  const nodes: Node[] = [];

  const graph = yield* Effect.gen(function* () {
    for (const source of Record.values(sources)) {
      yield* intern(sourceGraph, source);

      // IDs below nodes.length are compiled; higher IDs are pending.
      while (nodes.length < Graph.nodeCount(mutableGraph)) {
        const nodeId = nodes.length;
        const compiledNode = yield* compileNode(sourceGraph, nodeId);

        nodes.push(compiledNode);
      }
    }

    return Graph.endMutation(mutableGraph);
  }).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        if (mutableGraph.mutable) {
          Graph.endMutation(mutableGraph);
        }
      }),
    ),
  );

  if (!Graph.isAcyclic(graph)) {
    const reason = new AiError.InvalidUserInputError({
      description: "Taxon-set expression contains a cycle.",
    });

    return yield* AiError.make({ module: "TaxonSetGraph", method: "compile", reason });
  }

  const roots = Record.map(sources, (source) =>
    Option.fromUndefinedOr(nodeIds.get(source)).pipe(Option.getOrThrow),
  );
  const taxa = Record.map(roots, (root) => collectTaxa(graph, root));

  return { nodes, roots, taxa, nodeIds };
});
