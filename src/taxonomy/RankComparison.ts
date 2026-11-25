import * as Decision from "effect/ai/Decision";
import * as DecisionModel from "effect/ai/DecisionModel";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as AcceptancePolicy from "../AcceptancePolicy.ts";
import * as Errors from "../errors.ts";
import { TaxonomicRank, type JudgmentOptions } from "../schemas.ts";
import * as TaxonRelations from "../TaxonRelations.ts";
import * as TaxonomyHints from "../TaxonomyHints.ts";
import { type RecordInput } from "./RecordInput.ts";
import {
  RankComparisonJudgment,
  makeRankComparisonQuestion,
  rankComparisonInputSchema,
  recordedRankComparison,
} from "./RankRequest.ts";

type RankComparison = Effect.Effect<
  RankComparisonJudgment,
  Errors.TaxonomyError | Errors.TaxonIdQueryError,
  DecisionModel.DecisionModel
>;

// Fn aliases keep public calling contracts separate from traced implementations.
type CompareRecordsAtRankFn = (
  left: RecordInput,
  right: RecordInput,
  rank: TaxonomicRank,
  options?: JudgmentOptions,
) => RankComparison;

type CompareRecordsFn = (
  left: RecordInput,
  right: RecordInput,
  options?: JudgmentOptions,
) => RankComparison;

type RankComparisonAnswer = Decision.Answer<
  ReturnType<typeof makeRankComparisonQuestion>["decisions"]["comparison"]
>;

const interpretRankComparison = (
  rank: TaxonomicRank,
  answer: RankComparisonAnswer,
  policy: AcceptancePolicy.AcceptancePolicy,
): RankComparisonJudgment => {
  const p = answer.probabilities;
  const support = TaxonRelations.rankSupports(p);
  const judgments = RankComparisonJudgment.cases;

  const unresolvedSupport = Math.max(
    p.undetermined,
    p.multipleLeft,
    p.multipleRight,
    p.multipleBoth,
  );

  // Refinement competes with every detailed alternative, including the other broad group.
  const sameCompetitorSupport = Math.max(support.different, unresolvedSupport);
  const sameAccepted = AcceptancePolicy.accepts(support.same, sameCompetitorSupport, policy);

  if (sameAccepted) {
    const differentOrUnresolvedSupport = Math.max(
      p.properSubset,
      p.properSuperset,
      p.partialOverlap,
      p.disjoint,
      unresolvedSupport,
    );

    const equalSingleCompetitorSupport = Math.max(p.equalMultiple, differentOrUnresolvedSupport);

    const equalSingleAccepted = AcceptancePolicy.accepts(
      p.equalSingle,
      equalSingleCompetitorSupport,
      policy,
    );

    if (equalSingleAccepted) {
      return judgments.SameTaxonAtRank.make({ rank });
    }

    const equalMultipleCompetitorSupport = Math.max(p.equalSingle, differentOrUnresolvedSupport);

    const equalMultipleAccepted = AcceptancePolicy.accepts(
      p.equalMultiple,
      equalMultipleCompetitorSupport,
      policy,
    );

    if (equalMultipleAccepted) {
      return judgments.SameMultipleTaxaAtRank.make({ rank });
    }

    return judgments.SameTaxaAtRank.make({ rank });
  }

  const differentCompetitorSupport = Math.max(support.same, unresolvedSupport);

  const differentAccepted = AcceptancePolicy.accepts(
    support.different,
    differentCompetitorSupport,
    policy,
  );

  if (differentAccepted) {
    const sameOrUnresolvedSupport = Math.max(p.equalSingle, p.equalMultiple, unresolvedSupport);

    const properSubsetCompetitorSupport = Math.max(
      p.properSuperset,
      p.partialOverlap,
      p.disjoint,
      sameOrUnresolvedSupport,
    );

    const properSubsetAccepted = AcceptancePolicy.accepts(
      p.properSubset,
      properSubsetCompetitorSupport,
      policy,
    );

    if (properSubsetAccepted) {
      return judgments.LeftTaxaWithinRightAtRank.make({ rank });
    }

    const properSupersetCompetitorSupport = Math.max(
      p.properSubset,
      p.partialOverlap,
      p.disjoint,
      sameOrUnresolvedSupport,
    );

    const properSupersetAccepted = AcceptancePolicy.accepts(
      p.properSuperset,
      properSupersetCompetitorSupport,
      policy,
    );

    if (properSupersetAccepted) {
      return judgments.RightTaxaWithinLeftAtRank.make({ rank });
    }

    const partialOverlapCompetitorSupport = Math.max(
      p.properSubset,
      p.properSuperset,
      p.disjoint,
      sameOrUnresolvedSupport,
    );

    const partialOverlapAccepted = AcceptancePolicy.accepts(
      p.partialOverlap,
      partialOverlapCompetitorSupport,
      policy,
    );

    if (partialOverlapAccepted) {
      return judgments.PartlySharedTaxaAtRank.make({ rank });
    }

    const disjointCompetitorSupport = Math.max(
      p.properSubset,
      p.properSuperset,
      p.partialOverlap,
      sameOrUnresolvedSupport,
    );

    const disjointAccepted = AcceptancePolicy.accepts(
      p.disjoint,
      disjointCompetitorSupport,
      policy,
    );

    if (disjointAccepted) {
      return judgments.NoSharedTaxaAtRank.make({ rank });
    }

    return judgments.DifferentTaxaAtRank.make({ rank });
  }

  const otherBroadSupport = Math.max(support.same, support.different, p.undetermined);

  const multipleLeftCompetitorSupport = Math.max(
    p.multipleRight,
    p.multipleBoth,
    otherBroadSupport,
  );

  const multipleLeftAccepted = AcceptancePolicy.accepts(
    p.multipleLeft,
    multipleLeftCompetitorSupport,
    policy,
  );

  if (multipleLeftAccepted) {
    return judgments.MultipleTaxaAtRank.make({ rank, side: "left" });
  }

  const multipleRightCompetitorSupport = Math.max(
    p.multipleLeft,
    p.multipleBoth,
    otherBroadSupport,
  );

  const multipleRightAccepted = AcceptancePolicy.accepts(
    p.multipleRight,
    multipleRightCompetitorSupport,
    policy,
  );

  if (multipleRightAccepted) {
    return judgments.MultipleTaxaAtRank.make({ rank, side: "right" });
  }

  const multipleBothCompetitorSupport = Math.max(
    p.multipleLeft,
    p.multipleRight,
    otherBroadSupport,
  );

  const multipleBothAccepted = AcceptancePolicy.accepts(
    p.multipleBoth,
    multipleBothCompetitorSupport,
    policy,
  );

  if (multipleBothAccepted) {
    return judgments.MultipleTaxaAtRank.make({ rank, side: "both" });
  }

  return judgments.Undetermined.make({ rank });
};

