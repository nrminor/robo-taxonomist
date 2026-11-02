import { Data, Effect, Match, Predicate, Schema, Stream, Struct } from "effect";
import { CliError } from "effect/cli";
import {
  RecordLabel,
  TaxonName,
  type CollectionMembershipJudgment,
  type RankComparisonJudgment,
  type TaxonContainmentJudgment,
  type TaxonIdentityJudgment,
  type TaxonMembershipJudgment,
  type TaxonSet,
  type Taxonomy,
} from "robo-taxonomist";

const labeledRecord = Schema.Union([RecordLabel, Schema.Struct({ label: RecordLabel })]);
const namedTarget = Schema.Union([
  Schema.Struct({ scientificName: TaxonName }),
  Schema.Struct({ label: RecordLabel }),
]);

const recordText = Effect.fnUntraced(function* (record: unknown) {
  const labeled = yield* Schema.decodeUnknownEffect(labeledRecord)(record).pipe(
    Effect.mapError(
      (cause) =>
        new CliError.UserError({
          cause,
          userMessage: "Record has no original label; use --format jsonl to retain its identifiers",
        }),
    ),
  );

  return Predicate.isString(labeled) ? labeled : labeled.label;
});

const targetText = Effect.fnUntraced(function* (
  target: unknown,
  structuredFormat: "json" | "jsonl",
) {
  const named = yield* Schema.decodeUnknownEffect(namedTarget)(target).pipe(
    Effect.mapError(
      (cause) =>
        new CliError.UserError({
          cause,
          userMessage: `Target has no original name or label; use --format ${structuredFormat} to retain its identifiers`,
        }),
    ),
  );

  if (Predicate.hasProperty(named, "scientificName")) return named.scientificName;
  return named.label;
});

/** Select the judgment and side columns for an identity or containment table. */
export const ComparisonRow = Schema.Struct({
  judgment: Schema.String,
  side: Schema.optional(Schema.String),
});

/** Select the judgment, rank and side columns for a rank comparison table. */
export const RankRow = Schema.Struct({
  judgment: Schema.String,
  rank: Schema.String,
  side: Schema.optional(Schema.String),
});

/** Convert an identity or containment judgment into its table fields. */
export const comparisonRow = (judgment: TaxonIdentityJudgment | TaxonContainmentJudgment) => ({
  ...judgment,
  judgment: Struct.get(judgment, "_tag"),
});

/** Convert a rank comparison judgment into its table fields. */
export const rankRow = (judgment: RankComparisonJudgment) => ({
  ...judgment,
  judgment: Struct.get(judgment, "_tag"),
});

/** Select table columns for a set relation and an optional clarification target. */
export const RelationRow = Schema.Struct({
  judgment: Schema.String,
  relation: Schema.String,
  side: Schema.optional(Schema.String),
  clarification_target: Schema.optional(Schema.String),
});

/** Convert a set relation judgment into a row, retaining its original target text. */
export const relationRow = Effect.fnUntraced(function* (
  judgment: TaxonSet.TaxonSetRelationJudgment,
) {
  const row = { ...judgment, judgment: Struct.get(judgment, "_tag") };

  return yield* Match.value(judgment).pipe(
    Match.tag(
      "MultipleTaxaInSet",
      Effect.fnUntraced(function* ({ taxon }) {
        const name = yield* targetText(taxon.record, "json");
        return { ...row, clarification_target: name };
      }),
    ),
    Match.orElse(() => Effect.succeed(row)),
  );
});

/** Select table columns for an all, any or none membership judgment. */
export const QuantifierRow = Schema.Struct({
  judgment: Schema.String,
  quantifier: Schema.String,
  clarification_target: Schema.optional(Schema.String),
});

