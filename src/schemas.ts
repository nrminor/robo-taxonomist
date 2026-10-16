import { Schema } from "effect";

/**
 * A record description that keeps your original text.
 * Rejects blank text; does not parse or validate taxonomy.
 *
 * @example
 * import { RecordLabel } from "robo-taxonomist";
 * export const label = RecordLabel.make("Voucher A17 | Quercus robur");
 */
export const RecordLabel = Schema.String.check(
  Schema.isPattern(/\S/u, { expected: "a nonblank record label" }),
).pipe(Schema.brand("RecordLabel"));

/**
 * The type of a constructed record label, distinct from a whole-taxon name.
 *
 * @example
 * import { Taxonomy, type RecordLabel } from "robo-taxonomist";
 * export const equalLabels = (first: RecordLabel, second: RecordLabel) =>
 *   Taxonomy.sameLabel(first, second);
 */
export type RecordLabel = typeof RecordLabel.Type;

/**
 * A name describing a whole taxon, kept exactly as supplied.
 * Rejects blank text; does not resolve or certify the name.
 *
 * @example
 * import { TaxonName } from "robo-taxonomist";
 * export const oaks = TaxonName.make("Quercus");
 */
export const TaxonName = Schema.String.check(
  Schema.isPattern(/\S/u, { expected: "a nonblank taxon name" }),
).pipe(Schema.brand("TaxonName"));

/**
 * The type of a constructed whole-taxon name.
 *
 * @example
 * import { TaxonomicRecord, type TaxonName } from "robo-taxonomist";
 * export const recordWithName = (scientificName: TaxonName) =>
 *   TaxonomicRecord.make({ scientificName });
 */
export type TaxonName = typeof TaxonName.Type;

const NonblankText = Schema.String.check(Schema.isPattern(/\S/u, { expected: "nonblank text" }));

/**
 * An identifier scoped to a taxonomy, not an accession or a lookup result.
 * A missing release is unspecified; it does not mean the latest release.
 *
 * @example
 * import { TaxonId } from "robo-taxonomist";
 * export const assignment = TaxonId.make({ taxonomy: "ncbi", id: "9606" });
 */
export const TaxonId = Schema.Struct({
  taxonomy: NonblankText,
  id: NonblankText,
  release: Schema.optionalKey(NonblankText),
});

/**
 * The type of a supplied taxonomy-scoped identifier.
 *
 * @example
 * import { TaxonomicRecord, type TaxonId } from "robo-taxonomist";
 * export const recordWithId = (taxonId: TaxonId) => TaxonomicRecord.make({ taxonId });
 */
export type TaxonId = typeof TaxonId.Type;

const recordFields = {
  label: Schema.optionalKey(RecordLabel),
  scientificName: Schema.optionalKey(TaxonName),
  taxonId: Schema.optionalKey(TaxonId),
};

/**
 * A record with at least one label, scientific name, or taxon identifier.
 * Keeps supplied fields together without inventing missing descriptions.
 *
 * @example
 * import { TaxonomicRecord, TaxonName } from "robo-taxonomist";
 * export const specimen = TaxonomicRecord.make({
 *   scientificName: TaxonName.make("Quercus robur"),
 * });
 */
export const TaxonomicRecord = Schema.Union([
  Schema.Struct({ ...recordFields, label: RecordLabel }),
  Schema.Struct({ ...recordFields, scientificName: TaxonName }),
  Schema.Struct({ ...recordFields, taxonId: TaxonId }),
]);

/**
 * The type of a constructed record carrying supplied taxonomic metadata.
 *
 * @example
 * import { Taxonomy, type TaxonomicRecord } from "robo-taxonomist";
 * export const compareRecords = (first: TaxonomicRecord, second: TaxonomicRecord) =>
 *   Taxonomy.sameSpecies(first, second);
 */
export type TaxonomicRecord = typeof TaxonomicRecord.Type;

const UnitInterval = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 }));

/**
 * Controls how much support and separation a selected answer needs.
 * Support is its probability; separation is its lead over the strongest alternative.
 * Both thresholds are finite numbers from 0 to 1, not calibrated accuracy.
 * Margin boundaries allow machine-precision rounding.
 * Applies to rank judgments and multiple-taxa diagnoses alike.
 * Ties and nonleading selections remain undetermined even with zero thresholds.
 *
 * @example
 * import { RankComparisonPolicy } from "robo-taxonomist";
 * export const cautious = RankComparisonPolicy.make({
 *   minimumSupport: 0.95,
 *   minimumMargin: 0.25,
 * });
 */
