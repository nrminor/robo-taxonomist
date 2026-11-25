import * as Equivalence from "effect/Equivalence";
import { RecordLabel } from "./schemas.ts";

/**
 * Check whether two record labels contain exactly the same text. This is a simple
 * deterministic string comparison and does not invoke a model.
 *
 * @category comparisons
 * @since 0.1.0
 * @example
 * import { RecordLabel, Taxonomy } from "robo-taxonomist";
 * export const equal = Taxonomy.sameLabel(
 *   RecordLabel.make("Voucher A17 | Quercus robur"),
 *   RecordLabel.make("Voucher B42 | Quercus robur"),
 * );
 */
export const sameLabel: (left: RecordLabel, right: RecordLabel) => boolean = Equivalence.String;

/** Named ranks accepted by taxonomy comparisons. */
export { TaxonomicRank } from "./schemas.ts";

/** Judgments for comparisons at a named taxonomic rank. */
export { RankComparisonJudgment } from "./taxonomy/RankRequest.ts";

/** Compare records at a named rank or use a rank-specific convenience function. */
export {
  sameTaxonAtRank,
  sameSpecies,
  sameDomain,
  sameKingdom,
  samePhylum,
  sameClass,
  sameOrder,
  sameFamily,
  sameGenus,
} from "./taxonomy/RankComparison.ts";

/** Judge taxon identity and containment. */
export {
  TaxonIdentityJudgment,
  sameTaxon,
  TaxonContainmentJudgment,
  taxonWithin,
} from "./taxonomy/ScalarJudgments.ts";

/** Judge whether a record belongs to a taxon or set. */
export { TaxonMembershipJudgment, recordBelongsTo } from "./taxonomy/Membership.ts";

/** Classify and rank records against a panel, retaining model judgments and scores. */
export { TaxonMatchJudgment, TaxonMatch, classifyRecords } from "./taxonomy/Classification.ts";

/** Partition or group records by their taxon membership. */
export {
  type RecordMembershipPartition,
  partitionRecordsByMembership,
  type RecordsGroupedByTaxa,
  groupRecordsByTaxa,
} from "./taxonomy/MembershipPartition.ts";

/** Judge whether all, any, or none of the records belong to a target. */
export {
  CollectionMembershipJudgment,
  allRecordsBelongTo,
  anyRecordBelongsTo,
  noRecordBelongsTo,
} from "./taxonomy/MembershipQuantifiers.ts";