/**
 * Compare the taxa described by two records at the requested rank.
 * A record describing Quercus robur and Quercus petraea can resolve to one genus,
 * Quercus, while describing two species for a species-rank comparison.
 * Undetermined leaves the comparison unresolved.
 *
 * @category comparisons
 * @since 0.1.0
 * @see {@link RankComparisonJudgment}
 * @example
 * import { RecordLabel, Taxonomy } from "robo-taxonomist";
 * export const comparison = Taxonomy.sameTaxonAtRank(
 *   RecordLabel.make("Voucher A17 | Quercus robur"),
 *   RecordLabel.make("Voucher B42 | Quercus petraea"),
 *   "genus",
 * );
 */
export const sameTaxonAtRank: CompareRecordsAtRankFn = Effect.fn("Taxonomy.sameTaxonAtRank")(
  function* (
    left: RecordInput,
    right: RecordInput,
    rank: TaxonomicRank,
    options: JudgmentOptions = {},
  ) {
    const hints = yield* TaxonomyHints.snapshot(options.hints);

    const encoded = yield* Schema.encodeEffect(rankComparisonInputSchema)({
      left,
      right,
      rank,
    }).pipe(Effect.mapError(Errors.InvalidInput.from));

    const recorded = yield* recordedRankComparison(encoded);

    if (Option.isSome(recorded)) return recorded.value;

    const definition = makeRankComparisonQuestion(encoded, hints);
    const { answers } = yield* DecisionModel.decide(definition, { input: null });

    return interpretRankComparison(
      rank,
      answers.comparison,
      options.policy ?? AcceptancePolicy.defaultPolicy,
    );
  },
);

