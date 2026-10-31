/**
 * Construct validated inputs with the exported schemas.
 * Use .make for synchronous construction; validation failures throw.
 * Use .makeEffect to handle validation failures through Effect.
 *
 * @category schemas
 * @since 0.1.0
 */
export { AcceptancePolicy } from "./AcceptancePolicy.ts";
export {
  CollectionExecution,
  RecordLabel,
  TaxonId,
  TaxonomicRecord,
  TaxonName,
} from "./schemas.ts";
/**
 * Compare record labels, ask about taxa and ranks, and test records against targets.
 * Model-backed questions return Effects that require a DecisionModel service
 * and report input or provider failures through AiError.
 * Broader judgments combine support for compatible model choices before applying AcceptancePolicy.
 * The default policy requires at least 0.5 support and a unique lead over competitors.
 * A broad judgment can retain an answer while its finer details remain uncertain.
 * Undetermined leaves the question unresolved; clarification judgments identify
 * supplied names or record sides that the model asks the caller to review.
 *
 * @category modules
 * @since 0.1.0
 * @example
 * import { RecordLabel, Taxonomy } from "robo-taxonomist";
 * export const comparison = Taxonomy.sameSpecies(
 *   RecordLabel.make("Quercus robur"), RecordLabel.make("Quercus petraea"),
 * );
 */
export * as Taxonomy from "./Taxonomy.ts";
export type {
  TaxonMatch,
  TaxonMatchJudgment,
  RecordMembershipPartition,
  RecordsGroupedByTaxa,
  CollectionMembershipJudgment,
  RankComparisonJudgment,
  TaxonomicRank,
  TaxonIdentityJudgment,
  TaxonContainmentJudgment,
  TaxonMembershipJudgment,
} from "./Taxonomy.ts";

/**
 * Build set expressions from names or structured records and ask how their organisms relate.
 * Constructors return expressions synchronously and can throw if validation fails.
 * Relation questions return Effects and use the model, error, and acceptance rules
 * described for Taxonomy questions.
 *
 * @category modules
 * @since 0.1.0
 * @example
 * import { TaxonName, TaxonSet } from "robo-taxonomist";
 * export const oaks = TaxonSet.of(TaxonName.make("Quercus"));
 */
export * as TaxonSet from "./TaxonSet.ts";
export type { TaxonSetRelationJudgment } from "./TaxonSet.ts";
