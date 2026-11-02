import { Effect, Schema, Sink, Stdio, Stream } from "effect";
import { CliError } from "effect/cli";
import { Csv, Ndjson } from "effect/encoding";
import type {
  CollectionMembershipJudgment,
  RankComparisonJudgment,
  TaxonContainmentJudgment,
  TaxonIdentityJudgment,
  TaxonSet,
} from "robo-taxonomist";
import * as Presentation from "./presentation.ts";

const serializationFailure = (cause: unknown) =>
  new CliError.UserError({ cause, userMessage: "Cannot serialize output" });

const stdoutFailure = (cause: unknown) =>
  new CliError.UserError({ cause, userMessage: "Cannot write results to stdout" });

const writeStream = Effect.fnUntraced(function* <E, R>(stream: Stream.Stream<string, E, R>) {
  const stdio = yield* Stdio.Stdio;
  const sink = stdio.stdout({ endOnDone: false }).pipe(Sink.mapError(stdoutFailure));
  yield* Stream.run(stream, sink);
});

/** Write a text result followed by a newline to checked stdout. */
export const writeText = (text: string | boolean) => {
  const lines = Stream.succeed(`${text}\n`);
  return writeStream(lines);
};

/** Encode a result with its transport schema and write one JSON value to stdout. */
export const writeJson = Effect.fnUntraced(function* <S extends Schema.Constraint>(
  value: unknown,
  schema: S,
) {
  const text = yield* Schema.encodeUnknownEffect(Schema.fromJsonString(schema))(value).pipe(
    Effect.mapError(serializationFailure),
  );
  yield* writeText(text);
});

/** Write each streamed value as a JSON line, preserving source and output failures. */
export const writeJsonLines = <A, E, R>(values: Stream.Stream<A, E, R>) => {
  const encoder = Ndjson.encodeString<E>();
  const lines = values.pipe(
    Stream.pipeThroughChannel(encoder),
    Stream.mapError((error) => (Ndjson.isNdjsonError(error) ? serializationFailure(error) : error)),
  );

  return writeStream(lines);
};

const writeTable =
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

/** Write an identity or containment judgment as a tab-delimited CSV table. */
export const writeComparison = (
  judgment: TaxonIdentityJudgment | TaxonContainmentJudgment,
  noHeader = false,
) => {
  const row = Presentation.comparisonRow(judgment);
  const rows = Stream.succeed(row);
  const writeRows = writeTable(Presentation.ComparisonRow, noHeader);
  return writeRows(rows);
};

/** Write a rank comparison judgment as a tab-delimited CSV table. */
export const writeRank = (judgment: RankComparisonJudgment, noHeader = false) => {
  const row = Presentation.rankRow(judgment);
  const rows = Stream.succeed(row);
  const writeRows = writeTable(Presentation.RankRow, noHeader);
  return writeRows(rows);
};

/** Write a set relation judgment and any clarification target as tab-delimited CSV. */
export const writeRelation = Effect.fnUntraced(function* (
  judgment: TaxonSet.TaxonSetRelationJudgment,
  noHeader = false,
) {
  const row = yield* Presentation.relationRow(judgment);
  const rows = Stream.succeed(row);
  const writeRows = writeTable(Presentation.RelationRow, noHeader);
  yield* writeRows(rows);
});

/** Write an all, any or none membership judgment as tab-delimited CSV. */
export const writeQuantifier = Effect.fnUntraced(function* (
  judgment: CollectionMembershipJudgment,
  noHeader = false,
) {
  const row = yield* Presentation.quantifierRow(judgment);
  const rows = Stream.succeed(row);
  const writeRows = writeTable(Presentation.QuantifierRow, noHeader);
  yield* writeRows(rows);
});

/** Write record membership entries as tab-delimited CSV with one optional header. */
export const writeMembership = <E, R>(
  entries: Stream.Stream<Presentation.MembershipEntry, E, R>,
  noHeader = false,
) => {
  const rows = entries.pipe(Stream.mapEffect(Presentation.membershipRow));
  const writeRows = writeTable(Presentation.MembershipRow, noHeader);
  return writeRows(rows);
};

/** Write membership partitions as tab-delimited CSV in bucket order. */
export const writePartition = <E, R>(
  partitions: Stream.Stream<Presentation.Partition, E, R>,
  noHeader = false,
) => {
  const entries = partitions.pipe(Stream.flatMap(Presentation.partitionEntries));
  return writeMembership(entries, noHeader);
};

/** Write each record and membership judgment as a JSON line in bucket order. */
export const writePartitionJsonLines = <E, R>(
  partitions: Stream.Stream<Presentation.Partition, E, R>,
) => {
  const entries = partitions.pipe(Stream.flatMap(Presentation.partitionEntries));
  return writeJsonLines(entries);
};

/** Write classification outcomes as tab-delimited CSV, including unranked outcomes. */
export const writeClassification = <E, R>(
  classifications: Stream.Stream<Presentation.Classification, E, R>,
  noHeader = false,
) => {
  const rows = classifications.pipe(Stream.flatMap(Presentation.classificationRows));
  const writeRows = writeTable(Presentation.ClassificationRow, noHeader);
  return writeRows(rows);
};