/** Convert a collection membership judgment into a row with clarification text when supplied. */
export const quantifierRow = Effect.fnUntraced(function* (judgment: CollectionMembershipJudgment) {
  const row = { ...judgment, judgment: Struct.get(judgment, "_tag") };

  return yield* Match.value(judgment).pipe(
    Match.tag(
      "MultipleTaxaInTarget",
      Effect.fnUntraced(function* ({ target }) {
        const name = yield* targetText(target.record, "json");
        return { ...row, clarification_target: name };
      }),
    ),
    Match.orElse(() => Effect.succeed(row)),
  );
});

/** Select table columns for a record and its membership judgment. */
export const MembershipRow = Schema.Struct({
  judgment: Schema.String,
  record: Schema.String,
  clarification_target: Schema.optional(Schema.String),
});

/** Keep an original record together with its membership judgment. */
export type MembershipEntry = {
  readonly record: unknown;
  readonly judgment: TaxonMembershipJudgment;
};

/** Convert a record's membership judgment into a row using its original label. */
export const membershipRow = Effect.fnUntraced(function* (entry: MembershipEntry) {
  const record = yield* recordText(entry.record);
  const row = { judgment: Struct.get(entry.judgment, "_tag"), record };

  return yield* Match.value(entry.judgment).pipe(
    Match.tag(
      "MultipleTaxaInTarget",
      Effect.fnUntraced(function* ({ target }) {
        const name = yield* targetText(target.record, "jsonl");
        return { ...row, clarification_target: name };
      }),
    ),
    Match.orElse(() => Effect.succeed(row)),
  );
});

/** Describe the five membership buckets returned by the library. */
export type Partition = Effect.Success<ReturnType<typeof Taxonomy.partitionRecordsByMembership>>;
const Membership = Data.taggedEnum<TaxonMembershipJudgment>();

/** Emit membership entries in bucket order, preserving order and repetitions within each bucket. */
export const partitionEntries = (partition: Partition) => {
  const members = partition.Member.map((record) => ({ record, judgment: Membership.Member() }));
  const nonmembers = partition.NotMember.map((record) => ({
    record,
    judgment: Membership.NotMember(),
  }));
  const mixed = partition.MixedMembership.map((record) => ({
    record,
    judgment: Membership.MixedMembership(),
  }));
  const unresolved = partition.Undetermined.map((record) => ({
    record,
    judgment: Membership.Undetermined(),
  }));
  const clarifications = partition.MultipleTaxaInTarget.map(({ record, target }) => ({
    record,
    judgment: Membership.MultipleTaxaInTarget({ target }),
  }));

  return Stream.fromIterable([
    ...members,
    ...nonmembers,
    ...mixed,
    ...unresolved,
    ...clarifications,
  ]);
};

/** Select table columns for a record, target, match judgment, support and ranking position. */
export const ClassificationRow = Schema.Struct({
  record: Schema.String,
  target: Schema.String,
  judgment: Schema.String,
  support: Schema.Finite,
  ranking_position: Schema.optional(Schema.Int),
});

/** Describe the panel, record matches, rankings and usage returned by classification. */
export type Classification = Effect.Success<ReturnType<typeof Taxonomy.classifyRecords>>;

/** Emit every taxon outcome in record order and attach positions from the accepted ranking. */
export const classificationRows = (classification: Classification) => {
  const records = Stream.fromIterable(classification.records);

  return records.pipe(
    Stream.flatMap((classified) => {
      const rows = Effect.gen(function* () {
        if (classified.taxa.length === 0) return Stream.empty;

        const record = yield* recordText(classified.record);
        const positions = new Map(classified.ranking.map((match, index) => [match, index + 1]));
        const matches = Stream.fromIterable(classified.taxa);

        return matches.pipe(
          Stream.mapEffect(
            Effect.fnUntraced(function* (match) {
              const target = yield* targetText(match.taxon.record, "jsonl");
              const judgment = Struct.get(match.judgment, "_tag");
              const rankingPosition = positions.get(match);

              return {
                record,
                target,
                judgment,
                support: match.support,
                ranking_position: rankingPosition,
              };
            }),
          ),
        );
      });

      return Stream.unwrap(rows);
    }),
  );
};
