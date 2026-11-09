import { Array, Effect, FileSystem, Match, Schema, Stdio, Stream } from "effect";
import { Argument, CliError, Flag } from "effect/cli";
import { CollectionExecution, RecordLabel, TaxonName, TaxonSet } from "robo-taxonomist";
import * as Documents from "./documents.ts";

const inputEncodings = ["text", "json", "jsonl"] as const;
type InputEncoding = (typeof inputEncodings)[number];
/** Accept either an original record label or an identifying record with JSON metadata. */
export type InputRecord = RecordLabel | Documents.RecordDocument;

/** Configure record batch size and model-request concurrency. */
export const executionFlags = {
  batchSize: Flag.Int("batch-size").pipe(
    Flag.withSchema(CollectionExecution.schema.fields.batchSize),
    Flag.withDefault(16),
    Flag.withDescription("Records per model request (default: 16)."),
  ),
  concurrency: Flag.Int("concurrency").pipe(
    Flag.withSchema(CollectionExecution.schema.fields.concurrency),
    Flag.withDefault(1),
    Flag.withDescription("Model requests to run at once (default: 1)."),
  ),
};

/** Read record labels, ordered file paths and an optional file-format override. */
export const recordFlags = {
  files: Argument.String("files").pipe(
    Argument.variadic(),
    Argument.withDescription("Record files, read in order; - reads stdin."),
  ),
  records: Flag.String("record").pipe(
    Flag.withSchema(RecordLabel),
    Flag.atLeast(0),
    Flag.withDescription("Record label; repeat as needed. These precede file inputs."),
  ),
  format: Flag.Literals("records-format", inputEncodings).pipe(
    Flag.optional,
    Flag.withDescription("Use this format for record files; stdin defaults to text."),
  ),
};

/** Define target-name and file flags, optionally prefixed for a set operand. */
export const targetFlags = (prefix = "") => ({
  targets: Flag.String(`${prefix}target`).pipe(
    Flag.withSchema(TaxonName),
    Flag.atLeast(0),
    Flag.withDescription("Target name; repeat to form a union before file targets."),
  ),
  files: Flag.String(`${prefix}targets-file`).pipe(
    Flag.atLeast(0),
    Flag.withDescription(
      "Target file: text names, .json record array or saved set, or .jsonl records; - reads stdin.",
    ),
  ),
  format: Flag.Literals(`${prefix}targets-format`, inputEncodings).pipe(
    Flag.optional,
    Flag.withDescription("Use this format for target files; stdin defaults to text."),
  ),
});

/** Explain supported record files and the shared stdin constraint in command help. */
export const recordHelp =
  "Read one label per line from text files, a record array from .json, or one record per line from .jsonl. JSON records need a label, scientificName or taxonId. Use stdin (-) only once across record and target inputs.";

/** Reject commands that would read stdin through more than one input source. */
export const checkStdin = (paths: readonly string[]) =>
  paths.filter((path) => path === "-").length > 1
    ? new CliError.UserError({ cause: "stdin can only be used once per invocation" })
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
          text: () => [Schema.decodeSync(RecordLabel)(unit.text)],
          jsonl: () => [Schema.decodeSync(recordLine)(unit.text)],
          json: () => Schema.decodeSync(recordJson)(unit.text),
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
          text: () => [TaxonSet.of(Schema.decodeSync(TaxonName)(unit.text))],
          jsonl: () => [TaxonSet.of(Schema.decodeSync(recordLine)(unit.text))],
          json: () => {
            const document = Schema.decodeSync(targetJson)(unit.text);
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

/** Stream literal labels followed by decoded record files in source order. */
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

/** Collect target sources in order and combine them with the library's union constructor. */
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
