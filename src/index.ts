/**
 * Construct validated inputs with the exported schemas.
 * Use .make for synchronous construction; validation failures throw.
 * Use .makeEffect to handle validation failures through Effect.
 */
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
 * Compare record labels, ask about taxa and ranks, and test records against targets.
 * Model-backed questions return Effects that require a DecisionModel service
 * and report input or provider failures through AiError.
 * By default, an answer must receive at least half the reported probability
 * and exceed every competing answer. Other answers become Undetermined.
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
 * Build set expressions from supplied taxon names and ask how their organisms relate.
 * Constructors return expressions synchronously and can throw if validation fails.
 * Relation questions return Effects and use the model, error, and acceptance rules
 * described for Taxonomy questions.
 * @example
 * import { TaxonName, TaxonSet } from "robo-taxonomist";
 * export const oaks = TaxonSet.of(TaxonName.make("Quercus"));
 */
export * as TaxonSet from "./TaxonSet.ts";
export type { TaxonSetRelationResult } from "./TaxonSet.ts";
