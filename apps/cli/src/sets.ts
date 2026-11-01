import { Effect, Match, Option, Stream } from "effect";
import { Command, Flag } from "effect/cli";
import { TaxonSet } from "robo-taxonomist";
import * as Documents from "./documents.ts";
import * as Inputs from "./inputs.ts";
import * as Model from "./model.ts";
import * as Output from "./output.ts";
import * as Presentation from "./presentation.ts";

const sourceHelp =
  "Literal targets come first, then files in supplied order, forming one union per operand. Exact names and repeated occurrences are retained.\n\n" +
  "Files use newline text by default, .json for a target record array or generated set artifact, and .jsonl for one identifying record per line. An explicit format overrides the suffix; stdin defaults to text.\n\n" +
  "stdin can only be used once per invocation. No sources produces the empty set.\n\n" +
  "All targets remain in memory. Output preserves the symbolic expression, not a resolved list of organisms. Imported subtrees remain intact; unions have two or more operands and intersections have exactly two. Input or output nesting beyond runtime limits fails with a diagnostic.";

const create = Command.make(
  "create",
  Inputs.targetFlags(),
  Effect.fn("Cli.createSet")(function* ({ targets, files, format }) {
    yield* Inputs.checkStdin(files);
    const set = yield* Inputs.loadTargets(targets, files, Option.getOrUndefined(format));
    yield* Output.writeJson(set, Documents.SetDocument);
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
  { left: Inputs.targetFlags("left-"), right: Inputs.targetFlags("right-") },
  Effect.fn("Cli.difference")(function* ({ left, right }) {
    yield* Inputs.checkStdin([...left.files, ...right.files]);
    const leftSet = yield* Inputs.loadTargets(
      left.targets,
      left.files,
      Option.getOrUndefined(left.format),
    );
    const rightSet = yield* Inputs.loadTargets(
      right.targets,
      right.files,
      Option.getOrUndefined(right.format),
    );
    const set = TaxonSet.difference(leftSet, rightSet);
    yield* Output.writeJson(set, Documents.SetDocument);
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
  { left: Inputs.targetFlags("left-"), right: Inputs.targetFlags("right-") },
  Effect.fn("Cli.union")(function* ({ left, right }) {
    yield* Inputs.checkStdin([...left.files, ...right.files]);
    const leftSet = yield* Inputs.loadTargets(
      left.targets,
      left.files,
      Option.getOrUndefined(left.format),
    );
    const rightSet = yield* Inputs.loadTargets(
      right.targets,
      right.files,
      Option.getOrUndefined(right.format),
    );
    const set = TaxonSet.union(leftSet, rightSet);
    yield* Output.writeJson(set, Documents.SetDocument);
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
  { left: Inputs.targetFlags("left-"), right: Inputs.targetFlags("right-") },
  Effect.fn("Cli.intersection")(function* ({ left, right }) {
    yield* Inputs.checkStdin([...left.files, ...right.files]);
    const leftSet = yield* Inputs.loadTargets(
      left.targets,
      left.files,
      Option.getOrUndefined(left.format),
    );
    const rightSet = yield* Inputs.loadTargets(
      right.targets,
      right.files,
      Option.getOrUndefined(right.format),
    );
    const set = TaxonSet.intersection(leftSet, rightSet);
    yield* Output.writeJson(set, Documents.SetDocument);
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
    left: Inputs.targetFlags("left-"),
    right: Inputs.targetFlags("right-"),
    relation: Flag.Literals("relation", [
      "subset",
      "proper-subset",
      "equivalent",
      "overlap",
      "disjoint",
    ]),
    model: Model.modelFlag,
    format: Flag.Literals("format", ["tsv", "json"]).pipe(Flag.withDefault("tsv")),
    noHeader: Flag.Boolean("no-header").pipe(Flag.withDefault(false)),
  },
  Effect.fn("Cli.setRelation")(function* ({ left, right, relation, format, noHeader }) {
    yield* Inputs.checkStdin([...left.files, ...right.files]);
    const leftSet = yield* Inputs.loadTargets(
      left.targets,
      left.files,
      Option.getOrUndefined(left.format),
    );
    const rightSet = yield* Inputs.loadTargets(
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
      Effect.mapError(Model.modelFailure),
    );
    const render = Match.value(format).pipe(
      Match.literalsExhaustive({
        tsv: () =>
          Effect.gen(function* () {
            const row = yield* Presentation.relationRow(result);
            const rows = Stream.succeed(row);
            const writeRows = Output.writeTable(Presentation.RelationRow, noHeader);
            yield* writeRows(rows);
          }),
        json: () => Output.writeJson(result, Documents.SetRelationJudgment),
      }),
    );
    yield* render;
  }),
).pipe(
  Command.withAlias("rel"),
  Command.withDescription(
    "Ask a native relation question about two symbolic sets.\n\n" +
      Model.modelHelp +
      "\n\n" +
      sourceHelp +
      "\n\nJSON preserves the full native clarification target. TSV requires its original text name or label; use --format json for identifier-only clarification targets. Tabs, newlines, and quotes are escaped using tab-delimited CSV quoting.",
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
  Command.provide(({ model }) => Model.modelLayer(model)),
);

export const sets = Command.make("set").pipe(
  Command.withDescription("Construct and compose symbolic taxon sets."),
  Command.withSubcommands([create, difference, union, intersection, relation]),
);
