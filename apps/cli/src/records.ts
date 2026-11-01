import { Effect, FileSystem, Schema, Stdio, Stream } from "effect";
import { Argument, CliError, Flag } from "effect/cli";
import { CollectionExecution, RecordLabel } from "robo-taxonomist";
import { RecordDocument } from "./documents.ts";

export type InputRecord = RecordLabel | typeof RecordDocument.Type;

export const executionFlags = {
  batchSize: Flag.Int("batch-size").pipe(
    Flag.withSchema(CollectionExecution.schema.fields.batchSize),
    Flag.withDefault(16),
    Flag.withDescription("Maximum records per native provider request."),
  ),
  concurrency: Flag.Int("concurrency").pipe(
    Flag.withSchema(CollectionExecution.schema.fields.concurrency),
    Flag.withDefault(1),
    Flag.withDescription("Maximum concurrent native batch calls."),
  ),
};

export const recordFlags = {
  files: Argument.String("files").pipe(
    Argument.variadic(),
    Argument.withDescription("Record paths in order; - reads stdin."),
  ),
  records: Flag.String("record").pipe(
    Flag.withSchema(RecordLabel),
    Flag.atLeast(0),
    Flag.withDescription(
      "Literal record label; repeat to supply more records. Never treated as a file path.",
    ),
  ),
  format: Flag.Literals("records-format", ["text", "json", "jsonl"]).pipe(
    Flag.optional,
    Flag.withDescription("Override record file suffixes; stdin defaults to text."),
  ),
};

export const recordHelp =
  "Literal --record labels come first, then positional files in supplied order. Labels, identifying fields, JSON metadata and repeated occurrences remain unchanged. No sources means no records.\n\n" +
  "Files use newline text by default (labels, not scientific names), .json for an identifying record array, or .jsonl for one identifying record per line. --records-format overrides the suffix. stdin (-) defaults to text; structured stdin needs an explicit override. Invalid structured input never falls back to text.\n\n" +
  "Record JSON arrays are decoded one file at a time in memory; use newline text or JSONL for bounded record ingestion. Target sets are retained in memory. stdin can only be used once across both record and target sources.\n\n" +
  "Input or provider failure stops processing and fails the invocation, even if earlier groups have already been emitted. An emitted prefix is incomplete output, not a successful partial result.";

export const loadRecords = (
  labels: readonly RecordLabel[],
  paths: readonly string[],
  format?: "text" | "json" | "jsonl",
) =>
  Stream.fromIterable<InputRecord>(labels).pipe(
    Stream.concat(
      Stream.unwrap(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const stdio = yield* Stdio.Stdio;
          return Stream.fromIterable(paths).pipe(
            Stream.flatMap((path): Stream.Stream<InputRecord, CliError.UserError> => {
              const bytes = (path === "-" ? stdio.stdin : fs.stream(path)).pipe(
                Stream.mapError(
                  (cause) =>
                    new CliError.UserError({
                      cause,
                      userMessage: `${path}: Cannot read record source`,
                    }),
                ),
              );
              const encoding =
                format ??
                (path.endsWith(".json") ? "json" : path.endsWith(".jsonl") ? "jsonl" : "text");
              if (encoding === "json")
                return Stream.unwrap(
                  Effect.gen(function* () {
                    const text = yield* bytes.pipe(Stream.decodeText(), Stream.mkString);
                    const records = yield* Effect.try({
                      try: () =>
                        Schema.decodeUnknownSync(
                          Schema.fromJsonString(Schema.Array(RecordDocument)),
                        )(text),
                      catch: (cause) =>
                        new CliError.UserError({
                          cause,
                          userMessage: `${path}: Cannot decode record JSON; input is invalid or too deeply nested`,
                        }),
                    });
                    return Stream.fromIterable(records);
                  }),
                );
              const lineSchema =
                encoding === "jsonl" ? Schema.fromJsonString(RecordDocument) : RecordLabel;
              return bytes.pipe(
                Stream.decodeText(),
                Stream.splitLines,
                Stream.mapEffect((line, index) =>
                  Effect.try({
                    try: () => Schema.decodeUnknownSync(lineSchema)(line),
                    catch: (cause) =>
                      new CliError.UserError({
                        cause,
                        userMessage: `${path}:${index + 1}: Expected ${encoding === "jsonl" ? "an identifying record in JSONL" : "a nonblank record label"}`,
                      }),
                  }),
                ),
              );
            }),
          );
        }),
      ),
    ),
  );
