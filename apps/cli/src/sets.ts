import { Console, Effect, Match, Option, Schema } from "effect";
import { CliError, Command, Flag } from "effect/cli";
import { TaxonSet } from "robo-taxonomist";
import { checkStdin, loadTargets, targetFlags } from "./targets.ts";
import { modelFailure, modelFlag, modelHelp, modelLayer } from "./model.ts";

const writeSet = Effect.fn("Cli.writeSet")(function* (set: object) {
  const text = yield* Effect.try({
    try: () => JSON.stringify(set),
    catch: (cause) =>
      new CliError.UserError({
        cause,
        userMessage:
          "Cannot serialize set as JSON; expression or metadata may be too deeply nested",
      }),
  });
  yield* Console.log(text);
});

const sourceHelp =
  "Literal targets come first, then files in supplied order, forming one union per operand. Exact names and repeated occurrences are retained.\n\n" +
  "Files use newline text by default, .json for a target record array or generated set artifact, and .jsonl for one identifying record per line. An explicit format overrides the suffix; stdin defaults to text.\n\n" +
  "stdin can only be used once per invocation. No sources produces the empty set.\n\n" +
  "All targets remain in memory. Output preserves the symbolic expression, not a resolved list of organisms. Imported subtrees remain intact; unions have two or more operands and intersections have exactly two. Input or output nesting beyond runtime limits fails with a diagnostic.";

const create = Command.make(
  "create",
  targetFlags(),
  Effect.fn("Cli.createSet")(function* ({ targets, files, format }) {
    const set = yield* loadTargets(targets, files, Option.getOrUndefined(format));
    yield* writeSet(set);
  }),
).pipe(
  Command.withDescription(
    "Construct a symbolic taxon set without model inference.\n\n" + sourceHelp,
  ),
  Command.withExamples([
    {
      command: "robo-taxonomist set create --target Quercus --target Fagus",
      description: "Create a union directly from target names.",
    },
    {
      command: "robo-taxonomist set create --targets-file targets.txt",
      description: "Read one target name per line.",
    },
    {
      command: "robo-taxonomist set create --targets-file - --targets-format json",
      description: "Reload a generated set artifact from stdin.",
    },
  ]),
);

const difference = Command.make(
  "difference",
  { left: targetFlags("left-"), right: targetFlags("right-") },
  Effect.fn("Cli.difference")(function* ({ left, right }) {
    yield* checkStdin([...left.files, ...right.files]);
    const leftSet = yield* loadTargets(
      left.targets,
      left.files,
      Option.getOrUndefined(left.format),
    );
    const rightSet = yield* loadTargets(
      right.targets,
      right.files,
      Option.getOrUndefined(right.format),
    );
    yield* writeSet(TaxonSet.difference(leftSet, rightSet));
  }),
).pipe(
  Command.withAlias("diff"),
  Command.withDescription("Construct left minus right without model inference.\n\n" + sourceHelp),
  Command.withExamples([
    {
      command: "robo-taxonomist set diff --left-target Fagaceae --right-target Quercus",
      description: "Describe family members other than oaks.",
    },
  ]),
);

const union = Command.make(
  "union",
  { left: targetFlags("left-"), right: targetFlags("right-") },
  Effect.fn("Cli.union")(function* ({ left, right }) {
    yield* checkStdin([...left.files, ...right.files]);
    const leftSet = yield* loadTargets(
      left.targets,
      left.files,
      Option.getOrUndefined(left.format),
    );
    const rightSet = yield* loadTargets(
      right.targets,
      right.files,
      Option.getOrUndefined(right.format),
    );
    yield* writeSet(TaxonSet.union(leftSet, rightSet));
  }),
).pipe(
  Command.withDescription(
    "Construct a union of two sets without model inference.\n\n" + sourceHelp,
  ),
  Command.withExamples([
    {
      command: "robo-taxonomist set union --left-targets-file oaks.json --right-target Fagus",
      description: "Combine a generated set artifact with a target name.",
    },
  ]),
);