/**
 * Compare two records at species rank.
 *
 * @category comparisons
 * @since 0.1.0
 * @see {@link sameTaxonAtRank} for rank comparison and result semantics.
 * @example
 * import { RecordLabel, Taxonomy } from "robo-taxonomist";
 * export const comparison = Taxonomy.sameSpecies(
 *   RecordLabel.make("Voucher A17 | Quercus robur"),
 *   RecordLabel.make("Voucher B42 | Quercus robur"),
 * );
 */
export const sameSpecies: CompareRecordsFn = (
  left: RecordInput,
  right: RecordInput,
  options: JudgmentOptions = {},
) => sameTaxonAtRank(left, right, "species", options);

/**
 * Compare two records at domain rank.
 *
 * @category comparisons
 * @since 0.1.0
 * @example
 * import { RecordLabel, Taxonomy } from "robo-taxonomist";
 * export const comparison = Taxonomy.sameDomain(
 *   RecordLabel.make("Quercus robur"), RecordLabel.make("Quercus petraea"),
 * );
 */
export const sameDomain: CompareRecordsFn = (
  left: RecordInput,
  right: RecordInput,
  options: JudgmentOptions = {},
) => sameTaxonAtRank(left, right, "domain", options);

/**
 * Compare two records at kingdom rank.
 *
 * @category comparisons
 * @since 0.1.0
 * @example
 * import { RecordLabel, Taxonomy } from "robo-taxonomist";
 * export const comparison = Taxonomy.sameKingdom(
 *   RecordLabel.make("Quercus robur"), RecordLabel.make("Quercus petraea"),
 * );
 */
export const sameKingdom: CompareRecordsFn = (
  left: RecordInput,
  right: RecordInput,
  options: JudgmentOptions = {},
) => sameTaxonAtRank(left, right, "kingdom", options);

/**
 * Compare two records at phylum rank.
 *
 * @category comparisons
 * @since 0.1.0
 * @example
 * import { RecordLabel, Taxonomy } from "robo-taxonomist";
 * export const comparison = Taxonomy.samePhylum(
 *   RecordLabel.make("Quercus robur"), RecordLabel.make("Quercus petraea"),
 * );
 */
export const samePhylum: CompareRecordsFn = (
  left: RecordInput,
  right: RecordInput,
  options: JudgmentOptions = {},
) => sameTaxonAtRank(left, right, "phylum", options);

/**
 * Compare two records at class rank.
 *
 * @category comparisons
 * @since 0.1.0
 * @example
 * import { RecordLabel, Taxonomy } from "robo-taxonomist";
 * export const comparison = Taxonomy.sameClass(
 *   RecordLabel.make("Quercus robur"), RecordLabel.make("Quercus petraea"),
 * );
 */
export const sameClass: CompareRecordsFn = (
  left: RecordInput,
  right: RecordInput,
  options: JudgmentOptions = {},
) => sameTaxonAtRank(left, right, "class", options);

/**
 * Compare two records at order rank.
 *
 * @category comparisons
 * @since 0.1.0
 * @example
 * import { RecordLabel, Taxonomy } from "robo-taxonomist";
 * export const comparison = Taxonomy.sameOrder(
 *   RecordLabel.make("Quercus robur"), RecordLabel.make("Quercus petraea"),
 * );
 */
export const sameOrder: CompareRecordsFn = (
  left: RecordInput,
  right: RecordInput,
  options: JudgmentOptions = {},
) => sameTaxonAtRank(left, right, "order", options);

/**
 * Compare two records at family rank.
 *
 * @category comparisons
 * @since 0.1.0
 * @example
 * import { RecordLabel, Taxonomy } from "robo-taxonomist";
 * export const comparison = Taxonomy.sameFamily(
 *   RecordLabel.make("Quercus robur"), RecordLabel.make("Quercus petraea"),
 * );
 */
export const sameFamily: CompareRecordsFn = (
  left: RecordInput,
  right: RecordInput,
  options: JudgmentOptions = {},
) => sameTaxonAtRank(left, right, "family", options);

/**
 * Compare two records at genus rank.
 *
 * @category comparisons
 * @since 0.1.0
 * @example
 * import { RecordLabel, Taxonomy } from "robo-taxonomist";
 * export const comparison = Taxonomy.sameGenus(
 *   RecordLabel.make("Quercus robur"), RecordLabel.make("Quercus petraea"),
 * );
 */
export const sameGenus: CompareRecordsFn = (
  left: RecordInput,
  right: RecordInput,
  options: JudgmentOptions = {},
) => sameTaxonAtRank(left, right, "genus", options);
