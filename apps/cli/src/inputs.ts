import { Array, Effect, FileSystem, Match, Schema, Stdio, Stream } from "effect";
import { Argument, CliError, Flag } from "effect/cli";
import { CollectionExecution, RecordLabel, TaxonName, TaxonSet } from "robo-taxonomist";
import * as Documents from "./documents.ts";

const inputEncodings = ["text", "json", "jsonl"] as const;
type InputEncoding = (typeof inputEncodings)[number];
type InputRecord = RecordLabel | typeof Documents.RecordDocument.Type;
export type { InputRecord };

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
  format: Flag.Literals("records-format", inputEncodings).pipe(
    Flag.optional,
    Flag.withDescription("Override record file suffixes; stdin defaults to text."),
  ),
};

export const targetFlags = (prefix = "") => ({
  targets: Flag.String(`${prefix}target`).pipe(
    Flag.withSchema(TaxonName),
    Flag.atLeast(0),
    Flag.withDescription("Literal target name; repeat to form a union."),
  ),
  files: Flag.String(`${prefix}targets-file`).pipe(
    Flag.atLeast(0),
    Flag.withDescription("Target file, or - for stdin. Repeat to combine sources."),
  ),
  format: Flag.Literals(`${prefix}targets-format`, inputEncodings).pipe(
    Flag.optional,
    Flag.withDescription("Override file suffix detection; stdin defaults to text."),
  ),
});

export const recordHelp =
  "Literal --record labels come first, then positional files in supplied order. Labels, identifying fields, JSON metadata and repeated occurrences remain unchanged. No sources means no records.\n\n" +
  "Files use newline text by default (labels, not scientific names), .json for an identifying record array, or .jsonl for one identifying record per line. --records-format overrides the suffix. stdin (-) defaults to text; structured stdin needs an explicit override. Invalid structured input never falls back to text.\n\n" +
  "Record JSON arrays are decoded one file at a time in memory; use newline text or JSONL for bounded record ingestion. Target sets are retained in memory. stdin can only be used once across both record and target sources.\n\n" +
  "Input or provider failure stops processing and fails the invocation, even if earlier groups have already been emitted. An emitted prefix is incomplete output, not a successful partial result.";

export const checkStdin = (paths: readonly string[]) =>
  paths.filter((path) => path === "-").length > 1
    ? Effect.fail(new CliError.UserError({ cause: "stdin can only be used once per invocation" }))
    : Effect.void;

type SourceUnit = {
  readonly path: string;
  readonly encoding: InputEncoding;
  readonly text: string;
  readonly line?: number;
};

const readSources = (
  paths: readonly string[],
  format: InputEncoding | undefined,
  role: "record" | "target",
) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const stdio = yield* Stdio.Stdio;
      return Stream.fromIterable(paths).pipe(
        Stream.flatMap((path): Stream.Stream<SourceUnit, CliError.UserError> => {
          const location = role === "target" && path === "-" ? "stdin" : path;
          const encoding =
            format ??
            (path.endsWith(".json") ? "json" : path.endsWith(".jsonl") ? "jsonl" : "text");
          const text = (path === "-" ? stdio.stdin : fs.stream(path)).pipe(
            Stream.mapError(
              (cause) =>
                new CliError.UserError({
                  cause,
                  userMessage: `${location}: Cannot read ${role} source`,
                }),
            ),
            Stream.decodeText(),
          );
          const lines = () =>
            text.pipe(
              Stream.splitLines,
              Stream.map((line, index) => ({
                path: location,
                encoding,
                text: line,
                line: index + 1,
              })),
            );
          return Match.value(encoding).pipe(
            Match.literalsExhaustive({
              text: lines,
              jsonl: lines,
              json: () =>
                Stream.fromEffect(
                  text.pipe(
                    Stream.mkString,
                    Effect.map((content) => ({ path: location, encoding, text: content })),
                  ),
                ),
            }),
          );
        }),
      );
    }),
  );

const recordJson = Schema.fromJsonString(Schema.Array(Documents.RecordDocument));
const recordLine = Schema.fromJsonString(Documents.RecordDocument);
const targetJson = Schema.fromJsonString(
  Schema.Union([Schema.Array(Documents.RecordDocument), Documents.SetDocument]),
);

const decodeRecords = Effect.fnUntraced(function* (unit: SourceUnit) {
  return yield* Effect.try({
    try: () =>
      Match.value(unit.encoding).pipe(
        Match.literalsExhaustive({
          text: () => [Schema.decodeUnknownSync(RecordLabel)(unit.text)],
          jsonl: () => [Schema.decodeUnknownSync(recordLine)(unit.text)],
          json: () => Schema.decodeUnknownSync(recordJson)(unit.text),
        }),
      ),
    catch: (cause) =>
      new CliError.UserError({
        cause,
        userMessage: Match.value(unit.encoding).pipe(
          Match.literalsExhaustive({
            text: () => `${unit.path}:${unit.line}: Expected a nonblank record label`,
            jsonl: () => `${unit.path}:${unit.line}: Expected an identifying record in JSONL`,
            json: () =>
              `${unit.path}: Cannot decode record JSON; input is invalid or too deeply nested`,
          }),
        ),
      }),
  });
});

const decodeTargets = Effect.fnUntraced(function* (unit: SourceUnit) {
  return yield* Effect.try({
    try: () =>
      Match.value(unit.encoding).pipe(
        Match.literalsExhaustive({
          text: () => [TaxonSet.of(Schema.decodeUnknownSync(TaxonName)(unit.text))],
          jsonl: () => [TaxonSet.of(Schema.decodeUnknownSync(recordLine)(unit.text))],
          json: () => {
            const document = Schema.decodeUnknownSync(targetJson)(unit.text);
            return Array.isArray<typeof document>(document)
              ? document.map((record) => TaxonSet.of(record))
              : [Documents.restoreSet(document)];
          },
        }),
      ),
    catch: (cause) =>
      new CliError.UserError({
        cause,
        userMessage: Match.value(unit.encoding).pipe(
          Match.literalsExhaustive({
            text: () => `${unit.path}:${unit.line}: Expected a nonblank target name`,
            jsonl: () =>
              `${unit.path}:${unit.line}: Expected an identifying target record in JSONL`,
            json: () =>
              `${unit.path}: Cannot decode target JSON; input is invalid or too deeply nested`,
          }),
        ),
      }),
  });
});

export const loadRecords = (
  labels: readonly RecordLabel[],
  paths: readonly string[],
  format?: InputEncoding,
) => {
  const files = readSources(paths, format, "record").pipe(
    Stream.mapEffect(decodeRecords),
    Stream.flatMap((records) => Stream.fromIterable<InputRecord>(records)),
  );
  return Stream.fromIterable<InputRecord>(labels).pipe(Stream.concat(files));
};

export const loadTargets = Effect.fnUntraced(function* (
  names: readonly TaxonName[],
  paths: readonly string[],
  format?: InputEncoding,
) {
  const files = readSources(paths, format, "target").pipe(
    Stream.mapEffect(decodeTargets),
    Stream.flatMap((sets) => Stream.fromIterable<TaxonSet.TaxonSet>(sets)),
  );
  const sets = yield* Stream.fromIterable(names).pipe(
    Stream.map((name) => TaxonSet.of(name)),
    Stream.concat(files),
    Stream.runCollect,
  );
  return TaxonSet.unionAll(sets);
});
