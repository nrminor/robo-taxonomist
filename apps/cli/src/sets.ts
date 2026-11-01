import { Console, Effect, Option } from "effect";
import { CliError, Command, Flag } from "effect/cli";
import { TaxonName, TaxonSet } from "robo-taxonomist";
import { checkStdin, loadTargets } from "./targets.ts";

const writeSet = Effect.fn("Cli.writeSet")(function* (set: TaxonSet.TaxonSet) {
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

const targetFlags = (prefix = "") => ({
  targets: Flag.String(`${prefix}target`).pipe(
    Flag.withSchema(TaxonName),
    Flag.atLeast(0),
    Flag.withDescription("Literal target name; repeat to form a union."),
  ),
  files: Flag.String(`${prefix}targets-file`).pipe(
    Flag.atLeast(0),
    Flag.withDescription("Target file, or - for stdin. Repeat to combine sources."),
  ),
  format: Flag.Literals(`${prefix}targets-format`, ["text", "json", "jsonl"]).pipe(
    Flag.optional,
    Flag.withDescription("Override file suffix detection; stdin defaults to text."),
  ),
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

export const sets = Command.make("set").pipe(
  Command.withDescription("Construct and compose symbolic taxon sets."),
  Command.withSubcommands([create, difference, union, intersection]),
);
