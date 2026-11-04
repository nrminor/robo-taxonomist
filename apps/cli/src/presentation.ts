import { Data, Effect, Predicate, Schema, Stream } from "effect";
import { CliError } from "effect/cli";
import {
  RecordLabel,
  TaxonName,
  type CollectionMembershipJudgment,
  type TaxonMembershipJudgment,
  type TaxonSet,
  type Taxonomy,
} from "robo-taxonomist";

const labeledRecord = Schema.Union([RecordLabel, Schema.Struct({ label: RecordLabel })]);
const namedTarget = Schema.Union([
  Schema.Struct({ scientificName: TaxonName }),
  Schema.Struct({ label: RecordLabel }),
]);
const Relation = Data.taggedEnum<TaxonSet.TaxonSetRelationJudgment>();
const Quantifier = Data.taggedEnum<CollectionMembershipJudgment>();
const Membership = Data.taggedEnum<TaxonMembershipJudgment>();

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

/** Keep the original set relation judgment with ready-to-print clarification text. */
export const relationRow = Effect.fnUntraced(function* (
  judgment: TaxonSet.TaxonSetRelationJudgment,
) {
  if (!Relation.$is("MultipleTaxaInSet")(judgment)) return { judgment, clarification: "" };

  const clarification = yield* targetText(judgment.taxon.record, "json");
  return { judgment, clarification };
});

/** Keep the original collection judgment with ready-to-print clarification text. */
export const quantifierRow = Effect.fnUntraced(function* (judgment: CollectionMembershipJudgment) {
  if (!Quantifier.$is("MultipleTaxaInTarget")(judgment)) return { judgment, clarification: "" };

  const clarification = yield* targetText(judgment.target.record, "json");
  return { judgment, clarification };
});

/** Keep an original record together with its membership judgment. */
export type MembershipEntry = {
  readonly record: unknown;
  readonly judgment: TaxonMembershipJudgment;
};

/** Keep the original membership entry with its record label and clarification text. */
export const membershipRow = Effect.fnUntraced(function* (entry: MembershipEntry) {
  const record = yield* recordText(entry.record);
  if (!Membership.$is("MultipleTaxaInTarget")(entry.judgment))
    return { entry, record, clarification: "" };

  const clarification = yield* targetText(entry.judgment.target.record, "jsonl");
  return { entry, record, clarification };
});

/** Describe the five membership buckets returned by the library. */
export type Partition = Effect.Success<ReturnType<typeof Taxonomy.partitionRecordsByMembership>>;

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

/** Describe the panel, record matches, rankings and usage returned by classification. */
export type Classification = Effect.Success<ReturnType<typeof Taxonomy.classifyRecords>>;

/** Keep every original match in record order with printable labels and its accepted ranking position. */
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
              const rankingPosition = positions.get(match);

              return {
                match,
                record,
                target,
                rankingPosition,
              };
            }),
          ),
        );
      });

      return Stream.unwrap(rows);
    }),
  );
};
