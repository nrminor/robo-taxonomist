import { Array, Effect, Graph, Match, Option, Predicate, Record, Schema } from "effect";
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
type SourceNode = typeof fields.Type;
const nodeRef = Schema.Natural;
const nodeSchema = Schema.TaggedUnion({
  Empty: {},
  Taxon: { name: TaxonName },
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
  "Taxon contains organisms belonging to name; Union combines operands; Intersection keeps their shared organisms; " +
  "Difference keeps left organisms outside right. Node identity is not biological identity. " +
  "Interpret clear combinations in names together. Flag a combined name only when it prevents answering.";

// Keep the recursive input named in emitted declarations.
type CompileFn = <K extends string>(
  sources: Readonly<Record<K, Expression>>,
) => Effect.Effect<
  {
    readonly nodes: readonly Node[];
    readonly roots: Readonly<Record<K, number>>;
    readonly names: Readonly<Record<K, readonly TaxonName[]>>;
  },
  AiError.InvalidUserInputError
>;

/**
 * Compile named roots into one shared node table. Finish each root before starting the next.
 * Collect exact names in expression order independently for each root. Graph data stays local to preparation.
 * @example
 * import { TaxonName, TaxonSet } from "robo-taxonomist";
 * import { compile } from "./TaxonSetGraph.ts";
 * export const prepared = compile({ target: TaxonSet.of(TaxonName.make("Quercus")) });
 */
export const compile: CompileFn = Effect.fnUntraced(function* <K extends string>(
  sources: Readonly<Record<K, Expression>>,
) {
  const mutable = Graph.beginMutation(Graph.directed<SourceNode, void>());
  const references = new WeakMap<Expression, number>();
  const intern = Effect.fnUntraced(function* (
    source: Expression,
  ): Effect.fn.Return<number, AiError.InvalidUserInputError> {
    const previous = references.get(source);
    if (previous !== undefined) return previous;
    const node = yield* Schema.decodeEffect(sourceNodeSchema, { reportInput: false })(source).pipe(
      Effect.mapError((error) => new AiError.InvalidUserInputError({ description: error.message })),
    );
    const id = Graph.addNode(mutable, node);
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
        const node = Graph.getNode(mutable, id).pipe(Option.getOrThrow);
        const link = Effect.fnUntraced(function* (child: Expression) {
          const target = yield* intern(child);
          Graph.addEdge(mutable, id, target, undefined);
          return target;
        });
        nodes.push(
          yield* Match.value(node).pipe(
            Match.tagsExhaustive({
              Empty: () => Effect.succeed(nodeSchema.cases.Empty.make({})),
              Taxon: ({ name }) => Effect.succeed(nodeSchema.cases.Taxon.make({ name })),
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
                  return nodeSchema.cases.Difference.make({
                    left: yield* link(left),
                    right: yield* link(right),
                  });
                }),
            }),
          ),
        );
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
  const names = Record.map(roots, (root) => {
    const names = new Set<TaxonName>();
    for (const ref of Graph.indices(Graph.dfs(graph, { start: [root] }))) {
      const node = Array.getUnsafe(nodes, ref);
      if (Predicate.isTagged(node, "Taxon")) names.add(node.name);
    }
    return Array.fromIterable(names);
  });
  return { nodes, roots, names };
});
