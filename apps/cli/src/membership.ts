import { Console, Data, Effect, Match, Option, Predicate, Schema, Stream } from "effect";
import { Argument, CliError, Command, Flag } from "effect/cli";
import {
  CollectionExecution,
  RecordLabel,
  Taxonomy,
  type TaxonomicRecord,
  type TaxonMembershipJudgment,
} from "robo-taxonomist";
import { modelFailure, modelFlag, modelLayer } from "./model.ts";
import { checkStdin, loadTargets, targetFlags } from "./targets.ts";
import {
  executionFlags,
  loadRecords,
  recordFlags,
  recordHelp,
  type InputRecord,
} from "./records.ts";

const Judgment = Data.taggedEnum<TaxonMembershipJudgment>();

const configurationHelp =
  "Use --model to override ROBO_TAXONOMIST_MODEL; there is no implicit model default. Inject TYPESAFE_API_KEY through the environment. The selected command acquires one client/model; help needs no credentials. Negative, mixed, unresolved and clarification judgments are successful results.\n\n" +
  "Repeated --target names and --targets-file sources form one union, preserving occurrences. Target files default to newline names, .json to a record array or generated set artifact, and .jsonl to identifying records. --targets-format overrides the suffix; target stdin defaults to text. No target sources means the empty set.";

const tableHelp =
  "TSV contains judgment, record and clarification_target, with one header per invocation unless --no-header is supplied. Text requires an original record label and delimiter-free cells; use --format jsonl for identifying records without labels or delimiter-bearing text. JSONL retains each original record and its complete native judgment, including clarification targets.";

const writeJson = Effect.fn("Cli.writeMembershipJson")(function* (value: object) {
  const text = yield* Effect.try({
    try: () => JSON.stringify(value),
    catch: (cause) =>
      new CliError.UserError({
        cause,
        userMessage: "Cannot serialize membership result; metadata may be too deeply nested",
      }),
  });
  yield* Console.log(text);
});

const membershipCells = Effect.fnUntraced(function* (
  record: InputRecord,
  judgment: TaxonMembershipJudgment,
) {
  const original: string | TaxonomicRecord = record;
  const label = Predicate.isString(original) ? original : original.label;
  if (label === undefined)
    return yield* new CliError.UserError({
      cause: "Record has no original label; use --format jsonl to retain its identifiers",
    });
  const cells = yield* Match.value(judgment).pipe(
    Match.tagsExhaustive({
      Member: () => Effect.succeed(["Member", label, ""]),
      NotMember: () => Effect.succeed(["NotMember", label, ""]),
      MixedMembership: () => Effect.succeed(["MixedMembership", label, ""]),
      Undetermined: () => Effect.succeed(["Undetermined", label, ""]),
      MultipleTaxaInTarget: ({ target }) => {
        const name = target.record.scientificName ?? target.record.label;
        return name === undefined
          ? Effect.fail(
              new CliError.UserError({
                cause: "Clarification target has no text name or label; use --format jsonl",
              }),
            )
          : Effect.succeed(["MultipleTaxaInTarget", label, name]);
      },
    }),
  );
  return yield* Schema.decodeUnknownEffect(
    Schema.Array(Schema.String.check(Schema.isPattern(/^[^\t\r\n]*$/u))),
  )(cells).pipe(
    Effect.mapError(
      (cause) =>
        new CliError.UserError({
          cause,
          userMessage: "Membership text contains TSV delimiters; use --format jsonl",
        }),
    ),
  );
});

