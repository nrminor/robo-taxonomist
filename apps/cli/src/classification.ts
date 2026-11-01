import { Effect, Match, Option, Stream } from "effect";
import { Command, Flag } from "effect/cli";
import { CollectionExecution, Taxonomy } from "robo-taxonomist";
import * as Inputs from "./inputs.ts";
import * as Model from "./model.ts";
import * as Output from "./output.ts";
import * as Presentation from "./presentation.ts";

export const classify = Command.make(
  "classify",
  {
    input: Inputs.recordFlags,
    target: Inputs.targetFlags(),
    model: Model.modelFlag,
    format: Flag.Literals("format", ["tsv", "jsonl"]).pipe(
      Flag.withDefault("tsv"),
      Flag.withDescription(
        "Tab-delimited CSV (default), or JSONL. Each JSONL line contains records and their results.",
      ),
    ),
    execution: Inputs.executionFlags,
    noHeader: Flag.Boolean("no-header").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Omit the table header."),
    ),
  },
  Effect.fn("Cli.classify")(function* ({ input, target, format, execution: flags, noHeader }) {
    const execution = CollectionExecution.make(flags);
    const paths = [...input.files, ...target.files];
    yield* Inputs.checkStdin(paths);

    const targetFormat = Option.getOrUndefined(target.format);
    const panel = yield* Inputs.loadTargets(target.targets, target.files, targetFormat);
    const recordFormat = Option.getOrUndefined(input.format);
    const records = Inputs.loadRecords(input.records, input.files, recordFormat);
    const groupSize = execution.batchSize * execution.concurrency;

    const groups = records.pipe(
      Stream.grouped(groupSize),
      Stream.orElseIfEmpty(() => Stream.succeed<readonly Inputs.InputRecord[]>([])),
      Stream.mapEffect((group) =>
        Taxonomy.classifyRecords(group, panel, { execution }).pipe(
          Effect.mapError(Model.modelFailure),
        ),
      ),
    );

    const render = Match.value(format).pipe(
      Match.literalsExhaustive({
        tsv: () => {
          const rows = groups.pipe(Stream.flatMap(Presentation.classificationRows));
          const writeRows = Output.writeTable(Presentation.ClassificationRow, noHeader);
          return writeRows(rows);
        },
        jsonl: () => Output.writeJsonLines(groups),
      }),
    );

    yield* render;
  }),
).pipe(
  Command.withAlias("cls"),
  Command.withShortDescription("Classify records against a target panel."),
  Command.withDescription(
    "Classify records against a panel of target taxa and rank their matches. Support is the model-reported probability of a match.\n\n" +
      Inputs.recordHelp +
      "\n\nFor large inputs, prefer text or JSONL; JSON arrays are loaded in full. If a run fails, any output already written is incomplete.",
  ),
  Command.withExamples([
    {
      command:
        "robo-taxonomist classify detections-A.txt detections-B.txt --target Quercus --target Fagus --model your-model",
      description: "Classify labels from text files.",
    },
    {
      command:
        "robo-taxonomist cls - --records-format jsonl --targets-file panel.json --format jsonl --model your-model",
      description: "Read JSONL from stdin and keep answers and metadata in the output.",
    },
  ]),
  Command.provide(({ model }) => Model.modelLayer(model)),
);
