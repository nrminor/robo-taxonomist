import * as Decision from "effect/ai/Decision";
import * as Effect from "effect/Effect";
import * as Function from "effect/Function";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import * as Lookup from "../TaxonLookup.ts";
import { TaxonSource, TaxonomicRank, TaxonomyHint } from "../schemas.ts";
import * as TaxonRelations from "../TaxonRelations.ts";
import { describeRecord, hintsInstruction, recordInputSchema } from "./RecordInput.ts";

/** Construct or validate a rank comparison judgment.
 * @category schemas
 */
export const RankComparisonJudgment = Schema.TaggedUnion({
  SameTaxonAtRank: { rank: TaxonomicRank },
  SameMultipleTaxaAtRank: { rank: TaxonomicRank },
  SameTaxaAtRank: { rank: TaxonomicRank },
  LeftTaxaWithinRightAtRank: { rank: TaxonomicRank },
  RightTaxaWithinLeftAtRank: { rank: TaxonomicRank },
  PartlySharedTaxaAtRank: { rank: TaxonomicRank },
  NoSharedTaxaAtRank: { rank: TaxonomicRank },
  DifferentTaxaAtRank: { rank: TaxonomicRank },
  Undetermined: { rank: TaxonomicRank },
  MultipleTaxaAtRank: {
    rank: TaxonomicRank,
    side: Schema.Literals(["left", "right", "both"]),
  },
});

/**
 * Taxonomy.sameTaxonAtRank and its rank helpers return this type.
 * Match its cases to see how the taxa in the records compare at the requested rank.
 * SameTaxaAtRank retains an accepted match when the number of taxa is uncertain.
 * DifferentTaxaAtRank retains an accepted difference when the finer relation is uncertain.
 * These judgments combine model-reported support for compatible choices under the policy.
 * MultipleTaxaAtRank asks the caller to review a combined assignment on the reported side.
 * Clear combinations are compared directly.
 *
 * @category models
 * @since 0.1.0
 * @example
 * import { Match } from "effect";
 * import type { RankComparisonJudgment } from "robo-taxonomist";
 * export const describe = (result: RankComparisonJudgment) => Match.value(result).pipe(
 *   Match.tagsExhaustive({
 *     SameTaxonAtRank: ({ rank }) => `Both records describe the same taxon at ${rank} rank.`,
 *     SameMultipleTaxaAtRank: ({ rank }) => `Both records describe the same two or more taxa at ${rank} rank.`,
 *     SameTaxaAtRank: ({ rank }) => `The taxa match at ${rank} rank. Their number is uncertain.`,
 *     LeftTaxaWithinRightAtRank: () => "Right includes all left-hand taxa and additional taxa.",
 *     RightTaxaWithinLeftAtRank: () => "Left includes all right-hand taxa and additional taxa.",
 *     PartlySharedTaxaAtRank: () => "Some taxa match; each record also describes others.",
 *     NoSharedTaxaAtRank: () => "No taxa match at this rank.",
 *     DifferentTaxaAtRank: () => "The records describe different taxa. How they differ is uncertain.",
 *     Undetermined: ({ rank }) => `The comparison at ${rank} rank is Undetermined.`,
 *     MultipleTaxaAtRank: ({ rank, side }) =>
 *       `Clarify the combined assignment at ${rank} rank (${side}).`,
 *   }),
 * );
 */
export type RankComparisonJudgment = typeof RankComparisonJudgment.Type;

/** Validate the two records and rank used by a rank comparison. */
export const rankComparisonInputSchema = Schema.Struct({
  left: recordInputSchema,
  right: recordInputSchema,
  rank: TaxonomicRank,
});

/** Compare resolved record identifiers when a lookup can answer without a model. */
export const recordedRankComparison = Effect.fnUntraced(function* ({
  left,
  right,
  rank,
}: typeof rankComparisonInputSchema.Encoded) {
  if (Predicate.isString(left) || Predicate.isString(right)) return Option.none();

  if (left.label !== undefined || right.label !== undefined) return Option.none();

  const leftId = left.taxonId;
  const rightId = right.taxonId;

  if (leftId === undefined || rightId === undefined) return Option.none();

  const provided = yield* Effect.serviceOption(Lookup.TaxonLookup);

  if (Option.isNone(provided)) return Option.none();

  const lookup = provided.value;
  const { source } = lookup;

  if (!TaxonSource.guards.Snapshot(source)) return Option.none();

  if (!Lookup.servesId(source, leftId) || !Lookup.servesId(source, rightId)) {
    return Option.none();
  }

  const leftResult = yield* lookup.byId(leftId);
  const rightResult = yield* lookup.byId(rightId);

  const leftEntry = Lookup.entryFromLookup(leftResult);

  if (Option.isNone(leftEntry)) return Option.none();

  if (
    left.scientificName !== undefined &&
    left.scientificName !== leftEntry.value.taxon.scientificName
  ) {
    return Option.none();
  }

  const leftAtRank = Lookup.taxonAtRank(leftEntry.value, rank);

  if (Option.isNone(leftAtRank)) return Option.none();

  const rightEntry = Lookup.entryFromLookup(rightResult);

  if (Option.isNone(rightEntry)) return Option.none();

  if (
    right.scientificName !== undefined &&
    right.scientificName !== rightEntry.value.taxon.scientificName
  ) {
    return Option.none();
  }

  const rightAtRank = Lookup.taxonAtRank(rightEntry.value, rank);

  if (Option.isNone(rightAtRank)) return Option.none();

  const judgments = RankComparisonJudgment.cases;
  const sameId = Lookup.sameResolvedId(leftAtRank.value.taxonId, rightAtRank.value.taxonId);

  const judgment = sameId
    ? judgments.SameTaxonAtRank.make({ rank })
    : judgments.NoSharedTaxaAtRank.make({ rank });

  return Option.some(judgment);
});

/** Build the model question for records not resolved by the configured lookup. */
export const makeRankComparisonQuestion = (
  { left, right, rank }: typeof rankComparisonInputSchema.Encoded,
  hints: ReadonlyArray<TaxonomyHint>,
) =>
  Decision.make({
    input: Schema.Null,
    decisions: {
      comparison: Decision.classify({
        instructions:
          `Compare the taxa represented by these records at ${rank} rank.\n` +
          "Interpret clear combinations together. Flag a combined input only when it prevents comparison; choose multipleBoth when both inputs need clarification.\n" +
          `Left record:\n${describeRecord(left)}\n` +
          `Right record:\n${describeRecord(right)}` +
          hintsInstruction(hints),
        criteria: Function.pipe(
          TaxonRelations.rankCriteria,
          Struct.assign({
            multipleLeft: "The left assignment combines taxa and needs clarification at this rank.",
            multipleRight:
              "The right assignment combines taxa and needs clarification at this rank.",
            multipleBoth: "Both assignments combine taxa and need clarification at this rank.",
          }),
        ),
      }),
    },
  });
