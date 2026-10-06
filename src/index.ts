export {
  RankComparisonPolicy,
  RecordLabel,
  TaxonId,
  TaxonomicRecord,
  TaxonName,
} from "./schemas.ts";
/**
 * Literal label comparison and model-backed comparisons at standard ranks.
 *
 * @example
 * import { RecordLabel, Taxonomy } from "robo-taxonomist";
 * export const comparison = Taxonomy.sameSpecies(
 *   RecordLabel.make("Quercus robur"), RecordLabel.make("Quercus petraea"),
 * );
 */
export * as Taxonomy from "./Taxonomy.ts";
export type { RankComparisonResult, TaxonomicRank } from "./Taxonomy.ts";
