export {
  JudgmentPolicy,
  RankComparisonPolicy,
  RecordLabel,
  TaxonId,
  TaxonomicRecord,
  TaxonName,
} from "./schemas.ts";
/**
 * Literal label equality, rank/taxon comparisons, and whole-record membership.
 *
 * @example
 * import { RecordLabel, Taxonomy } from "robo-taxonomist";
 * export const comparison = Taxonomy.sameSpecies(
 *   RecordLabel.make("Quercus robur"), RecordLabel.make("Quercus petraea"),
 * );
 */
export * as Taxonomy from "./Taxonomy.ts";
export type {
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
