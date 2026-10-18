import { sumProbabilities } from "./AcceptancePolicy.ts";

/**
 * Set questions use these choices to compare the organisms in two sets.
 * The empty-set choices let two empty sets be equal and disjoint.
 * @example
 * import { Decision } from "effect/ai";
 * import { criteria } from "./TaxonRelations.ts";
 * export const relation = Decision.classify({
 *   instructions: "Compare the organisms in the supplied left and right sets.",
 *   criteria,
 * });
 */
export const criteria = {
  equal: "Both sets are nonempty and contain the same organisms.",
  properSubset:
    "Both sets are nonempty. Every left organism belongs to right; some right organisms lie outside left.",
  properSuperset:
    "Both sets are nonempty. Every right organism belongs to left; some left organisms lie outside right.",
  partialOverlap: "The sets share organisms, and each has organisms outside the other.",
  disjoint: "Both sets are nonempty and share no organisms.",
  bothEmpty: "Both sets are empty.",
  leftEmpty: "Only the left set is empty.",
  rightEmpty: "Only the right set is empty.",
  undetermined: "The available information is insufficient to compare the sets.",
};

type SetProbabilities = { readonly [K in keyof typeof criteria]: number };

/**
 * Calculate support for the Yes and No answers to a set question.
 * TaxonSet uses these totals before it applies the acceptance policy.
 * @example
 * import { predicateSupports } from "./TaxonRelations.ts";
 * export const support = predicateSupports.subset({
 *   equal: 0.3, properSubset: 0.5, properSuperset: 0, partialOverlap: 0,
 *   disjoint: 0.1, bothEmpty: 0, leftEmpty: 0, rightEmpty: 0, undetermined: 0.1,
 * });
 */
export const predicateSupports = {
  subset: (p: SetProbabilities) => ({
    yes: sumProbabilities([p.equal, p.properSubset, p.bothEmpty, p.leftEmpty]),
    no: sumProbabilities([p.properSuperset, p.partialOverlap, p.disjoint, p.rightEmpty]),
  }),
  "proper-subset": (p: SetProbabilities) => ({
    yes: sumProbabilities([p.properSubset, p.leftEmpty]),
    no: sumProbabilities([
      p.equal,
      p.properSuperset,
      p.partialOverlap,
      p.disjoint,
      p.bothEmpty,
      p.rightEmpty,
    ]),
  }),
  equivalent: (p: SetProbabilities) => ({
    yes: sumProbabilities([p.equal, p.bothEmpty]),
    no: sumProbabilities([
      p.properSubset,
      p.properSuperset,
      p.partialOverlap,
      p.disjoint,
      p.leftEmpty,
      p.rightEmpty,
    ]),
  }),
  overlap: (p: SetProbabilities) => ({
    yes: sumProbabilities([p.equal, p.properSubset, p.properSuperset, p.partialOverlap]),
    no: sumProbabilities([p.disjoint, p.bothEmpty, p.leftEmpty, p.rightEmpty]),
  }),
  disjoint: (p: SetProbabilities) => ({
    yes: sumProbabilities([p.disjoint, p.bothEmpty, p.leftEmpty, p.rightEmpty]),
    no: sumProbabilities([p.equal, p.properSubset, p.properSuperset, p.partialOverlap]),
  }),
};

/**
 * Calculate support for all, some, or none of the inner organisms belonging to outer.
 * Taxonomy.taxonWithin uses these totals to report NotContained when it cannot
 * report PartlyContained or Disjoint.
 * @example
 * import { containmentSupports } from "./TaxonRelations.ts";
 * export const support = containmentSupports({
 *   equal: 0, properSubset: 0, properSuperset: 0.4, partialOverlap: 0.4,
 *   disjoint: 0.1, bothEmpty: 0, leftEmpty: 0, rightEmpty: 0, undetermined: 0.1,
 * });
 */
export const containmentSupports = (p: SetProbabilities) => ({
  contained: sumProbabilities([p.equal, p.properSubset, p.bothEmpty, p.leftEmpty]),
  notContained: sumProbabilities([p.properSuperset, p.partialOverlap, p.disjoint, p.rightEmpty]),
  partlyContained: sumProbabilities([p.properSuperset, p.partialOverlap]),
  disjoint: sumProbabilities([p.disjoint, p.rightEmpty]),
});

/**
 * Rank questions use these choices to compare the taxa in two records.
 * The question must specify the rank.
 * @example
 * import { Decision } from "effect/ai";
 * import { rankCriteria } from "./TaxonRelations.ts";
 * export const comparison = Decision.classify({
 *   instructions: "Compare the species represented by the supplied records.",
 *   criteria: rankCriteria,
 * });
 */
export const rankCriteria = {
  equalSingle:
    "Both records describe the same one taxon at this rank, including resolved synonyms or acronyms.",
  equalMultiple: "Both records describe the same collection of several taxa at this rank.",
  properSubset:
    "Every left-hand taxon appears on the right, with additional right-hand taxa at this rank.",
  properSuperset:
    "Every right-hand taxon appears on the left, with additional left-hand taxa at this rank.",
  partialOverlap: "The records share taxa at this rank, and each describes additional taxa.",
  disjoint: "The records share no taxa at this rank.",
  undetermined: "The available information is insufficient to compare the taxa at this rank.",
};

type RankProbabilities = { readonly [K in keyof typeof rankCriteria]: number };

/**
 * Add support for the same taxa and for different taxa at the requested rank.
 * Taxonomy.sameTaxonAtRank uses these totals before it reports a more specific answer.
 * @example
 * import { rankSupports } from "./TaxonRelations.ts";
 * export const support = rankSupports({
 *   equalSingle: 0.4, equalMultiple: 0.4, properSubset: 0, properSuperset: 0,
 *   partialOverlap: 0, disjoint: 0.1, undetermined: 0.1,
 * });
 */
export const rankSupports = (p: RankProbabilities) => ({
  same: sumProbabilities([p.equalSingle, p.equalMultiple]),
  different: sumProbabilities([p.properSubset, p.properSuperset, p.partialOverlap, p.disjoint]),
});
