import { Effect, Schema, Sink, Stdio, Stream } from "effect";
import { CliError } from "effect/cli";
import { Csv, Ndjson } from "effect/encoding";
import {
  TaxonMatchJudgment,
  type CollectionMembershipJudgment,
  type RankComparisonJudgment,
  type TaxonContainmentJudgment,
  type TaxonIdentityJudgment,
  type TaxonSet,
} from "robo-taxonomist";
import * as Documents from "./documents.ts";
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

const writeTable = <S extends Schema.Constraint, E, R>(
  rows: Stream.Stream<Schema.Schema.Type<S>, E, R>,
  schema: S,
  headings: ReadonlyArray<string>,
  options: Csv.EncodeSchemaOptions<S>,
) => {
  const { delimiter = "\t", newline = "\n" } = options;
  const encoder = Csv.encodeSchemaString(schema)<E>({ ...options, delimiter, newline });
  const lines = rows.pipe(
    Stream.pipeThroughChannel(encoder),
    Stream.mapError((error) => (Schema.isSchemaError(error) ? serializationFailure(error) : error)),
  );
  if (!options.headers) return writeStream(lines);

  const header = Stream.succeed(headings).pipe(
    Stream.pipeThroughChannel(Csv.encodeString({ delimiter, newline })),
  );
  // Replace the native header without changing the encoder's error record numbers.
  const body = lines.pipe(Stream.drop(1));
  return writeStream(Stream.concat(header, body));
};

/** Write an identity or containment judgment as a tab-delimited CSV table. */
export const writeComparison = (
  judgment: TaxonIdentityJudgment | TaxonContainmentJudgment,
  noHeader = false,
) => {
  const schema = Schema.Union([Documents.IdentityJudgment, Documents.ContainmentJudgment]);
  const columns = [Documents.IdentityJudgment.tag, "side"] as const;
  const headings = columns.map((column) =>
    column === Documents.IdentityJudgment.tag ? "judgment" : column,
  );

  return writeTable(Stream.succeed(judgment), schema, headings, {
    columns,
    headers: !noHeader,
  });
};

/** Write a rank comparison judgment as a tab-delimited CSV table. */
export const writeRank = (judgment: RankComparisonJudgment, noHeader = false) => {
  const schema = Documents.RankJudgment;
  const columns = [schema.tag, "rank", "side"] as const;
  const headings = columns.map((column) => (column === schema.tag ? "judgment" : column));

  return writeTable(Stream.succeed(judgment), schema, headings, {
    columns,
    headers: !noHeader,
  });
};

const RelationRow = Schema.Struct({
  judgment: Schema.String,
  relation: Schema.String,
  side: Schema.optional(Schema.String),
  clarification_target: Schema.optional(Schema.String),
});

/** Write a set relation judgment and any clarification target as tab-delimited CSV. */
export const writeRelation = Effect.fnUntraced(function* (
  judgment: TaxonSet.TaxonSetRelationJudgment,
  noHeader = false,
) {
  const presented = yield* Presentation.relationRow(judgment);
  const row = {
    judgment: presented.judgment._tag,
    relation: presented.judgment.relation,
    side: "side" in presented.judgment ? presented.judgment.side : "",
    clarification_target: presented.clarification,
  };
  const columns = ["judgment", "relation", "side", "clarification_target"] as const;
  yield* writeTable(Stream.succeed(row), RelationRow, columns, {
    columns,
    headers: !noHeader,
  });
});

const QuantifierRow = Schema.Struct({
  judgment: Schema.String,
  quantifier: Schema.String,
  clarification_target: Schema.optional(Schema.String),
});

/** Write an all, any or none membership judgment as tab-delimited CSV. */
export const writeQuantifier = Effect.fnUntraced(function* (
  judgment: CollectionMembershipJudgment,
  noHeader = false,
) {
  const presented = yield* Presentation.quantifierRow(judgment);
  const row = {
    judgment: presented.judgment._tag,
    quantifier: presented.judgment.quantifier,
    clarification_target: presented.clarification,
  };
  const columns = ["judgment", "quantifier", "clarification_target"] as const;
  yield* writeTable(Stream.succeed(row), QuantifierRow, columns, {
    columns,
    headers: !noHeader,
  });
});

const MembershipRow = Schema.Struct({
  judgment: Schema.String,
  record: Schema.String,
  clarification_target: Schema.optional(Schema.String),
});

/** Write record membership entries as tab-delimited CSV with one optional header. */
export const writeMembership = <E, R>(
  entries: Stream.Stream<Presentation.MembershipEntry, E, R>,
  noHeader = false,
) => {
  const rows = entries.pipe(
    Stream.mapEffect(Presentation.membershipRow),
    Stream.map(({ entry, record, clarification }) => ({
      judgment: entry.judgment._tag,
      record,
      clarification_target: clarification,
    })),
  );
  const columns = ["judgment", "record", "clarification_target"] as const;
  return writeTable(rows, MembershipRow, columns, {
    columns,
    headers: !noHeader,
  });
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

const ClassificationRow = Schema.Struct({
  record: Schema.String,
  target: Schema.String,
  judgment: Schema.String,
  support: Schema.optional(Schema.Finite),
  ranking_position: Schema.optional(Schema.Int),
});

/** Write classification outcomes as tab-delimited CSV, including unranked outcomes. */
export const writeClassification = <E, R>(
  classifications: Stream.Stream<Presentation.Classification, E, R>,
  noHeader = false,
) => {
  const rows = classifications.pipe(
    Stream.flatMap(Presentation.classificationRows),
    Stream.map(({ match, record, target, rankingPosition }) => ({
      record,
      target,
      judgment: match.judgment._tag,
      support: TaxonMatchJudgment.match(match.judgment, {
        SameTaxon: ({ support }) => support,
        WithinTaxon: ({ support }) => support,
        NotMatched: ({ support }) => support,
        Undetermined: () => undefined,
      }),
      ranking_position: rankingPosition,
    })),
  );
  const columns = ["record", "target", "judgment", "support", "ranking_position"] as const;
  return writeTable(rows, ClassificationRow, columns, {
    columns,
    headers: !noHeader,
  });
};
