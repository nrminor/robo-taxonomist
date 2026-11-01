import { Array, Effect, FileSystem, Schema, Stdio, Stream } from "effect";
import { CliError, Flag } from "effect/cli";
import { TaxonName, TaxonSet } from "robo-taxonomist";
import { RecordDocument, SetDocument, restoreSet } from "./documents.ts";

const targetJson = Schema.fromJsonString(Schema.Union([Schema.Array(RecordDocument), SetDocument]));
const targetLine = Schema.fromJsonString(RecordDocument);

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
  format: Flag.Literals(`${prefix}targets-format`, ["text", "json", "jsonl"]).pipe(
    Flag.optional,
    Flag.withDescription("Override file suffix detection; stdin defaults to text."),
  ),
});

export const checkStdin = (paths: readonly string[]) =>
  paths.filter((path) => path === "-").length > 1
    ? Effect.fail(new CliError.UserError({ cause: "stdin can only be used once per invocation" }))
    : Effect.void;

export const loadTargets = Effect.fn("Cli.loadTargets")(function* (
  names: readonly TaxonName[],
  paths: readonly string[],
  format?: "text" | "json" | "jsonl",
) {
  yield* checkStdin(paths);
  const fs = yield* FileSystem.FileSystem;
  const stdio = yield* Stdio.Stdio;
  const files = Stream.fromIterable(paths).pipe(
    Stream.flatMap((path): Stream.Stream<TaxonSet.TaxonSet, CliError.UserError> => {
      const bytes = (path === "-" ? stdio.stdin : fs.stream(path)).pipe(
        Stream.mapError(
          (cause) =>
            new CliError.UserError({
              cause,
              userMessage: `${path === "-" ? "stdin" : path}: Cannot read target source`,
            }),
        ),
      );
      const encoding =
        format ?? (path.endsWith(".json") ? "json" : path.endsWith(".jsonl") ? "jsonl" : "text");
      if (encoding === "json") {
        return Stream.unwrap(
          Effect.gen(function* () {
            const text = yield* bytes.pipe(Stream.decodeText(), Stream.mkString);
            const sets = yield* Effect.try({
              try: () => {
                const document = Schema.decodeUnknownSync(targetJson)(text);
                return Array.isArray<typeof document>(document)
                  ? document.map((record) => TaxonSet.of(record))
                  : [restoreSet(document)];
              },
              catch: (cause) =>
                new CliError.UserError({
                  cause,
                  userMessage: `${path === "-" ? "stdin" : path}: Cannot decode target JSON; input is invalid or too deeply nested`,
                }),
            });
            return Stream.fromIterable<TaxonSet.TaxonSet>(sets);
          }),
        );
      }
      if (encoding === "jsonl") {
        return bytes.pipe(
          Stream.decodeText(),
          Stream.splitLines,
          Stream.mapEffect((line, index) =>
            Schema.decodeUnknownEffect(targetLine)(line).pipe(
              Effect.mapError(
                (cause) =>
                  new CliError.UserError({
                    cause,
                    userMessage: `${path === "-" ? "stdin" : path}:${index + 1}: Expected an identifying target record in JSONL`,
                  }),
              ),
            ),
          ),
          Stream.map((record) => TaxonSet.of(record)),
        );
      }
      return bytes.pipe(
        Stream.decodeText(),
        Stream.splitLines,
        Stream.mapEffect((line, index) =>
          Schema.decodeUnknownEffect(TaxonName)(line).pipe(
            Effect.mapError(
              (cause) =>
                new CliError.UserError({
                  cause,
                  userMessage: `${path === "-" ? "stdin" : path}:${index + 1}: Expected a nonblank target name`,
                }),
            ),
          ),
        ),
        Stream.map((name) => TaxonSet.of(name)),
      );
    }),
  );
  const sets = yield* Stream.fromIterable(names).pipe(
    Stream.map((name) => TaxonSet.of(name)),
    Stream.concat(files),
    Stream.runCollect,
  );
  return TaxonSet.unionAll(sets);
});
