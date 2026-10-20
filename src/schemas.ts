import { Schema } from "effect";

/**
 * Describe a record with nonblank text, preserved exactly as supplied.
 * No trimming or other normalization is applied.
 *
 * @category schemas
 * @since 0.1.0
 *
 * @example
 * import { RecordLabel } from "robo-taxonomist";
 * export const label = RecordLabel.make("Voucher A17 | Quercus robur");
 */
export const RecordLabel = Schema.String.check(
  Schema.isPattern(/\S/u, { expected: "a nonblank record label" }),
).pipe(Schema.brand("RecordLabel"));

/**
 * RecordLabel.make returns this type after validating the supplied text.
 * Record-based questions accept it as a record description.
 *
 * @category models
 * @since 0.1.0
 * @example
 * import { RecordLabel, Taxonomy } from "robo-taxonomist";
 * const first = RecordLabel.make("Voucher A17 | Quercus robur");
 * const second = RecordLabel.make("Voucher B42 | Quercus robur");
 * export const equalLabels = Taxonomy.sameLabel(first, second);
 */
export type RecordLabel = typeof RecordLabel.Type;

/**
 * Supply a whole-taxon name as nonblank text, preserved exactly as supplied.
 * No trimming or other normalization is applied.
 * To combine several taxa, construct each with TaxonSet.of and combine the expressions with TaxonSet.union.
 *
 * @category schemas
 * @since 0.1.0
 * @example
 * import { TaxonName } from "robo-taxonomist";
 * export const oaks = TaxonName.make("Quercus");
 */
export const TaxonName = Schema.String.check(
  Schema.isPattern(/\S/u, { expected: "a nonblank taxon name" }),
).pipe(Schema.brand("TaxonName"));

/**
 * TaxonName.make returns this type after validating the supplied name text.
 * Taxon questions accept it directly, and records accept it in scientificName.
 *
 * @category models
 * @since 0.1.0
 * @example
 * import { TaxonomicRecord, TaxonName } from "robo-taxonomist";
 * const scientificName = TaxonName.make("Quercus robur");
 * export const specimen = TaxonomicRecord.make({ scientificName });
 */
export type TaxonName = typeof TaxonName.Type;

const NonblankText = Schema.String.check(Schema.isPattern(/\S/u, { expected: "nonblank text" }));

/**
 * Supply a taxonomy-scoped identifier with nonblank fields.
 * Omit release to leave the taxonomy release unspecified.
 * Field text is preserved without trimming or normalization.
 *
 * @category schemas
 * @since 0.1.0
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
 * TaxonId.make returns this type with the supplied taxonomy, identifier, and optional release.
 * TaxonomicRecord accepts it in the taxonId field.
 *
 * @category models
 * @since 0.1.0
 * @example
 * import { TaxonomicRecord, TaxonId } from "robo-taxonomist";
 * const taxonId = TaxonId.make({ taxonomy: "ncbi", id: "9606" });
 * export const specimen = TaxonomicRecord.make({ taxonId });
 */
export type TaxonId = typeof TaxonId.Type;

const recordFields = {
  label: Schema.optionalKey(RecordLabel),
  scientificName: Schema.optionalKey(TaxonName),
  taxonId: Schema.optionalKey(TaxonId),
};

/**
 * Describe one or more subjects with at least one label, scientific name, or taxon identifier.
 * Keep the supplied fields together as record metadata.
 *
 * @category schemas
 * @since 0.1.0
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
 * TaxonomicRecord.make returns this type with the supplied identifying fields.
 * Record-based questions accept it to describe one or more subjects.
 *
 * @category models
 * @since 0.1.0
 * @example
 * import { RecordLabel, TaxonomicRecord, TaxonName, Taxonomy } from "robo-taxonomist";
 * const first = TaxonomicRecord.make({ label: RecordLabel.make("Voucher A17 | Quercus robur") });
 * const second = TaxonomicRecord.make({ scientificName: TaxonName.make("Quercus robur") });
 * export const sameSpecies = Taxonomy.sameSpecies(first, second);
 */
export type TaxonomicRecord = typeof TaxonomicRecord.Type;

const positiveInteger = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));

/**
 * Configure records per request and active batch calls within one collection operation.
 * Supply positive integers for both bounds.
 *
 * @category schemas
 * @since 0.1.0
 * @example
 * import { CollectionExecution } from "robo-taxonomist";
 * export const execution = CollectionExecution.make({ batchSize: 32, concurrency: 2 });
 */
export const CollectionExecution = Schema.Struct({
  batchSize: positiveInteger,
  concurrency: positiveInteger,
}).pipe(Schema.brand("CollectionExecution"));

/**
 * CollectionExecution.make returns this type with records-per-request and active-batch limits.
 * Collection functions accept it in their execution option.
 *
 * @category models
 * @since 0.1.0
 * @example
 * import { CollectionExecution, RecordLabel, TaxonName, Taxonomy } from "robo-taxonomist";
 * const records = [RecordLabel.make("Voucher A17 | Quercus robur")];
 * const target = TaxonName.make("Quercus");
 * const execution = CollectionExecution.make({ batchSize: 32, concurrency: 2 });
 * export const partition = Taxonomy.partitionRecordsByMembership(records, target, { execution });
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
 * Encode and decode recursive set expressions, preserving their original structure and operand order.
 */
export const taxonSetSchema = Schema.Union([Empty, Taxon, Union, Intersection, Difference]).pipe(
  Schema.toTaggedUnion("_tag"),
);