const check = Command.make(
  "check",
  {
    record: Argument.String("record").pipe(Argument.withSchema(RecordLabel)),
    target: targetFlags(),
    model: modelFlag,
    format: Flag.Literals("format", ["tsv", "jsonl"]).pipe(Flag.withDefault("tsv")),
    noHeader: Flag.Boolean("no-header").pipe(Flag.withDefault(false)),
  },
  Effect.fn("Cli.checkMembership")(function* ({ record, target, format, noHeader }) {
    const set = yield* loadTargets(
      target.targets,
      target.files,
      Option.getOrUndefined(target.format),
    );
    const judgment = yield* Taxonomy.recordBelongsTo(record, set).pipe(
      Effect.mapError(modelFailure),
    );
    if (format === "jsonl") {
      yield* writeJson({ record, judgment });
      return;
    }
    const cells = yield* membershipCells(record, judgment);
    if (!noHeader) yield* Console.log("judgment\trecord\tclarification_target");
    yield* Console.log(cells.join("\t"));
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
  Command.provide(({ model }) => modelLayer(model)),
);

const partition = Command.make(
  "partition",
  {
    input: recordFlags,
    target: targetFlags(),
    model: modelFlag,
    format: Flag.Literals("format", ["tsv", "jsonl"]).pipe(Flag.withDefault("tsv")),
    execution: executionFlags,
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
    yield* checkStdin([...input.files, ...target.files]);
    const set = yield* loadTargets(
      target.targets,
      target.files,
      Option.getOrUndefined(target.format),
    );
    if (format === "tsv" && !noHeader) yield* Console.log("judgment\trecord\tclarification_target");
    const write = (record: InputRecord, judgment: TaxonMembershipJudgment) =>
      format === "jsonl"
        ? writeJson({ record, judgment })
        : membershipCells(record, judgment).pipe(
            Effect.flatMap((cells) => Console.log(cells.join("\t"))),
          );
    yield* loadRecords(input.records, input.files, Option.getOrUndefined(input.format)).pipe(
      Stream.grouped(execution.batchSize * execution.concurrency),
      Stream.runForEach((records) =>
        Effect.gen(function* () {
          const result = yield* Taxonomy.partitionRecordsByMembership(records, set, {
            execution,
          }).pipe(Effect.mapError(modelFailure));
          for (const record of result.Member) yield* write(record, Judgment.Member());
          for (const record of result.NotMember) yield* write(record, Judgment.NotMember());
          for (const record of result.MixedMembership)
            yield* write(record, Judgment.MixedMembership());
          for (const record of result.Undetermined) yield* write(record, Judgment.Undetermined());
          for (const { record, target } of result.MultipleTaxaInTarget)
            yield* write(record, Judgment.MultipleTaxaInTarget({ target }));
        }),
      ),
    );
  }),
).pipe(
  Command.withAlias("part"),
  Command.withDescription(
    "Partition record inputs into the five native membership buckets. Process sequential groups of at most batch-size × concurrency records; the library owns concurrency within each group. Emit Member, NotMember, MixedMembership, Undetermined, then MultipleTaxaInTarget, retaining input order within each group and bucket.\n\n" +
      configurationHelp +
      "\n\n" +
      tableHelp +
      "\n\n" +
      recordHelp,
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
  Command.provide(({ model }) => modelLayer(model)),
);

const quantifier = (name: "all" | "any" | "none", operation: typeof Taxonomy.allRecordsBelongTo) =>
  Command.make(
    name,
    {
      input: recordFlags,
      target: targetFlags(),
      model: modelFlag,
      execution: executionFlags,
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
      yield* checkStdin([...input.files, ...target.files]);
      const set = yield* loadTargets(
        target.targets,
        target.files,
        Option.getOrUndefined(target.format),
      );
      const records = yield* loadRecords(
        input.records,
        input.files,
        Option.getOrUndefined(input.format),
      ).pipe(Stream.runCollect);
      const result = yield* operation(records, set, {
        execution: CollectionExecution.make(flags),
      }).pipe(Effect.mapError(modelFailure));
      if (format === "json") {
        yield* writeJson(result);
        return;
      }
      const cells = yield* Match.value(result).pipe(
        Match.tagsExhaustive({
          Yes: ({ quantifier }) => Effect.succeed(["Yes", quantifier, ""]),
          No: ({ quantifier }) => Effect.succeed(["No", quantifier, ""]),
          Undetermined: ({ quantifier }) => Effect.succeed(["Undetermined", quantifier, ""]),
          MultipleTaxaInTarget: ({ quantifier, target }) => {
            const original: TaxonomicRecord = target.record;
            const name = original.scientificName ?? original.label;
            return name === undefined
              ? Effect.fail(
                  new CliError.UserError({
                    cause: "Clarification target has no text name or label; use --format json",
                  }),
                )
              : Effect.succeed(["MultipleTaxaInTarget", quantifier, name]);
          },
        }),
      );
      yield* Schema.decodeUnknownEffect(
        Schema.Array(Schema.String.check(Schema.isPattern(/^[^\t\r\n]*$/u))),
      )(cells).pipe(
        Effect.mapError(
          (cause) =>
            new CliError.UserError({
              cause,
              userMessage: "Clarification text contains TSV delimiters; use --format json",
            }),
        ),
      );
      if (!noHeader) yield* Console.log("judgment\tquantifier\tclarification_target");
      yield* Console.log(cells.join("\t"));
    }),
  ).pipe(
    Command.withDescription(
      `Ask the native ${name} whole-record membership question. Collects the complete input in memory and invokes the native quantifier once. No per-group reduction or CLI input cap is applied. Native ordering determines decisive answers, uncertainty and clarification.\n\n` +
        configurationHelp +
        "\n\nTSV contains judgment, quantifier and clarification_target, with one header unless --no-header is supplied. Use --format json for the complete native judgment, including identifier-only or delimiter-bearing clarification targets.\n\n" +
        recordHelp,
    ),
    Command.withExamples([
      {
        command: `robo-taxonomist mem ${name} detections.txt --target Quercus --model your-model --format json`,
        description: "Ask one question about the complete input collection.",
      },
    ]),
    Command.provide(({ model }) => modelLayer(model)),
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
