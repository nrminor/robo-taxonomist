import { Effect, Match, Option, Stream } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { CollectionExecution, RecordLabel, Taxonomy } from "robo-taxonomist";
import * as Documents from "./documents.ts";
import * as Inputs from "./inputs.ts";
import * as Model from "./model.ts";
import * as Output from "./output.ts";
import * as Presentation from "./presentation.ts";

const configurationHelp =
  "Use --model to override ROBO_TAXONOMIST_MODEL; there is no implicit model default. Inject TYPESAFE_API_KEY through the environment. The selected command acquires one client/model; help needs no credentials. Negative, mixed, unresolved and clarification judgments are successful results.\n\n" +
  "Repeated --target names and --targets-file sources form one union, preserving occurrences. Target files default to newline names, .json to a record array or generated set artifact, and .jsonl to identifying records. --targets-format overrides the suffix; target stdin defaults to text. No target sources means the empty set.";

const tableHelp =
  "Tabular output contains judgment, record and clarification_target, with one header per invocation unless --no-header is supplied. It uses tab-delimited CSV, quoting tabs, newlines and quotation marks. Use a CSV-aware reader with a tab delimiter. Records require original labels; --format jsonl retains identifying records without labels, arbitrary metadata and the complete native judgment, including clarification targets.";

const check = Command.make(
  "check",
  {
    record: Argument.String("record").pipe(Argument.withSchema(RecordLabel)),
    target: Inputs.targetFlags(),
    model: Model.modelFlag,
    format: Flag.Literals("format", ["tsv", "jsonl"]).pipe(Flag.withDefault("tsv")),
    noHeader: Flag.Boolean("no-header").pipe(Flag.withDefault(false)),
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
  Command.withDescription(
    "Check one literal record label against the supplied target set.\n\n" +
      configurationHelp +
      "\n\n" +
      tableHelp,
  ),
  Command.withExamples([
    {
      command: 'robo-taxonomist mem check "Voucher A17" --target Quercus --model your-model',
      description: "Check one supplied label without inferring a scientific-name field.",
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
    format: Flag.Literals("format", ["tsv", "jsonl"]).pipe(Flag.withDefault("tsv")),
    execution: Inputs.executionFlags,
    noHeader: Flag.Boolean("no-header").pipe(Flag.withDefault(false)),
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
  Command.withDescription(
    "Partition record inputs into the five native membership buckets. Process sequential groups of at most batch-size × concurrency records; the library owns concurrency within each group. Emit Member, NotMember, MixedMembership, Undetermined, then MultipleTaxaInTarget, retaining input order within each group and bucket.\n\n" +
      configurationHelp +
      "\n\n" +
      tableHelp +
      "\n\n" +
      Inputs.recordHelp,
  ),
  Command.withExamples([
    {
      command:
        "robo-taxonomist mem part detections-A.txt detections-B.txt --target Quercus --target Fagus --model your-model",
      description: "Partition multiple plain files against one union of targets.",
    },
    {
      command:
        "robo-taxonomist membership partition - --records-format jsonl --targets-file panel.json --format jsonl --model your-model",
      description: "Retain identifying fields and metadata from structured stdin.",
    },
  ]),
  Command.provide(({ model }) => Model.modelLayer(model)),
);

const quantifier = (name: "all" | "any" | "none", operation: typeof Taxonomy.allRecordsBelongTo) =>
  Command.make(
    name,
    {
      input: Inputs.recordFlags,
      target: Inputs.targetFlags(),
      model: Model.modelFlag,
      execution: Inputs.executionFlags,
      format: Flag.Literals("format", ["tsv", "json"]).pipe(Flag.withDefault("tsv")),
      noHeader: Flag.Boolean("no-header").pipe(Flag.withDefault(false)),
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
    Command.withDescription(
      `Ask the native ${name} whole-record membership question. Collects the complete input in memory and invokes the native quantifier once. Native ordering determines decisive answers, uncertainty and clarification.\n\n` +
        configurationHelp +
        "\n\nTabular output contains judgment, quantifier and clarification_target, with one header unless --no-header is supplied. Tab-delimited CSV quotes tabs, newlines and quotation marks; use a CSV-aware reader. Use --format json for the complete native judgment, including identifier-only clarification targets.\n\n" +
        Inputs.recordHelp,
    ),
    Command.withExamples([
      {
        command: `robo-taxonomist mem ${name} detections.txt --target Quercus --model your-model --format json`,
        description: "Ask one question about the complete input collection.",
      },
    ]),
    Command.provide(({ model }) => Model.modelLayer(model)),
  );

export const membership = Command.make("membership").pipe(
  Command.withAlias("mem"),
  Command.withDescription("Check and partition record membership and ask collection quantifiers."),
  Command.withSubcommands([
    check,
    partition,
    quantifier("all", Taxonomy.allRecordsBelongTo),
    quantifier("any", Taxonomy.anyRecordBelongsTo),
    quantifier("none", Taxonomy.noRecordBelongsTo),
  ]),
);
