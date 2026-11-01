import { Effect, Match, Option, Stream } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { CollectionExecution, RecordLabel, Taxonomy } from "robo-taxonomist";
import * as Documents from "./documents.ts";
import * as Inputs from "./inputs.ts";
import * as Model from "./model.ts";
import * as Output from "./output.ts";
import * as Presentation from "./presentation.ts";

const check = Command.make(
  "check",
  {
    record: Argument.String("record").pipe(Argument.withSchema(RecordLabel)),
    target: Inputs.targetFlags(),
    model: Model.modelFlag,
    format: Flag.Literals("format", ["tsv", "jsonl"]).pipe(
      Flag.withDefault("tsv"),
      Flag.withDescription(
        "Tab-delimited CSV (default), or JSONL. Use JSONL for identifier-only targets.",
      ),
    ),
    noHeader: Flag.Boolean("no-header").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Omit the table header."),
    ),
  },
  Effect.fn("Cli.checkMembership")(function* ({ record, target, format, noHeader }) {
    yield* Inputs.checkStdin(target.files);

    const targetFormat = Option.getOrUndefined(target.format);
    const set = yield* Inputs.loadTargets(target.targets, target.files, targetFormat);
    const judgment = yield* Taxonomy.recordBelongsTo(record, set).pipe(
      Effect.mapError(Model.modelFailure),
    );
    const entries = Stream.succeed({ record, judgment });

    const render = Match.value(format).pipe(
      Match.literalsExhaustive({
        tsv: () =>
          Effect.gen(function* () {
            const row = yield* Presentation.membershipRow({ record, judgment });
            const rows = Stream.succeed(row);
            const writeRows = Output.writeTable(Presentation.MembershipRow, noHeader);
            yield* writeRows(rows);
          }),
        jsonl: () => Output.writeJsonLines(entries),
      }),
    );

    yield* render;
  }),
).pipe(
  Command.withShortDescription("Check one record's membership."),
  Command.withDescription("Check one record label against a target set."),
  Command.withExamples([
    {
      command: 'robo-taxonomist mem check "Voucher A17" --target Quercus --model your-model',
      description: "Check a record against a target taxon.",
    },
  ]),
  Command.provide(({ model }) => Model.modelLayer(model)),
);

const partition = Command.make(
  "partition",
  {
    input: Inputs.recordFlags,
    target: Inputs.targetFlags(),
    model: Model.modelFlag,
    format: Flag.Literals("format", ["tsv", "jsonl"]).pipe(
      Flag.withDefault("tsv"),
      Flag.withDescription(
        "Tab-delimited CSV (default), or JSONL. Use JSONL for records without labels.",
      ),
    ),
    execution: Inputs.executionFlags,
    noHeader: Flag.Boolean("no-header").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Omit the table header."),
    ),
  },
  Effect.fn("Cli.partitionMembership")(function* ({
    input,
    target,
    format,
    execution: flags,
    noHeader,
  }) {
    const execution = CollectionExecution.make(flags);
    const paths = [...input.files, ...target.files];
    yield* Inputs.checkStdin(paths);

    const targetFormat = Option.getOrUndefined(target.format);
    const set = yield* Inputs.loadTargets(target.targets, target.files, targetFormat);
    const recordFormat = Option.getOrUndefined(input.format);
    const records = Inputs.loadRecords(input.records, input.files, recordFormat);
    const groupSize = execution.batchSize * execution.concurrency;

    const partitions = records.pipe(
      Stream.grouped(groupSize),
      Stream.mapEffect((group) =>
        Taxonomy.partitionRecordsByMembership(group, set, { execution }).pipe(
          Effect.mapError(Model.modelFailure),
        ),
      ),
    );
    const entries = partitions.pipe(Stream.flatMap(Presentation.partitionEntries));

    const render = Match.value(format).pipe(
      Match.literalsExhaustive({
        tsv: () => {
          const rows = entries.pipe(Stream.mapEffect(Presentation.membershipRow));
          const writeRows = Output.writeTable(Presentation.MembershipRow, noHeader);
          return writeRows(rows);
        },
        jsonl: () => Output.writeJsonLines(entries),
      }),
    );

    yield* render;
  }),
).pipe(
  Command.withAlias("part"),
  Command.withShortDescription("Group records by membership outcome."),
  Command.withDescription(
    "Group records by membership outcome, including mixed membership and uncertainty.\n\n" +
      Inputs.recordHelp +
      "\n\nFor large inputs, prefer text or JSONL; JSON arrays are loaded in full. If a run fails, any output already written is incomplete.",
  ),
  Command.withExamples([
    {
      command:
        "robo-taxonomist mem part detections-A.txt detections-B.txt --target Quercus --target Fagus --model your-model",
      description: "Group labels from text files against two target taxa.",
    },
    {
      command:
        "robo-taxonomist membership partition - --records-format jsonl --targets-file panel.json --format jsonl --model your-model",
      description: "Read JSONL from stdin and retain record metadata.",
    },
  ]),
  Command.provide(({ model }) => Model.modelLayer(model)),
);

