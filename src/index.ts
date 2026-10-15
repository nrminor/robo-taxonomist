export {
  CollectionExecution,
  JudgmentPolicy,
  RankComparisonPolicy,
  RecordLabel,
  TaxonId,
  TaxonomicRecord,
  TaxonName,
} from "./schemas.ts";
/**
 * Literal equality, rank/taxon comparisons, and singleton or batched whole-record membership.
 *
 * @example
 * import { RecordLabel, Taxonomy } from "robo-taxonomist";
 * export const comparison = Taxonomy.sameSpecies(
 *   RecordLabel.make("Quercus robur"), RecordLabel.make("Quercus petraea"),
 * );
 */
export * as Taxonomy from "./Taxonomy.ts";
export type {
  RecordMembershipPartition,
  RecordsGroupedByTaxa,
  CollectionMembershipResult,
  RankComparisonResult,
  TaxonomicRank,
  TaxonIdentityResult,
  TaxonContainmentResult,
  TaxonMembershipResult,
} from "./Taxonomy.ts";

/**
 * Pure symbolic constructors and whole-expression relation questions.
 * @example
 * import { TaxonName, TaxonSet } from "robo-taxonomist";
 * export const oaks = TaxonSet.of(TaxonName.make("Quercus"));
 */
export * as TaxonSet from "./TaxonSet.ts";
export type { TaxonSetRelationResult } from "./TaxonSet.ts";
