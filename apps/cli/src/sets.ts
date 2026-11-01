import { Effect, Match, Option } from "effect";
import { Command, Flag } from "effect/cli";
import { TaxonSet } from "robo-taxonomist";
import * as Documents from "./documents.ts";
import * as Inputs from "./inputs.ts";
import * as Model from "./model.ts";
import * as Output from "./output.ts";

const sourceHelp =
  "Write the set definition as JSON. With no targets, the set is empty. Use stdin (-) only once.";

const create = Command.make(
  "create",
  Inputs.targetFlags(),
  Effect.fn("Cli.createSet")(function* ({ targets, files, format }) {
    yield* Inputs.checkStdin(files);
    const set = yield* Inputs.loadTargets(targets, files, Option.getOrUndefined(format));
    yield* Output.writeJson(set, Documents.SetDocument);
  }),
).pipe(
  Command.withShortDescription("Create a set from target names or files."),
  Command.withDescription("Create a taxon set from names or files.\n\n" + sourceHelp),
  Command.withExamples([
    {
      command: "robo-taxonomist set create --target Quercus --target Fagus",
      description: "Create a union directly from target names.",
    },
    {
      command: "robo-taxonomist set create --targets-file - --targets-format json",
      description: "Read a saved set from stdin.",
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
  Command.withShortDescription("Subtract the right set from the left."),
  Command.withDescription(
    "Define a set of organisms in the left set but not in the right.\n\n" + sourceHelp,
  ),
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
  Command.withShortDescription("Combine two sets."),
  Command.withDescription("Define a set of organisms that belong to either set.\n\n" + sourceHelp),
  Command.withExamples([
    {
      command: "robo-taxonomist set union --left-targets-file oaks.json --right-target Fagus",
      description: "Combine a saved set with a target name.",
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
  Command.withShortDescription("Keep the overlap between two sets."),
  Command.withDescription("Define a set of organisms that belong to both sets.\n\n" + sourceHelp),
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
    ]).pipe(Flag.withDescription("Relationship to test between the left and right sets.")),
    model: Model.modelFlag,
    format: Flag.Literals("format", ["tsv", "json"]).pipe(
      Flag.withDefault("tsv"),
      Flag.withDescription(
        "Tab-delimited CSV (default), or JSON. Use JSON for identifier-only targets.",
      ),
    ),
    noHeader: Flag.Boolean("no-header").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Omit the table header."),
    ),
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
        tsv: () => Output.writeRelation(result, noHeader),
        json: () => Output.writeJson(result, Documents.SetRelationJudgment),
      }),
    );
    yield* render;
  }),
).pipe(
  Command.withAlias("rel"),
  Command.withShortDescription("Test a relationship between two sets."),
  Command.withDescription(
    "Test a relationship between two taxon sets. Use stdin (-) on only one side.",
  ),
  Command.withExamples([
    {
      command:
        "robo-taxonomist set relation --relation subset --left-target Quercus --right-target Fagaceae",
      description: "Ask a directed subset question.",
    },
    {
      command:
        "robo-taxonomist set rel --relation overlap --left-targets-file panel.json --right-target Fagus --format json",
      description: "Compare a saved set with a target taxon.",
    },
  ]),
  Command.provide(({ model }) => Model.modelLayer(model)),
);

/** Expose set construction, composition and model-backed relation commands. */
export const sets = Command.make("set").pipe(
  Command.withShortDescription("Construct and combine taxon sets."),
  Command.withDescription("Construct and combine taxon sets."),
  Command.withSubcommands([create, difference, union, intersection, relation]),
);