const quantifier = (
  name: "all" | "any" | "none",
  operation: typeof Taxonomy.allRecordsBelongTo,
) => {
  const description = {
    all: "Check whether every record belongs to the target.",
    any: "Check whether at least one record belongs to the target.",
    none: "Check whether no records belong to the target.",
  }[name];

  return Command.make(
    name,
    {
      input: Inputs.recordFlags,
      target: Inputs.targetFlags(),
      model: Model.modelFlag,
      execution: Inputs.executionFlags,
      format: Flag.Literals("format", ["tsv", "json"]).pipe(
        Flag.withDefault("tsv"),
        Flag.withDescription("Write the judgment as tab-delimited CSV (default) or JSON."),
      ),
      noHeader: Flag.Boolean("no-header").pipe(
        Flag.withDefault(false),
        Flag.withDescription("Omit the table header."),
      ),
    },
    Effect.fn("Cli.quantifyMembership")(function* ({
      input,
      target,
      execution: flags,
      format,
      noHeader,
    }) {
      const execution = CollectionExecution.make(flags);
      const paths = [...input.files, ...target.files];
      yield* Inputs.checkStdin(paths);

      const targetFormat = Option.getOrUndefined(target.format);
      const set = yield* Inputs.loadTargets(target.targets, target.files, targetFormat);
      const recordFormat = Option.getOrUndefined(input.format);
      const recordStream = Inputs.loadRecords(input.records, input.files, recordFormat);
      const records = yield* Stream.runCollect(recordStream);
      const result = yield* operation(records, set, { execution }).pipe(
        Effect.mapError(Model.modelFailure),
      );

      const render = Match.value(format).pipe(
        Match.literalsExhaustive({
          tsv: () =>
            Effect.gen(function* () {
              const row = yield* Presentation.quantifierRow(result);
              const rows = Stream.succeed(row);
              const writeRows = Output.writeTable(Presentation.QuantifierRow, noHeader);
              yield* writeRows(rows);
            }),
          json: () => Output.writeJson(result, Documents.QuantifierJudgment),
        }),
      );

      yield* render;
    }),
  ).pipe(
    Command.withShortDescription(description),
    Command.withDescription(
      description + " This command loads all records into memory.\n\n" + Inputs.recordHelp,
    ),
    Command.withExamples([
      {
        command: `robo-taxonomist mem ${name} detections.txt --target Quercus --model your-model --format json`,
        description: "Read records from a text file and write the judgment as JSON.",
      },
    ]),
    Command.provide(({ model }) => Model.modelLayer(model)),
  );
};

export const membership = Command.make("membership").pipe(
  Command.withAlias("mem"),
  Command.withShortDescription("Check record membership."),
  Command.withDescription("Check records against a target set."),
  Command.withSubcommands([
    check,
    partition,
    quantifier("all", Taxonomy.allRecordsBelongTo),
    quantifier("any", Taxonomy.anyRecordBelongsTo),
    quantifier("none", Taxonomy.noRecordBelongsTo),
  ]),
);
