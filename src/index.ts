/**
 * Construct validated inputs with the exported schemas.
 * Use .make for synchronous construction; validation failures throw.
 * Use .makeEffect to handle validation failures through Effect.
 *
 * @category schemas
 * @since 0.1.0
 */
export { AcceptancePolicy } from "./AcceptancePolicy.ts";
/**
 * Handle library input failures and the decision model's existing typed errors.
 *
 * @category modules
 * @since 0.4.0
 */
export * as Errors from "./errors.ts";
export {
  CollectionExecution,
  RecordLabel,
  TaxonId,
  TaxonomicRecord,
  TaxonName,
  TaxonomyHint,
} from "./schemas.ts";
/**
 * Compare record labels, ask about taxa and ranks, and test records against targets.
 * Model-backed questions return Effects that require a DecisionModel service
 * and report schema input failures through Errors.InvalidInput, preserving the original cause.
 * Model-interface failures propagate unchanged as AiError.
 * Classification accepts the selected relationship using its individual model-reported support.
 * Rank, containment and set questions can combine support for compatible choices.
 * The default policy requires at least 0.5 support and a unique lead over competitors.
 * Grouped comparisons can retain a broader answer while its finer details remain uncertain.
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
export {
  TaxonIdentityJudgment,
  TaxonMatchJudgment,
  TaxonomicRank,
  RankComparisonJudgment,
  TaxonContainmentJudgment,
  TaxonMembershipJudgment,
  CollectionMembershipJudgment,
} from "./Taxonomy.ts";
export type { TaxonMatch, RecordMembershipPartition, RecordsGroupedByTaxa } from "./Taxonomy.ts";

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
export { TaxonSetRelation, TaxonSetRelationJudgment } from "./TaxonSet.ts";
/**
 * Supply shared hints, replace or supplement them for one workflow, and inspect its current scope.
 *
 * @category modules
 * @since 0.6.0
 */
export * as TaxonomyHints from "./TaxonomyHints.ts";
