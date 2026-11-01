import { Effect, Schema, Sink, Stdio, Stream } from "effect";
import { CliError } from "effect/cli";
import { Csv, Ndjson } from "effect/encoding";

const serializationFailure = (cause: unknown) =>
  new CliError.UserError({ cause, userMessage: "Cannot serialize output" });

const stdoutFailure = (cause: unknown) =>
  new CliError.UserError({ cause, userMessage: "Cannot write results to stdout" });

const writeStream = Effect.fnUntraced(function* <E, R>(stream: Stream.Stream<string, E, R>) {
  const stdio = yield* Stdio.Stdio;
  const sink = stdio.stdout({ endOnDone: false }).pipe(Sink.mapError(stdoutFailure));
  yield* Stream.run(stream, sink);
});

export const writeText = (text: string | boolean) => {
  const lines = Stream.succeed(`${text}\n`);
  return writeStream(lines);
};

export const writeJson = Effect.fnUntraced(function* <S extends Schema.Constraint>(
  value: unknown,
  schema: S,
) {
  const text = yield* Schema.encodeUnknownEffect(Schema.fromJsonString(schema))(value).pipe(
    Effect.mapError(serializationFailure),
  );
  yield* writeText(text);
});

export const writeJsonLines = <A, E, R>(values: Stream.Stream<A, E, R>) => {
  const encoder = Ndjson.encodeString<E>();
  const lines = values.pipe(
    Stream.pipeThroughChannel(encoder),
    Stream.mapError((error) => (Ndjson.isNdjsonError(error) ? serializationFailure(error) : error)),
  );

  return writeStream(lines);
};

export const writeTable =
  <S extends Schema.Constraint>(schema: S, noHeader = false) =>
  <E, R>(rows: Stream.Stream<S["Type"], E, R>) => {
    const encoder = Csv.encodeSchemaString(schema)<E>({
      delimiter: "\t",
      newline: "\n",
      headers: !noHeader,
    });
    const lines = rows.pipe(
      Stream.pipeThroughChannel(encoder),
      Stream.mapError((error) =>
        Schema.isSchemaError(error) ? serializationFailure(error) : error,
      ),
    );

    return writeStream(lines);
  };
