import { Console, Effect, Match, Option, Predicate, Schema, Stream } from "effect";
import { CliError, Command, Flag } from "effect/cli";
import { CollectionExecution, Taxonomy, type TaxonomicRecord } from "robo-taxonomist";
import { modelFailure, modelFlag, modelLayer } from "./model.ts";
import {
  executionFlags,
  loadRecords,
  recordFlags,
  recordHelp,
  type InputRecord,
} from "./records.ts";
import { checkStdin, loadTargets, targetFlags } from "./targets.ts";

export const classify = Command.make(
  "classify",
  {
    input: recordFlags,
    target: targetFlags(),
    model: modelFlag,
    format: Flag.Literals("format", ["tsv", "jsonl"]).pipe(Flag.withDefault("tsv")),
    execution: executionFlags,
    noHeader: Flag.Boolean("no-header").pipe(Flag.withDefault(false)),
  },
  Effect.fn("Cli.classify")(function* ({ input, target, format, execution: flags, noHeader }) {
    const execution = CollectionExecution.make(flags);
    yield* checkStdin([...input.files, ...target.files]);
    const panel = yield* loadTargets(
      target.targets,
      target.files,
      Option.getOrUndefined(target.format),
    );
    if (format === "tsv" && !noHeader)
      yield* Console.log("record\ttarget\tjudgment\tsupport\tranking_position");
    yield* loadRecords(input.records, input.files, Option.getOrUndefined(input.format)).pipe(
      Stream.grouped(execution.batchSize * execution.concurrency),
      Stream.orElseIfEmpty(() => Stream.succeed<readonly InputRecord[]>([])),
      Stream.runForEach((records) =>
        Effect.gen(function* () {
          const result = yield* Taxonomy.classifyRecords(records, panel, { execution }).pipe(
            Effect.mapError(modelFailure),
          );
          if (format === "jsonl") {
            const text = yield* Effect.try({
              try: () => JSON.stringify(result),
              catch: (cause) =>
                new CliError.UserError({
                  cause,
                  userMessage:
                    "Cannot serialize classification result; metadata may be too deeply nested",
                }),
            });
            yield* Console.log(text);
            return;
          }
          for (const row of result.records) {
            if (row.taxa.length === 0) continue;
            const positions = new Map(row.ranking.map((match, index) => [match, index + 1]));
            const original: string | TaxonomicRecord = row.record;
            const record = Predicate.isString(original) ? original : original.label;
            if (record === undefined)
              return yield* new CliError.UserError({
                cause: "Record has no original label; use --format jsonl to retain its identifiers",
              });
            for (const match of row.taxa) {
              const taxon: TaxonomicRecord = match.taxon.record;
              const name = taxon.scientificName ?? taxon.label;
              if (name === undefined)
                return yield* new CliError.UserError({
                  cause:
                    "Target has no original name or label; use --format jsonl to retain its identifiers",
                });
              const judgment = Match.value(match.judgment).pipe(
                Match.tagsExhaustive({
                  Matched: () => "Matched",
                  NotMatched: () => "NotMatched",
                  Undetermined: () => "Undetermined",
                }),
              );
              const position = positions.get(match);
              yield* Schema.decodeUnknownEffect(
                Schema.Array(Schema.String.check(Schema.isPattern(/^[^\t\r\n]*$/u))),
              )([record, name]).pipe(
                Effect.mapError(
                  (cause) =>
                    new CliError.UserError({
                      cause,
                      userMessage:
                        "Classification text contains TSV delimiters; use --format jsonl",
                    }),
                ),
              );
              yield* Console.log(
                [record, name, judgment, match.support, position ?? ""].join("\t"),
              );
            }
          }
        }),
      ),
    );
  }),
).pipe(
  Command.withAlias("cls"),
  Command.withDescription(
    "Classify records against the supplied panel using native match judgments and rankings. Repeated --target and --targets-file sources form one union, retaining occurrences and imported expression topology. Target encodings follow --targets-format, then .json/.jsonl suffix, then newline names; target stdin defaults to text.\n\n" +
      "Process sequential groups of at most batch-size × concurrency records; the library owns concurrency within each group. TSV emits record, target, judgment, support and ranking_position in record and target occurrence order, including negatives and uncertainty. Rankings contain accepted matches; unranked positions are empty. Support is native model support, not abundance or a normalized allocation across targets.\n\n" +
      "One TSV header is emitted unless --no-header is supplied. TSV requires original labels/names and delimiter-free cells. --format jsonl retains the complete panel, records/taxa/ranking, answers and usage for each bounded group, including identifying fields and metadata. Unknown token counts remain absent. Empty input emits one empty JSONL result; an empty panel retains all records with empty outcomes.\n\n" +
      "Use --model to override ROBO_TAXONOMIST_MODEL; no model is selected implicitly. Inject TYPESAFE_API_KEY through the environment. The client/model is acquired once per command; help needs no credentials. Negative and unresolved judgments succeed; provider and output errors fail the invocation.\n\n" +
      recordHelp,
  ),
  Command.withExamples([
    {
      command:
        "robo-taxonomist classify detections-A.txt detections-B.txt --target Quercus --target Fagus --model your-model",
      description: "Classify plain labels and retain all outcomes in TSV.",
    },
    {
      command:
        "robo-taxonomist cls - --records-format jsonl --targets-file panel.json --format jsonl --model your-model",
      description: "Retain structured records, panel topology and complete classification results.",
    },
  ]),
  Command.provide(({ model }) => modelLayer(model)),
);
