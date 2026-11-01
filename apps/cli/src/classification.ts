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
    format: Flag.Literals("format", ["tsv", "jsonl"]).pipe(Flag.withDefault("tsv")),
    execution: Inputs.executionFlags,
    noHeader: Flag.Boolean("no-header").pipe(Flag.withDefault(false)),
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
  Command.withDescription(
    "Classify records against the supplied panel using native match judgments and rankings. Repeated --target and --targets-file sources form one union, retaining occurrences and imported expression topology. Target encodings follow --targets-format, then .json/.jsonl suffix, then newline names; target stdin defaults to text.\n\n" +
      "Process sequential groups of at most batch-size × concurrency records; the library owns concurrency within each group. Tabular output emits record, target, judgment, support and ranking_position in record and target occurrence order, including negatives and uncertainty. Rankings contain accepted matches; unranked positions are empty. Support is native model support, not abundance or a normalized allocation across targets.\n\n" +
      "One header is emitted unless --no-header is supplied. Tabular output uses tab-delimited CSV: tabs, newlines and quotation marks in original labels/names are quoted. Use a CSV-aware reader with a tab delimiter. --format jsonl retains the complete panel, records/taxa/ranking, answers and usage for each bounded group, including identifying fields and metadata. Unknown token counts remain absent. Empty input emits one empty JSONL result; an empty panel retains all records with empty outcomes.\n\n" +
      "Use --model to override ROBO_TAXONOMIST_MODEL; no model is selected implicitly. Inject TYPESAFE_API_KEY through the environment. The client/model is acquired once per command; help needs no credentials. Negative and unresolved judgments succeed; provider and output errors fail the invocation.\n\n" +
      Inputs.recordHelp,
  ),
  Command.withExamples([
    {
      command:
        "robo-taxonomist classify detections-A.txt detections-B.txt --target Quercus --target Fagus --model your-model",
      description: "Classify plain labels and retain all outcomes in a table.",
    },
    {
      command:
        "robo-taxonomist cls - --records-format jsonl --targets-file panel.json --format jsonl --model your-model",
      description: "Retain structured records, panel topology and complete classification results.",
    },
  ]),
  Command.provide(({ model }) => Model.modelLayer(model)),
);