export const RankComparisonPolicy = Schema.Struct({
  minimumSupport: UnitInterval,
  minimumMargin: UnitInterval,
}).pipe(Schema.brand("RankComparisonPolicy"));

/**
 * The type of a validated rank-comparison acceptance policy.
 *
 * @example
 * import { Taxonomy, type RankComparisonPolicy, type RecordLabel } from "robo-taxonomist";
 * export const compareWith = (first: RecordLabel, second: RecordLabel, policy: RankComparisonPolicy) =>
 *   Taxonomy.sameSpecies(first, second, { policy });
 */
export type RankComparisonPolicy = typeof RankComparisonPolicy.Type;

/**
 * Acceptance thresholds for taxon, membership, and set judgments; not calibrated accuracy.
 * Requires a uniquely leading selection; margin boundaries allow machine precision.
 * @example
 * import { JudgmentPolicy } from "robo-taxonomist";
 * export const cautious = JudgmentPolicy.make({ minimumSupport: 0.8, minimumMargin: 0.1 });
 */
export const JudgmentPolicy = Schema.Struct({
  minimumSupport: UnitInterval,
  minimumMargin: UnitInterval,
}).pipe(Schema.brand("JudgmentPolicy"));

/**
 * A validated non-rank acceptance policy.
 * @example
 * import { TaxonName, Taxonomy, type JudgmentPolicy } from "robo-taxonomist";
 * export const compare = (left: TaxonName, right: TaxonName, policy: JudgmentPolicy) =>
 *   Taxonomy.sameTaxon(left, right, { policy });
 */
export type JudgmentPolicy = typeof JudgmentPolicy.Type;

const positiveInteger = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));

/**
 * Bounds records per request and active batch calls within one collection operation.
 * @example
 * import { CollectionExecution } from "robo-taxonomist";
 * export const execution = CollectionExecution.make({ batchSize: 32, concurrency: 2 });
 */
export const CollectionExecution = Schema.Struct({
  batchSize: positiveInteger,
  concurrency: positiveInteger,
}).pipe(Schema.brand("CollectionExecution"));

/**
 * Validated positive-integer collection execution bounds.
 * @example
 * import { Taxonomy, type CollectionExecution, type RecordLabel, type TaxonName } from "robo-taxonomist";
 * export const partition = (records: readonly RecordLabel[], target: TaxonName, execution: CollectionExecution) =>
 *   Taxonomy.partitionRecordsByMembership(records, target, { execution });
 */
export type CollectionExecution = typeof CollectionExecution.Type;

class Empty extends Schema.TaggedClass<Empty>("robo-taxonomist/TaxonSet/Empty")("Empty", {}) {}
class Taxon extends Schema.TaggedClass<Taxon>("robo-taxonomist/TaxonSet/Taxon")("Taxon", {
  name: TaxonName,
}) {}

type Expression = Empty | Taxon | Union | Intersection | Difference;
type EncodedExpression =
  | typeof Empty.Encoded
  | typeof Taxon.Encoded
  | {
      readonly _tag: "Union" | "Intersection";
      readonly operands: readonly [EncodedExpression, ...EncodedExpression[]];
    }
  | {
      readonly _tag: "Difference";
      readonly left: EncodedExpression;
      readonly right: EncodedExpression;
    };

const expressionRef: Schema.Codec<Expression, EncodedExpression> = Schema.suspend(
  () => taxonSetSchema,
);

class Union extends Schema.TaggedClass<Union>("robo-taxonomist/TaxonSet/Union")("Union", {
  operands: Schema.NonEmptyArray(expressionRef),
}) {
  declare readonly operands: readonly [Expression, ...Expression[]];
}

class Intersection extends Schema.TaggedClass<Intersection>(
  "robo-taxonomist/TaxonSet/Intersection",
)("Intersection", {
  operands: Schema.NonEmptyArray(expressionRef),
}) {
  declare readonly operands: readonly [Expression, ...Expression[]];
}

class Difference extends Schema.TaggedClass<Difference>("robo-taxonomist/TaxonSet/Difference")(
  "Difference",
  { left: expressionRef, right: expressionRef },
) {
  declare readonly left: Expression;
  declare readonly right: Expression;
}

/**
 * Recursive symbolic-expression codec; preserves operand order without set simplification.
 */
export const taxonSetSchema = Schema.Union([Empty, Taxon, Union, Intersection, Difference]).pipe(
  Schema.toTaggedUnion("_tag"),
);