const intersection = Command.make(
  "intersection",
  { left: targetFlags("left-"), right: targetFlags("right-") },
  Effect.fn("Cli.intersection")(function* ({ left, right }) {
    yield* checkStdin([...left.files, ...right.files]);
    const leftSet = yield* loadTargets(
      left.targets,
      left.files,
      Option.getOrUndefined(left.format),
    );
    const rightSet = yield* loadTargets(
      right.targets,
      right.files,
      Option.getOrUndefined(right.format),
    );
    yield* writeSet(TaxonSet.intersection(leftSet, rightSet));
  }),
).pipe(
  Command.withDescription(
    "Construct an intersection of two sets without model inference.\n\n" + sourceHelp,
  ),
  Command.withExamples([
    {
      command: "robo-taxonomist set intersection --left-target Quercus --right-target Fagaceae",
      description: "Describe organisms belonging to both supplied taxa.",
    },
  ]),
);

const relation = Command.make(
  "relation",
  {
    left: targetFlags("left-"),
    right: targetFlags("right-"),
    relation: Flag.Literals("relation", [
      "subset",
      "proper-subset",
      "equivalent",
      "overlap",
      "disjoint",
    ]),
    model: modelFlag,
    format: Flag.Literals("format", ["tsv", "json"]).pipe(Flag.withDefault("tsv")),
    noHeader: Flag.Boolean("no-header").pipe(Flag.withDefault(false)),
  },
  Effect.fn("Cli.setRelation")(function* ({ left, right, relation, format, noHeader }) {
    yield* checkStdin([...left.files, ...right.files]);
    const leftSet = yield* loadTargets(
      left.targets,
      left.files,
      Option.getOrUndefined(left.format),
    );
    const rightSet = yield* loadTargets(
      right.targets,
      right.files,
      Option.getOrUndefined(right.format),
    );
    const operations = {
      subset: TaxonSet.isSubsetOf,
      "proper-subset": TaxonSet.isProperSubsetOf,
      equivalent: TaxonSet.equivalent,
      overlap: TaxonSet.overlaps,
      disjoint: TaxonSet.disjoint,
    };
    const result = yield* operations[relation](leftSet, rightSet).pipe(
      Effect.mapError(modelFailure),
    );
    if (format === "json") {
      yield* writeSet(result);
      return;
    }
    const cells = yield* Match.value(result).pipe(
      Match.tagsExhaustive({
        Yes: ({ relation }) => Effect.succeed(["Yes", relation, "", ""]),
        No: ({ relation }) => Effect.succeed(["No", relation, "", ""]),
        Undetermined: ({ relation }) => Effect.succeed(["Undetermined", relation, "", ""]),
        MultipleTaxaInSet: ({ relation, side, taxon }) =>
          Effect.gen(function* () {
            const target = taxon.record.scientificName ?? taxon.record.label;
            if (target === undefined)
              return yield* new CliError.UserError({
                cause:
                  "The clarification target has no text name or label; use --format json to retain its identifiers",
              });
            const text = yield* Schema.decodeUnknownEffect(
              Schema.String.check(Schema.isPattern(/^[^\t\r\n]*$/u)),
            )(target).pipe(
              Effect.mapError(
                (cause) =>
                  new CliError.UserError({
                    cause,
                    userMessage: "Clarification text contains TSV delimiters; use --format json",
                  }),
              ),
            );
            return ["MultipleTaxaInSet", relation, side, text];
          }),
      }),
    );
    if (!noHeader) yield* Console.log("judgment\trelation\tside\tclarification_target");
    yield* Console.log(cells.join("\t"));
  }),
).pipe(
  Command.withAlias("rel"),
  Command.withDescription(
    "Ask a native relation question about two symbolic sets.\n\n" +
      modelHelp +
      "\n\n" +
      sourceHelp +
      "\n\nJSON preserves the full native clarification target. TSV requires its original text name or label without delimiters; use --format json for identifier-only or delimiter-bearing clarification targets.",
  ),
  Command.withExamples([
    {
      command:
        "robo-taxonomist set relation --relation subset --left-target Quercus --right-target Fagaceae --model your-model",
      description: "Ask a directed subset question.",
    },
    {
      command:
        "robo-taxonomist set rel --relation overlap --left-targets-file panel.json --right-target Fagus --model your-model --format json",
      description: "Compare a saved symbolic set without losing clarification details.",
    },
  ]),
  Command.provide(({ model }) => modelLayer(model)),
);

export const sets = Command.make("set").pipe(
  Command.withDescription("Construct and compose symbolic taxon sets."),
  Command.withSubcommands([create, difference, union, intersection, relation]),
);
