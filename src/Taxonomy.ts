import * as Decision from "effect/ai/Decision";
import * as DecisionModel from "effect/ai/DecisionModel";
import * as Array from "effect/Array";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Equivalence from "effect/Equivalence";
import { pipe } from "effect/Function";
import * as Iterable from "effect/Iterable";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Predicate from "effect/Predicate";
import * as Record from "effect/Record";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import {
  UnitInterval,
  accepts,
  defaultPolicy,
  select,
  sumProbabilities,
  type AcceptancePolicy,
  type Scored,
} from "./AcceptancePolicy.ts";
import type { TaxonSet } from "./TaxonSet.ts";
import * as Errors from "./errors.ts";
import {
  CollectionExecution,
  RecordLabel,
  TaxonomicRecord,
  TaxonName,
  Taxon,
  taxonSetSchema,
} from "./schemas.ts";
import * as TaxonSetGraph from "./TaxonSetGraph.ts";
import * as TaxonRelations from "./TaxonRelations.ts";

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

const taxonomicRankSchema = Schema.Literals([
  "domain",
  "kingdom",
  "phylum",
  "class",
  "order",
  "family",
  "genus",
  "species",
]);

/**
 * Taxonomy.sameTaxonAtRank accepts this type to select the rank to compare.
 * The supported ranks start with domain at the highest level down to species
 * at the lowest level.
 *
 * @category models
 * @since 0.1.0
 * @example
 * import type { TaxonomicRank } from "robo-taxonomist";
 * export const requestedRank: TaxonomicRank = "species";
 */
export type TaxonomicRank = typeof taxonomicRankSchema.Type;

const rankComparisonJudgmentSchema = Schema.TaggedUnion({
  SameTaxonAtRank: { rank: taxonomicRankSchema },
  SameMultipleTaxaAtRank: { rank: taxonomicRankSchema },
  SameTaxaAtRank: { rank: taxonomicRankSchema },
  LeftTaxaWithinRightAtRank: { rank: taxonomicRankSchema },
  RightTaxaWithinLeftAtRank: { rank: taxonomicRankSchema },
  PartlySharedTaxaAtRank: { rank: taxonomicRankSchema },
  NoSharedTaxaAtRank: { rank: taxonomicRankSchema },
  DifferentTaxaAtRank: { rank: taxonomicRankSchema },
  Undetermined: { rank: taxonomicRankSchema },
  MultipleTaxaAtRank: {
    rank: taxonomicRankSchema,
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
export type RankComparisonJudgment = typeof rankComparisonJudgmentSchema.Type;

const recordInputSchema = Schema.Union([RecordLabel, TaxonomicRecord]);
type RecordInput = typeof recordInputSchema.Type;

type JudgmentOptions = {
  readonly policy?: AcceptancePolicy;
};

// Fn aliases keep public calling contracts separate from traced implementations.
type CompareRecordsAtRankFn = (
  left: RecordInput,
  right: RecordInput,
  rank: TaxonomicRank,
  options?: JudgmentOptions,
) => Effect.Effect<RankComparisonJudgment, Errors.TaxonomyError, DecisionModel.DecisionModel>;

type CompareRecordsFn = (
  left: RecordInput,
  right: RecordInput,
  options?: JudgmentOptions,
) => Effect.Effect<RankComparisonJudgment, Errors.TaxonomyError, DecisionModel.DecisionModel>;

const quoteText = Schema.encodeSync(Schema.fromJsonString(Schema.String));

const describeRecord = (record: typeof recordInputSchema.Encoded): string => {
  if (Predicate.isString(record)) {
    return `Record label: ${quoteText(record)}`;
  }

  return pipe(
    Record.filter(
      {
        "Record label": record.label,
        "Scientific name": record.scientificName,
        Taxonomy: record.taxonId?.taxonomy,
        "Taxon ID": record.taxonId?.id,
        "Taxonomy release": record.taxonId?.release,
      },
      Predicate.isNotUndefined,
    ),
    Record.toEntries,
    Array.map(([field, value]) => `${field}: ${quoteText(value)}`),
    Array.join("\n"),
  );
};

const rankComparisonInputSchema = Schema.Struct({
  left: recordInputSchema,
  right: recordInputSchema,
  rank: taxonomicRankSchema,
});

const makeRankComparisonQuestion = ({
  left,
  right,
  rank,
}: typeof rankComparisonInputSchema.Encoded) =>
  Decision.make({
    input: Schema.Null,
    decisions: {
      comparison: Decision.classify({
        instructions:
          `Compare the taxa represented by these records at ${rank} rank.\n` +
          "Interpret clear combinations together. Flag a combined input only when it prevents comparison; choose multipleBoth when both inputs need clarification.\n" +
          `Left record:\n${describeRecord(left)}\n` +
          `Right record:\n${describeRecord(right)}`,
        criteria: pipe(
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

type RankComparisonAnswer = Decision.Answer<
  ReturnType<typeof makeRankComparisonQuestion>["decisions"]["comparison"]
>;

const interpretRankComparison = (
  rank: TaxonomicRank,
  answer: RankComparisonAnswer,
  policy: AcceptancePolicy,
): RankComparisonJudgment => {
  const p = answer.probabilities;
  const support = TaxonRelations.rankSupports(p);
  const undetermined = rankComparisonJudgmentSchema.cases.Undetermined.make({ rank });
  const unresolved: Array.NonEmptyReadonlyArray<Scored<RankComparisonJudgment>> = [
    { answer: undetermined, support: p.undetermined },
    {
      answer: rankComparisonJudgmentSchema.cases.MultipleTaxaAtRank.make({ rank, side: "left" }),
      support: p.multipleLeft,
    },
    {
      answer: rankComparisonJudgmentSchema.cases.MultipleTaxaAtRank.make({ rank, side: "right" }),
      support: p.multipleRight,
    },
    {
      answer: rankComparisonJudgmentSchema.cases.MultipleTaxaAtRank.make({ rank, side: "both" }),
      support: p.multipleBoth,
    },
  ];
  const candidates: Array.NonEmptyReadonlyArray<Scored<RankComparisonJudgment>> = [
    {
      answer: rankComparisonJudgmentSchema.cases.SameTaxaAtRank.make({ rank }),
      support: support.same,
    },
    {
      answer: rankComparisonJudgmentSchema.cases.DifferentTaxaAtRank.make({ rank }),
      support: support.different,
    },
  ];
  const broad = select(Array.appendAll(candidates, unresolved), policy).pipe(
    Option.getOrElse(() => undetermined),
  );
  if (
    !rankComparisonJudgmentSchema.guards.SameTaxaAtRank(broad) &&
    !rankComparisonJudgmentSchema.guards.DifferentTaxaAtRank(broad)
  )
    return broad;

  const detailed: Array.NonEmptyReadonlyArray<Scored<RankComparisonJudgment>> = [
    {
      answer: rankComparisonJudgmentSchema.cases.SameTaxonAtRank.make({ rank }),
      support: p.equalSingle,
    },
    {
      answer: rankComparisonJudgmentSchema.cases.SameMultipleTaxaAtRank.make({ rank }),
      support: p.equalMultiple,
    },
    {
      answer: rankComparisonJudgmentSchema.cases.LeftTaxaWithinRightAtRank.make({ rank }),
      support: p.properSubset,
    },
    {
      answer: rankComparisonJudgmentSchema.cases.RightTaxaWithinLeftAtRank.make({ rank }),
      support: p.properSuperset,
    },
    {
      answer: rankComparisonJudgmentSchema.cases.PartlySharedTaxaAtRank.make({ rank }),
      support: p.partialOverlap,
    },
    {
      answer: rankComparisonJudgmentSchema.cases.NoSharedTaxaAtRank.make({ rank }),
      support: p.disjoint,
    },
  ];
  const detail = select(Array.appendAll(detailed, unresolved), policy);
  return Match.value(broad).pipe(
    Match.tag("SameTaxaAtRank", () =>
      detail.pipe(
        Option.filter(
          (judgment) =>
            rankComparisonJudgmentSchema.guards.SameTaxonAtRank(judgment) ||
            rankComparisonJudgmentSchema.guards.SameMultipleTaxaAtRank(judgment),
        ),
        Option.getOrElse(() => broad),
      ),
    ),
    Match.tag("DifferentTaxaAtRank", () =>
      detail.pipe(
        Option.filter(
          (judgment) =>
            rankComparisonJudgmentSchema.guards.LeftTaxaWithinRightAtRank(judgment) ||
            rankComparisonJudgmentSchema.guards.RightTaxaWithinLeftAtRank(judgment) ||
            rankComparisonJudgmentSchema.guards.PartlySharedTaxaAtRank(judgment) ||
            rankComparisonJudgmentSchema.guards.NoSharedTaxaAtRank(judgment),
        ),
        Option.getOrElse(() => broad),
      ),
    ),
    Match.exhaustive,
  );
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
    const encoded = yield* Schema.encodeEffect(rankComparisonInputSchema)({
      left,
      right,
      rank,
    }).pipe(Effect.mapError(Errors.InvalidInput.from));
    const definition = makeRankComparisonQuestion(encoded);
    const { answers } = yield* DecisionModel.decide(definition, { input: null });

    return interpretRankComparison(rank, answers.comparison, options.policy ?? defaultPolicy);
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

/**
 * Construct or validate an identity judgment using the same cases returned by sameTaxon.
 *
 * @category schemas
 * @since 0.4.0
 * @example
 * import { TaxonIdentityJudgment } from "robo-taxonomist";
 * export const same = TaxonIdentityJudgment.cases.SameTaxon.make({});
 */
export const TaxonIdentityJudgment = Schema.TaggedUnion({
  SameTaxon: {},
  DifferentTaxa: {},
  MultipleTaxa: { side: Schema.Literals(["left", "right", "both"]) },
  Undetermined: {},
});

/**
 * Taxonomy.sameTaxon returns this type to report its answer about two supplied taxonomic assignments.
 * You can use Match.tagsExhaustive to handle each result.
 * MultipleTaxa reports which combined assignment the model asks the caller to review.
 * Clear combinations are interpreted directly, while Undetermined leaves the identity unresolved.
 *
 * @category models
 * @since 0.1.0
 * @example
 * import { Match } from "effect";
 * import type { TaxonIdentityJudgment } from "robo-taxonomist";
 * export const describe = (result: TaxonIdentityJudgment) => Match.value(result).pipe(
 *   Match.tagsExhaustive({
 *     SameTaxon: () => "The assignments refer to the same taxon.",
 *     DifferentTaxa: () => "The assignments refer to different taxa.",
 *     MultipleTaxa: ({ side }) =>
 *       `Clarify the combined assignment (${side}), or compare explicit sets with TaxonSet.equivalent.`,
 *     Undetermined: () => "The comparison remains unresolved.",
 *   }),
 * );
 */
export type TaxonIdentityJudgment = typeof TaxonIdentityJudgment.Type;

type CompareTaxaFn = (
  left: TaxonName | TaxonomicRecord,
  right: TaxonName | TaxonomicRecord,
  options?: JudgmentOptions,
) => Effect.Effect<TaxonIdentityJudgment, Errors.TaxonomyError, DecisionModel.DecisionModel>;

const scalarInputSchema = Schema.Struct({ left: TaxonomicRecord, right: TaxonomicRecord });
const asTaxonomicRecord = (input: TaxonName | TaxonomicRecord): TaxonomicRecord =>
  Predicate.isString(input) ? { scientificName: input } : input;
const makeIdentityQuestion = (input: typeof scalarInputSchema.Encoded) =>
  Decision.make({
    input: Schema.Null,
    decisions: {
      identity: Decision.classify({
        instructions:
          "Do these records identify the same taxon? Interpret all supplied identifying fields together.\n" +
          "Include resolved synonyms. Flag a combined assignment only when it prevents comparison. " +
          "Choose multipleBoth when both records need clarification.\n" +
          `Left taxon:\n${describeRecord(input.left)}\n` +
          `Right taxon:\n${describeRecord(input.right)}`,
        criteria: {
          same: "Both assignments refer to the same taxonomic grouping, including resolved synonyms.",
          different: "The assignments refer to distinct taxonomic groupings.",
          undetermined: "The available information is insufficient.",
          multipleLeft: "The left assignment combines taxa and needs clarification.",
          multipleRight: "The right assignment combines taxa and needs clarification.",
          multipleBoth: "Both assignments combine taxa and need clarification.",
        },
      }),
    },
  });

type IdentityAnswer = Decision.Answer<
  ReturnType<typeof makeIdentityQuestion>["decisions"]["identity"]
>;
const interpretIdentity = (answer: IdentityAnswer, policy: AcceptancePolicy) => {
  const alternatives = pipe(
    Record.toEntries(answer.probabilities),
    Iterable.filter(([label]) => label !== answer.label),
    Iterable.map(([, support]) => support),
  );
  if (
    answer.label === "undetermined" ||
    !accepts(answer.probabilities[answer.label], alternatives, policy)
  )
    return TaxonIdentityJudgment.cases.Undetermined.make({});
  return Match.value(answer.label).pipe(
    Match.when("same", () => TaxonIdentityJudgment.cases.SameTaxon.make({})),
    Match.when("different", () => TaxonIdentityJudgment.cases.DifferentTaxa.make({})),
    Match.when("multipleLeft", () =>
      TaxonIdentityJudgment.cases.MultipleTaxa.make({ side: "left" }),
    ),
    Match.when("multipleRight", () =>
      TaxonIdentityJudgment.cases.MultipleTaxa.make({ side: "right" }),
    ),
    Match.when("multipleBoth", () =>
      TaxonIdentityJudgment.cases.MultipleTaxa.make({ side: "both" }),
    ),
    Match.exhaustive,
  );
};

/**
 * Ask whether two supplied taxonomic assignments refer to the same taxon.
 * Names are shorthand for scientificName; structured records retain all identifying fields.
 * Resolved synonyms can match.
 *
 * @category comparisons
 * @since 0.1.0
 * @example
 * import { TaxonName, Taxonomy } from "robo-taxonomist";
 * export const identity = Taxonomy.sameTaxon(TaxonName.make("Quercus"), TaxonName.make("Fagus"));
 */
export const sameTaxon: CompareTaxaFn = Effect.fn("Taxonomy.sameTaxon")(function* (
  left: TaxonName | TaxonomicRecord,
  right: TaxonName | TaxonomicRecord,
  options: JudgmentOptions = {},
) {
  const encoded = yield* Schema.encodeEffect(scalarInputSchema)({
    left: asTaxonomicRecord(left),
    right: asTaxonomicRecord(right),
  }).pipe(Effect.mapError(Errors.InvalidInput.from));
  const { answers } = yield* DecisionModel.decide(makeIdentityQuestion(encoded), { input: null });
  return interpretIdentity(answers.identity, options.policy ?? defaultPolicy);
});

const containmentJudgmentSchema = Schema.TaggedUnion({
  Contained: {},
  PartlyContained: {},
  Disjoint: {},
  NotContained: {},
  MultipleTaxa: { side: Schema.Literals(["left", "right", "both"]) },
  Undetermined: {},
});

/**
 * Taxonomy.taxonWithin reports full inclusion, partial inclusion, or disjointness.
 * NotContained reports something outside when neither partial inclusion nor
 * disjointness is accepted under the policy; that broader answer remains valid.
 * MultipleTaxa asks the caller to review the reported side: left is inner and right is outer.
 * Undetermined leaves containment unresolved.
 *
 * @category models
 * @since 0.1.0
 * @example
 * import { Match } from "effect";
 * import type { TaxonContainmentJudgment } from "robo-taxonomist";
 * export const describe = (result: TaxonContainmentJudgment) => Match.value(result).pipe(
 *   Match.tagsExhaustive({
 *     Contained: () => "Every inner organism belongs to outer.",
 *     PartlyContained: () => "Some inner organisms belong; others lie outside.",
 *     Disjoint: () => "No inner organisms belong to outer.",
 *     NotContained: () => "Something lies outside; overlap remains uncertain.",
 *     MultipleTaxa: ({ side }) =>
 *       `Clarify the combined assignment (${side}), or use TaxonSet.union and TaxonSet.isSubsetOf.`,
 *     Undetermined: () => "The question remains unresolved.",
 *   }),
 * );
 */
export type TaxonContainmentJudgment = typeof containmentJudgmentSchema.Type;

type TaxonWithinFn = (
  inner: TaxonName | TaxonomicRecord,
  outer: TaxonName | TaxonomicRecord,
  options?: JudgmentOptions,
) => Effect.Effect<TaxonContainmentJudgment, Errors.TaxonomyError, DecisionModel.DecisionModel>;

const makeContainmentQuestion = (input: typeof scalarInputSchema.Encoded) =>
  Decision.make({
    input: Schema.Null,
    decisions: {
      containment: Decision.classify({
        instructions:
          "Compare the organisms represented by inner and outer. Interpret all supplied identifying fields and clear combinations together. " +
          "Flag a combined assignment only when it prevents comparison; choose multipleBoth when both records need clarification.\n" +
          `Left (inner) taxon:\n${describeRecord(input.left)}\n` +
          `Right (outer) taxon:\n${describeRecord(input.right)}`,
        criteria: pipe(
          TaxonRelations.criteria,
          Struct.assign({
            multipleLeft: "The inner assignment combines taxa and needs clarification.",
            multipleRight: "The outer assignment combines taxa and needs clarification.",
            multipleBoth: "Both assignments combine taxa and need clarification.",
          }),
        ),
      }),
    },
  });

type ContainmentAnswer = Decision.Answer<
  ReturnType<typeof makeContainmentQuestion>["decisions"]["containment"]
>;
const interpretContainment = (
  answer: ContainmentAnswer,
  policy: AcceptancePolicy,
): TaxonContainmentJudgment => {
  const p = answer.probabilities;
  const support = TaxonRelations.containmentSupports(p);
  const undetermined = containmentJudgmentSchema.cases.Undetermined.make({});
  const unresolved: Array.NonEmptyReadonlyArray<Scored<TaxonContainmentJudgment>> = [
    { answer: undetermined, support: p.undetermined },
    {
      answer: containmentJudgmentSchema.cases.MultipleTaxa.make({ side: "left" }),
      support: p.multipleLeft,
    },
    {
      answer: containmentJudgmentSchema.cases.MultipleTaxa.make({ side: "right" }),
      support: p.multipleRight,
    },
    {
      answer: containmentJudgmentSchema.cases.MultipleTaxa.make({ side: "both" }),
      support: p.multipleBoth,
    },
  ];
  const candidates: Array.NonEmptyReadonlyArray<Scored<TaxonContainmentJudgment>> = [
    { answer: containmentJudgmentSchema.cases.Contained.make({}), support: support.contained },
    {
      answer: containmentJudgmentSchema.cases.NotContained.make({}),
      support: support.notContained,
    },
  ];
  const broad = select(Array.appendAll(candidates, unresolved), policy).pipe(
    Option.getOrElse(() => undetermined),
  );
  if (!containmentJudgmentSchema.guards.NotContained(broad)) return broad;

  const detailed: Array.NonEmptyReadonlyArray<Scored<TaxonContainmentJudgment>> = [
    { answer: containmentJudgmentSchema.cases.Contained.make({}), support: support.contained },
    {
      answer: containmentJudgmentSchema.cases.PartlyContained.make({}),
      support: support.partlyContained,
    },
    { answer: containmentJudgmentSchema.cases.Disjoint.make({}), support: support.disjoint },
  ];
  return select(Array.appendAll(detailed, unresolved), policy).pipe(
    Option.filter(
      (judgment) =>
        containmentJudgmentSchema.guards.PartlyContained(judgment) ||
        containmentJudgmentSchema.guards.Disjoint(judgment),
    ),
    Option.getOrElse(() => broad),
  );
};

/**
 * Compare everything represented by inner with outer, interpreting clear combinations together.
 * Contained includes equality.
 *
 * @param inner - The taxon whose organisms are tested for containment.
 * @param outer - The taxon that may contain all inner organisms.
 * @category membership
 * @since 0.1.0
 * @see {@link TaxonContainmentJudgment}
 * @example
 * import { TaxonName, Taxonomy, TaxonSet } from "robo-taxonomist";
 * export const inclusion = Taxonomy.taxonWithin(TaxonName.make("Quercus"), TaxonName.make("Fagaceae"));
 * const inner = TaxonSet.union(
 *   TaxonSet.of(TaxonName.make("Quercus robur")),
 *   TaxonSet.of(TaxonName.make("Quercus petraea")),
 * );
 * export const combinedInclusion = TaxonSet.isSubsetOf(
 *   inner,
 *   TaxonSet.of(TaxonName.make("Quercus")),
 * );
 */
export const taxonWithin: TaxonWithinFn = Effect.fn("Taxonomy.taxonWithin")(function* (
  inner: TaxonName | TaxonomicRecord,
  outer: TaxonName | TaxonomicRecord,
  options: JudgmentOptions = {},
) {
  const encoded = yield* Schema.encodeEffect(scalarInputSchema)({
    left: asTaxonomicRecord(inner),
    right: asTaxonomicRecord(outer),
  }).pipe(Effect.mapError(Errors.InvalidInput.from));
  const { answers } = yield* DecisionModel.decide(makeContainmentQuestion(encoded), {
    input: null,
  });
  return interpretContainment(answers.containment, options.policy ?? defaultPolicy);
});

const membershipJudgmentSchema = Schema.TaggedUnion({
  Member: {},
  NotMember: {},
  MixedMembership: {},
  MultipleTaxaInTarget: { target: Taxon },
  Undetermined: {},
});

/**
 * Taxonomy.recordBelongsTo returns this type for one record and target.
 * The result reports whether all described subjects belong, all lie outside,
 * or some lie inside and others outside the target.
 * It can also identify a target requiring review or leave the question unresolved.
 * You can use Match.tagsExhaustive to handle each result.
 * MultipleTaxaInTarget retains the original target node for review.
 * If clarification is warranted, replace that target with a TaxonSet.union of separate
 * TaxonSet.of expressions and retry.
 *
 * @category models
 * @since 0.1.0
 * @example
 * import { Match } from "effect";
 * import type { TaxonMembershipJudgment } from "robo-taxonomist";
 * export const describe = (result: TaxonMembershipJudgment) => Match.value(result).pipe(
 *   Match.tagsExhaustive({
 *     Member: () => "Wholly inside", NotMember: () => "Wholly outside",
 *     MixedMembership: () => "Subjects both inside and outside",
 *     Undetermined: () => "Needs review",
 *     MultipleTaxaInTarget: ({ target }) =>
 *       `Review the combined target ${target.record.scientificName ?? target.record.label ?? target.record.taxonId?.id}. ` +
 *       "If needed, replace it with separate TaxonSet.of expressions combined with TaxonSet.union, then retry.",
 *   }),
 * );
 */
type WithTarget<J, T extends TaxonomicRecord> = J extends { readonly target: Taxon }
  ? { readonly [K in keyof J]: K extends "target" ? Taxon<T> : J[K] }
  : J;

export type TaxonMembershipJudgment<T extends TaxonomicRecord = TaxonomicRecord> = WithTarget<
  typeof membershipJudgmentSchema.Type,
  T
>;

type MembershipTarget<T extends TaxonomicRecord = TaxonomicRecord> = TaxonName | T | TaxonSet<T>;
type Named = { readonly scientificName: TaxonName };

const batchRecordsSchema = Schema.NonEmptyArray(recordInputSchema);

const isTaxonSet = <T extends TaxonomicRecord>(target: T | TaxonSet<T>): target is TaxonSet<T> =>
  Schema.is(taxonSetSchema)(target);

const prepareMembershipTarget = Effect.fnUntraced(function* <T extends TaxonomicRecord>(
  target: MembershipTarget<T>,
) {
  if (!Predicate.isString(target) && !isTaxonSet(target)) {
    yield* Schema.encodeEffect(TaxonomicRecord)(target).pipe(
      Effect.mapError(Errors.InvalidInput.from),
    );
  }
  let expression: TaxonSet<T | { readonly scientificName: TaxonName }>;
  if (Predicate.isString(target)) {
    const scientificName = yield* Schema.decodeEffect(TaxonName)(target).pipe(
      Effect.mapError(Errors.InvalidInput.from),
    );
    expression = new Taxon({ record: { scientificName } });
  } else {
    expression = isTaxonSet(target) ? target : new Taxon({ record: target });
  }
  const compiled = yield* TaxonSetGraph.compile<
    "target",
    T | { readonly scientificName: TaxonName }
  >({ target: expression });
  const targetTaxa = compiled.taxa.target;
  const input = yield* Schema.encodeEffect(TaxonSetGraph.membershipTargetSchema)({
    nodes: compiled.nodes,
    ...compiled.roots,
  }).pipe(Effect.mapError(Errors.InvalidInput.from));
  const membershipChoices = {
    member: "Everything represented by the record belongs.",
    notMember: "Everything represented by the record is outside.",
    mixed: "The record jointly represents taxa inside and outside.",
    undetermined: "The available information is insufficient.",
  };
  const targetChoices = Record.fromEntries(
    Array.map(
      targetTaxa,
      (taxon, index) =>
        [
          `multipleTarget${index}`,
          `Target taxon node ${Option.getOrThrow(Option.fromUndefinedOr(compiled.nodeIds.get(taxon)))} identifies multiple entities and needs clarification.`,
        ] as const,
    ),
  );
  return {
    input,
    targetTaxa,
    criteria: pipe(membershipChoices, Struct.assign(targetChoices)),
  };
});

const makeMembershipBatchQuestion = Effect.fnUntraced(function* (
  records: typeof batchRecordsSchema.Type,
  prepared: Effect.Success<ReturnType<typeof prepareMembershipTarget>>,
) {
  const encoded = yield* Schema.encodeEffect(batchRecordsSchema)(records).pipe(
    Effect.mapError(Errors.InvalidInput.from),
  );
  return Decision.make({
    input: Schema.toEncoded(TaxonSetGraph.membershipTargetSchema),
    decisions: Record.fromEntries(
      Array.map(
        encoded,
        (record, index) =>
          [
            `record${index}`,
            Decision.classify({
              instructions:
                "Classify all subjects described by this record against the complete target.\n" +
                `${TaxonSetGraph.instructions} Root is target.\n` +
                describeRecord(record),
              criteria: prepared.criteria,
            }),
          ] as const,
      ),
    ),
  });
});

type MembershipAnswer = Decision.Answer<
  Effect.Success<ReturnType<typeof makeMembershipBatchQuestion>>["decisions"][`record${number}`]
>;

const interpretMembership = <T extends TaxonomicRecord>(
  answer: MembershipAnswer,
  targetTaxa: readonly Taxon<T>[],
  policy: AcceptancePolicy,
) => {
  const alternatives = pipe(
    Record.toEntries(answer.probabilities),
    Iterable.filter(([label]) => label !== answer.label),
    Iterable.map(([, support]) => support),
  );
  const support = Record.get(answer.probabilities, answer.label).pipe(Option.getOrThrow);
  if (answer.label === "undetermined" || !accepts(support, alternatives, policy))
    return membershipJudgmentSchema.cases.Undetermined.make({});
  return Match.value(answer.label).pipe(
    Match.when("member", () => membershipJudgmentSchema.cases.Member.make({})),
    Match.when("notMember", () => membershipJudgmentSchema.cases.NotMember.make({})),
    Match.when("mixed", () => membershipJudgmentSchema.cases.MixedMembership.make({})),
    Match.orElse(() =>
      Array.findFirst(
        targetTaxa,
        (_taxon, index) => answer.label === `multipleTarget${index}`,
      ).pipe(
        Option.map((target) => ({
          ...membershipJudgmentSchema.cases.MultipleTaxaInTarget.make({ target }),
          target,
        })),
        Option.getOrThrow,
      ),
    ),
  );
};

const decideMembershipBatch = Effect.fnUntraced(function* (
  records: typeof batchRecordsSchema.Type,
  prepared: Effect.Success<ReturnType<typeof prepareMembershipTarget>>,
) {
  const definition = yield* makeMembershipBatchQuestion(records, prepared);
  const { answers } = yield* DecisionModel.decide(definition, { input: prepared.input });
  return Array.map(records, (_record, index) =>
    Record.get(answers, `record${index}`).pipe(Option.getOrThrow),
  );
});

/**
 * Ask whether every subject described by a record belongs to the complete target.
 * Member reports that all subjects belong; NotMember reports that all subjects lie outside.
 * MixedMembership reports at least one subject inside and at least one outside the target.
 * A literal Empty target returns NotMember directly; other targets use one classification.
 *
 * @category membership
 * @since 0.1.0
 * @example
 * import { RecordLabel, TaxonName, Taxonomy } from "robo-taxonomist";
 * export const membership = Taxonomy.recordBelongsTo(RecordLabel.make("Quercus robur specimen"), TaxonName.make("Quercus"));
 */
export function recordBelongsTo<T extends TaxonomicRecord>(
  record: RecordInput,
  target: T | TaxonSet<T>,
  options?: JudgmentOptions,
): Effect.Effect<TaxonMembershipJudgment<T>, Errors.TaxonomyError, DecisionModel.DecisionModel>;
export function recordBelongsTo(
  record: RecordInput,
  target: TaxonName,
  options?: JudgmentOptions,
): Effect.Effect<TaxonMembershipJudgment<Named>, Errors.TaxonomyError, DecisionModel.DecisionModel>;
export function recordBelongsTo<T extends TaxonomicRecord = TaxonomicRecord>(
  record: RecordInput,
  target: MembershipTarget<T>,
  options?: JudgmentOptions,
): Effect.Effect<
  TaxonMembershipJudgment<T | Named>,
  Errors.TaxonomyError,
  DecisionModel.DecisionModel
>;
export function recordBelongsTo(
  record: RecordInput,
  target: MembershipTarget,
  options?: JudgmentOptions,
): Effect.Effect<TaxonMembershipJudgment, Errors.TaxonomyError, DecisionModel.DecisionModel> {
  return recordBelongsToEffect(record, target, options);
}

const recordBelongsToEffect = Effect.fn("Taxonomy.recordBelongsTo")(function* <
  T extends TaxonomicRecord,
>(record: RecordInput, target: MembershipTarget<T>, options: JudgmentOptions = {}) {
  if (taxonSetSchema.guards.Empty(target)) return membershipJudgmentSchema.cases.NotMember.make({});
  const prepared = yield* prepareMembershipTarget(target);
  const answers = yield* decideMembershipBatch([record], prepared);
  return interpretMembership(
    Array.headNonEmpty(answers),
    prepared.targetTaxa,
    options.policy ?? defaultPolicy,
  );
});

const defaultCollectionExecution = CollectionExecution.make({ batchSize: 16, concurrency: 1 });

type CollectionOptions = {
  readonly policy?: AcceptancePolicy;
  readonly execution?: CollectionExecution;
};

/**
 * Construct or validate a classification judgment with its accepted answer's support.
 * Undetermined reports no accepted classification and carries no accepted support.
 *
 * @category schemas
 * @since 0.5.0
 * @example
 * import { TaxonMatchJudgment } from "robo-taxonomist";
 * export const within = TaxonMatchJudgment.cases.WithinTaxon.make({ support: 0.97 });
 */
export const TaxonMatchJudgment = Schema.TaggedUnion({
  SameTaxon: { support: UnitInterval },
  WithinTaxon: { support: UnitInterval },
  NotMatched: { support: UnitInterval },
  Undetermined: {},
});

/**
 * Report an accepted relationship, an accepted negative answer, or no accepted classification.
 * NotMatched requires an accepted model-selected noMatch answer.
 *
 * @category models
 * @since 0.2.0
 */
export type TaxonMatchJudgment = typeof TaxonMatchJudgment.Type;

const taxonMatchCriteria = {
  sameTaxon: "A match: the record identifies this taxon, including resolved synonyms.",
  withinTaxon: "A match: the record identifies taxa classified within this broader taxon.",
  noMatch: "The supplied identification or panel expression rules out this classification.",
  undetermined: "The supplied information does not establish whether this classification is valid.",
};

type TaxonMatchAnswer = Decision.ClassifyAnswer<keyof typeof taxonMatchCriteria>;

/**
 * Keep an original record and taxon node with their scored match judgment.
 * Accepted judgments carry the selected answer's support as a finite number in [0, 1].
 * The complete validated model answer is retained without modification.
 * The record's concrete type and caller metadata remain available through R.
 *
 * @category models
 * @since 0.2.0
 */
class TaxonMatch<
  R extends RecordInput,
  T extends TaxonomicRecord = TaxonomicRecord,
> extends Data.Class<{
  readonly record: R;
  readonly taxon: Taxon<T>;
  readonly judgment: TaxonMatchJudgment;
  readonly answer: TaxonMatchAnswer;
}> {}

export type { TaxonMatch };

const isPositiveMatch = Predicate.Struct({
  judgment: TaxonMatchJudgment.isAnyOf(["SameTaxon", "WithinTaxon"]),
});

const taxonMatchInstructions =
  "Assess whether each record can be classified under each supplied taxon. " +
  "A match requires the same taxon, including resolved synonyms, " +
  "or classification within a broader taxon. Several taxa can match. " +
  "Each target identifies one taxonomic entity; choose undetermined when a target identifies multiple entities.";

const taxonMatchInputSchema = Schema.Struct({
  instructions: Schema.String,
  records: Schema.Array(Schema.String),
  taxa: Schema.Array(TaxonomicRecord),
  nodes: TaxonSetGraph.membershipTargetSchema.fields.nodes,
  panel: Schema.Natural,
});

const interpretTaxonMatch = (answer: TaxonMatchAnswer, policy: AcceptancePolicy) => {
  const support = Struct.get(answer.probabilities, answer.label);
  const alternatives = pipe(
    Record.toEntries(answer.probabilities),
    Iterable.filter(([label]) => label !== answer.label),
    Iterable.map(([, probability]) => probability),
  );
  const cases = TaxonMatchJudgment.cases;
  if (!accepts(support, alternatives, policy)) return cases.Undetermined.make({});

  return Match.value(answer.label).pipe(
    Match.literalsExhaustive({
      sameTaxon: () => cases.SameTaxon.make({ support }),
      withinTaxon: () => cases.WithinTaxon.make({ support }),
      noMatch: () => cases.NotMatched.make({ support }),
      undetermined: () => cases.Undetermined.make({}),
    }),
  );
};

const makeTaxonMatch = <R extends RecordInput, T extends TaxonomicRecord>(
  record: R,
  taxon: Taxon<T>,
  answer: TaxonMatchAnswer,
  policy: AcceptancePolicy,
) => {
  const judgment = interpretTaxonMatch(answer, policy);
  return new TaxonMatch({ record, taxon, judgment, answer });
};

const taxaOf = <T extends TaxonomicRecord>(panel: TaxonSet<T>) => {
  const taxa: Taxon<T>[] = [];
  const emptyIncluded = new WeakSet<TaxonSet<T>>();
  const emptyExcluded = new WeakSet<TaxonSet<T>>();
  const pending: {
    readonly expression: TaxonSet<T>;
    readonly include: boolean;
    readonly start?: number;
  }[] = [{ expression: panel, include: true }];
  while (pending.length > 0) {
    const next = pending.pop();
    if (next === undefined) break;
    const { expression, include, start } = next;
    const empty = include ? emptyIncluded : emptyExcluded;
    if (empty.has(expression)) continue;
    if (start !== undefined) {
      // Productive shared subtrees retain every original occurrence.
      if (taxa.length === start) empty.add(expression);
      continue;
    }
    pending.push({ expression, include, start: taxa.length });
    Match.value(expression).pipe(
      Match.tagsExhaustive({
        Empty: () => {},
        Taxon: (taxon) => {
          if (include) taxa.push(taxon);
        },
        Union: ({ operands }) => {
          for (let index = operands.length - 1; index >= 0; index--) {
            pending.push({ expression: Array.getUnsafe(operands, index), include });
          }
        },
        Intersection: ({ operands }) => {
          for (let index = operands.length - 1; index >= 0; index--) {
            pending.push({ expression: Array.getUnsafe(operands, index), include });
          }
        },
        Difference: ({ left, right }) => {
          pending.push({ expression: right, include: !include });
          pending.push({ expression: left, include });
        },
      }),
    );
  }
  return taxa;
};

type ClassifyRecordsFn = <R extends RecordInput, T extends TaxonomicRecord = TaxonomicRecord>(
  records: readonly R[],
  panel: TaxonSet<T>,
  options?: CollectionOptions,
) => Effect.Effect<
  {
    readonly panel: TaxonSet<T>;
    readonly records: readonly {
      readonly record: R;
      readonly taxa: readonly TaxonMatch<R, T>[];
      readonly ranking: readonly TaxonMatch<R, T>[];
    }[];
    readonly usage: readonly DecisionModel.DecisionUsage[];
  },
  Errors.TaxonomyError,
  DecisionModel.DecisionModel
>;

/**
 * Rank supported taxonomic matches for each record against a panel expression.
 * Accept the model-selected relationship using its individual support and margin.
 * SameTaxon and WithinTaxon establish positive classifications; NotMatched accepts noMatch.
 * Undetermined reports no accepted classification while retaining the complete scored answer.
 * Several taxa can match. Each record's taxa retains all outcomes in supplied
 * occurrence order; ranking contains accepted positive relationships in descending support order.
 * Ties retain occurrence order. Original records, metadata and taxon nodes are preserved.
 * Subtraction removes taxon occurrences from ranking options; nested subtraction can restore them.
 * Every question receives the complete panel expression.
 *
 * Uses the existing record batch size and concurrency options. Empty records or
 * a panel offering no taxa produce empty rankings without a model call.
 * A failed request fails the complete operation. Support describes model judgments,
 * not sequence-abundance fractions or a preference for a particular taxonomic rank.
 *
 * @category collections
 * @since 0.2.0
 * @example
 * import { Effect } from "effect";
 * import { TaxonName, TaxonSet, Taxonomy } from "robo-taxonomist";
 * const records = [{ scientificName: TaxonName.make("Quercus robur"), abundance: 8 }];
 * const panel = TaxonSet.union(
 *   TaxonSet.of(TaxonName.make("Quercus")),
 *   TaxonSet.of(TaxonName.make("Quercus robur")),
 * );
 * export const ranked = Effect.gen(function* () {
 *   const result = yield* Taxonomy.classifyRecords(records, panel);
 *   return result.records.map(row => row.ranking.map(match => match.taxon.record.scientificName));
 * });
 */
export const classifyRecords: ClassifyRecordsFn = Effect.fn("Taxonomy.classifyRecords")(function* <
  R extends RecordInput,
  T extends TaxonomicRecord,
>(records: readonly R[], panel: TaxonSet<T>, options: CollectionOptions = {}) {
  const graph = yield* TaxonSetGraph.compile({ panel });
  if (records.length === 0) return { panel, records: [], usage: [] };
  const panelTaxa = taxaOf(panel);
  if (panelTaxa.length === 0) {
    return {
      panel,
      records: records.map((record) => ({ record, taxa: [], ranking: [] })),
      usage: [],
    };
  }

  const policy = options.policy ?? defaultPolicy;
  const execution = options.execution ?? defaultCollectionExecution;
  const classifyBatch = Effect.fnUntraced(function* (batch: readonly R[]) {
    const encoded = yield* Schema.encodeEffect(Schema.Array(recordInputSchema))(batch).pipe(
      Effect.mapError(Errors.InvalidInput.from),
    );
    const rows = batch.map((record, row) => ({
      record,
      taxa: panelTaxa.map((taxon, column) => ({
        taxon,
        key: `r${row}t${column}` as const,
        decision: Decision.classify({
          instructions:
            `Apply instructions. Classify records[${row}] under taxa[${column}], ` +
            "using the expression rooted at nodes[panel].",
          criteria: taxonMatchCriteria,
        }),
      })),
    }));
    const definition = Decision.make({
      input: Schema.toEncoded(taxonMatchInputSchema),
      decisions: Record.fromEntries(
        rows.flatMap((row) => row.taxa.map(({ key, decision }) => [key, decision] as const)),
      ),
    });
    const encodedTaxa = yield* Schema.encodeEffect(Schema.Array(TaxonomicRecord))(
      panelTaxa.map((taxon) => taxon.record),
    ).pipe(Effect.mapError(Errors.InvalidInput.from));
    const response = yield* DecisionModel.decide(definition, {
      input: {
        instructions: taxonMatchInstructions,
        records: encoded.map(describeRecord),
        taxa: encodedTaxa,
        nodes: graph.nodes,
        panel: graph.roots.panel,
      },
    });
    const classified = rows.map((row) => {
      const taxa = row.taxa.map(({ taxon, key }) => {
        const answer = Struct.get(response.answers, key);
        return makeTaxonMatch(row.record, taxon, answer, policy);
      });
      const accepted = taxa.filter((match) => isPositiveMatch(match));
      const ranking = Array.sort(
        accepted,
        Order.Struct({ judgment: Order.Struct({ support: Order.flip(Order.Number) }) }),
      );
      return { record: row.record, taxa, ranking };
    });
    return { records: classified, usage: response.usage };
  });
  const completed = yield* Effect.forEach(
    Iterable.chunksOf(records, execution.batchSize),
    classifyBatch,
    { concurrency: execution.concurrency },
  );
  return {
    panel,
    records: completed.flatMap((batch) => batch.records),
    usage: completed.map((batch) => batch.usage),
  };
});

class MembershipPartition<
  A extends RecordInput,
  T extends TaxonomicRecord = TaxonomicRecord,
> extends Data.Class<{
  readonly Member: readonly A[];
  readonly NotMember: readonly A[];
  readonly MixedMembership: readonly A[];
  readonly Undetermined: readonly A[];
  readonly MultipleTaxaInTarget: readonly {
    readonly record: A;
    readonly target: Taxon<T>;
  }[];
}> {
  /**
   * Build ordered buckets from corresponding record and judgment batches.
   * Each judgment batch contains one judgment per record, in the same order.
   */
  static fromBatches<A extends RecordInput, T extends TaxonomicRecord = TaxonomicRecord>(
    batches: readonly (readonly A[])[],
    judgmentsByBatch: readonly (readonly TaxonMembershipJudgment<T>[])[],
  ): MembershipPartition<A, T> {
    const Member: A[] = [];
    const NotMember: A[] = [];
    const MixedMembership: A[] = [];
    const Undetermined: A[] = [];
    const MultipleTaxaInTarget: { readonly record: A; readonly target: Taxon<T> }[] = [];

    for (const [batchIndex, batch] of batches.entries()) {
      const judgments = Array.getUnsafe(judgmentsByBatch, batchIndex);
      for (const [recordIndex, record] of batch.entries()) {
        const judgment = Array.getUnsafe(judgments, recordIndex);
        Match.value(judgment).pipe(
          Match.tagsExhaustive({
            Member: () => {
              Member.push(record);
            },
            NotMember: () => {
              NotMember.push(record);
            },
            MixedMembership: () => {
              MixedMembership.push(record);
            },
            Undetermined: () => {
              Undetermined.push(record);
            },
            MultipleTaxaInTarget: ({ target }) => {
              MultipleTaxaInTarget.push({ record, target });
            },
          }),
        );
      }
    }

    return new MembershipPartition<A, T>({
      Member,
      NotMember,
      MixedMembership,
      Undetermined,
      MultipleTaxaInTarget,
    });
  }
}

/**
 * Taxonomy.partitionRecordsByMembership returns this type.
 * Its five buckets retain original record references, caller-supplied fields,
 * repeated occurrences, and input order within each bucket.
 * You can use .pipe() to transform the partition.
 * Entries in MultipleTaxaInTarget retain both the record and original target node for review.
 *
 * @category models
 * @since 0.1.0
 * @example
 * import { Effect } from "effect";
 * import { TaxonName, Taxonomy } from "robo-taxonomist";
 * const record = { scientificName: TaxonName.make("Quercus robur"), sampleId: "A17" };
 * export const memberIds = Effect.gen(function* () {
 *   const partition = yield* Taxonomy.partitionRecordsByMembership(
 *     [record, record], TaxonName.make("Quercus"),
 *   );
 *   return partition.Member.map(member => member.sampleId);
 * });
 */
export type RecordMembershipPartition<
  A extends RecordInput,
  T extends TaxonomicRecord = TaxonomicRecord,
> = MembershipPartition<A, T>;

/**
 * Separate records into membership buckets for a supplied target.
 * Preserve original references, caller fields, repeated occurrences, and input order
 * within each bucket, even when parallel batches finish out of order.
 * Defaults are 16 records per request and one active batch call; execution overrides
 * control batch size and concurrency. Every requested batch must succeed before a
 * partition is returned. Empty input returns empty buckets without a model call;
 * a literal Empty target places every record in NotMember without a model call.
 *
 * @category collections
 * @since 0.1.0
 * @example
 * import { RecordLabel, TaxonName, Taxonomy } from "robo-taxonomist";
 * export const partition = Taxonomy.partitionRecordsByMembership(
 *   [RecordLabel.make("Quercus robur specimen")], TaxonName.make("Quercus"),
 * );
 */
export function partitionRecordsByMembership<A extends RecordInput, T extends TaxonomicRecord>(
  records: readonly A[],
  target: T | TaxonSet<T>,
  options?: CollectionOptions,
): Effect.Effect<
  RecordMembershipPartition<A, T>,
  Errors.TaxonomyError,
  DecisionModel.DecisionModel
>;
export function partitionRecordsByMembership<A extends RecordInput>(
  records: readonly A[],
  target: TaxonName,
  options?: CollectionOptions,
): Effect.Effect<
  RecordMembershipPartition<A, Named>,
  Errors.TaxonomyError,
  DecisionModel.DecisionModel
>;
export function partitionRecordsByMembership<
  A extends RecordInput,
  T extends TaxonomicRecord = TaxonomicRecord,
>(
  records: readonly A[],
  target: MembershipTarget<T>,
  options?: CollectionOptions,
): Effect.Effect<
  RecordMembershipPartition<A, T | Named>,
  Errors.TaxonomyError,
  DecisionModel.DecisionModel
>;
export function partitionRecordsByMembership<A extends RecordInput>(
  records: readonly A[],
  target: MembershipTarget,
  options?: CollectionOptions,
): Effect.Effect<RecordMembershipPartition<A>, Errors.TaxonomyError, DecisionModel.DecisionModel> {
  return partitionRecordsByMembershipEffect(records, target, options);
}

const partitionRecordsByMembershipEffect = Effect.fn("Taxonomy.partitionRecordsByMembership")(
  function* <A extends RecordInput, T extends TaxonomicRecord>(
    records: readonly A[],
    target: MembershipTarget<T>,
    options: CollectionOptions = {},
  ) {
    if (taxonSetSchema.guards.Empty(target)) {
      return new MembershipPartition<A, T>({
        Member: [],
        NotMember: Array.copy(records),
        MixedMembership: [],
        Undetermined: [],
        MultipleTaxaInTarget: [],
      });
    }
    if (!Array.isReadonlyArrayNonEmpty(records))
      return MembershipPartition.fromBatches<A, T>([], []);

    const execution = options.execution ?? defaultCollectionExecution;
    const batches = Array.fromIterable(
      Iterable.filter(Iterable.chunksOf(records, execution.batchSize), Array.isArrayNonEmpty),
    );
    const prepared = yield* prepareMembershipTarget(target);
    const policy = options.policy ?? defaultPolicy;
    const judgmentsByBatch = yield* Effect.forEach(
      batches,
      (batch) =>
        decideMembershipBatch(batch, prepared).pipe(
          Effect.map((answers) =>
            Array.map(answers, (answer) =>
              interpretMembership(answer, prepared.targetTaxa, policy),
            ),
          ),
        ),
      { concurrency: execution.concurrency },
    );
    return MembershipPartition.fromBatches(batches, judgmentsByBatch);
  },
);

class MembershipPartitionsByTarget<
  A extends RecordInput,
  T extends TaxonomicRecord = TaxonomicRecord,
> extends Data.Class<{
  readonly groups: readonly {
    readonly target: MembershipTarget<T>;
    readonly partition: RecordMembershipPartition<A, T>;
  }[];
}> {}

/**
 * Taxonomy.groupRecordsByTaxa returns this type.
 * Each entry in groups pairs a supplied target with its complete membership partition.
 * Entries retain original targets, including repeats, in supplied order. Each partition
 * retains original record references, custom fields, and repeated occurrences.
 *
 * @category models
 * @since 0.1.0
 * @example
 * import { Effect } from "effect";
 * import { TaxonName, Taxonomy, TaxonSet } from "robo-taxonomist";
 * const record = { scientificName: TaxonName.make("Quercus robur"), sampleId: "A17" };
 * const target = TaxonSet.of(TaxonName.make("Quercus"));
 * export const memberIdsByTarget = Effect.gen(function* () {
 *   const grouped = yield* Taxonomy.groupRecordsByTaxa([record, record], [target, target]);
 *   return grouped.groups.map(group => group.partition.Member.map(member => member.sampleId));
 * });
 */
export type RecordsGroupedByTaxa<
  A extends RecordInput,
  T extends TaxonomicRecord = TaxonomicRecord,
> = MembershipPartitionsByTarget<A, T>;

/**
 * Partition records for each supplied target, processing targets in order.
 * Keep a complete membership partition for each target.
 * A record can belong to several targets, including a genus and its containing family.
 * Repeated targets remain separate entries and are evaluated separately.
 * A failed target fails the complete operation.
 * An empty target list returns no groups without a model call.
 *
 * @category collections
 * @since 0.1.0
 * @example
 * import { RecordLabel, TaxonName, Taxonomy } from "robo-taxonomist";
 * export const grouped = Taxonomy.groupRecordsByTaxa(
 *   [RecordLabel.make("Quercus robur specimen")],
 *   [TaxonName.make("Quercus"), TaxonName.make("Fagaceae")],
 * );
 */
export function groupRecordsByTaxa<A extends RecordInput, T extends TaxonomicRecord>(
  records: readonly A[],
  targets: readonly (T | TaxonSet<T>)[],
  options?: CollectionOptions,
): Effect.Effect<RecordsGroupedByTaxa<A, T>, Errors.TaxonomyError, DecisionModel.DecisionModel>;
export function groupRecordsByTaxa<A extends RecordInput>(
  records: readonly A[],
  targets: readonly TaxonName[],
  options?: CollectionOptions,
): Effect.Effect<RecordsGroupedByTaxa<A, Named>, Errors.TaxonomyError, DecisionModel.DecisionModel>;
export function groupRecordsByTaxa<
  A extends RecordInput,
  T extends TaxonomicRecord = TaxonomicRecord,
>(
  records: readonly A[],
  targets: readonly MembershipTarget<T>[],
  options?: CollectionOptions,
): Effect.Effect<
  RecordsGroupedByTaxa<A, T | Named>,
  Errors.TaxonomyError,
  DecisionModel.DecisionModel
>;
export function groupRecordsByTaxa<A extends RecordInput>(
  records: readonly A[],
  targets: readonly MembershipTarget[],
  options?: CollectionOptions,
): Effect.Effect<RecordsGroupedByTaxa<A>, Errors.TaxonomyError, DecisionModel.DecisionModel> {
  return groupRecordsByTaxaEffect(records, targets, options);
}

const groupRecordsByTaxaEffect = Effect.fn("Taxonomy.groupRecordsByTaxa")(function* <
  A extends RecordInput,
  T extends TaxonomicRecord,
>(records: readonly A[], targets: readonly MembershipTarget<T>[], options: CollectionOptions = {}) {
  const groups = yield* Effect.forEach(
    targets,
    (target) =>
      partitionRecordsByMembership(records, target, options).pipe(
        Effect.map((partition) => ({ target, partition })),
      ),
    { concurrency: 1 },
  );
  return new MembershipPartitionsByTarget<A, T | Named>({ groups });
});

const quantifierSchema = Schema.Literals(["all", "any", "none"]);
type RecordQuantifier = typeof quantifierSchema.Type;

const collectionMembershipJudgmentSchema = Schema.TaggedUnion({
  Yes: { quantifier: quantifierSchema },
  No: { quantifier: quantifierSchema },
  Undetermined: { quantifier: quantifierSchema },
  MultipleTaxaInTarget: { quantifier: quantifierSchema, target: Taxon },
});

/**
 * The allRecordsBelongTo, anyRecordBelongsTo, and noRecordBelongsTo functions return this type.
 * The quantifier field identifies which question they answered.
 * You can use Match.tagsExhaustive to handle the answer or report a target requiring review.
 * Each question concerns whole-record membership: every subject in a qualifying record belongs.
 * The policy combines support for outside and mixed subjects to rule out whole-record membership,
 * including cases where their separate judgments remain uncertain. A coarse Yes or No can
 * therefore settle a question whose fine-grained partition buckets remain uncertain.
 * MultipleTaxaInTarget retains the original target node for review. If needed, clarify it
 * with a TaxonSet.union of separate TaxonSet.of expressions and retry.
 *
 * @category models
 * @since 0.1.0
 * @example
 * import { Match } from "effect";
 * import type { CollectionMembershipJudgment } from "robo-taxonomist";
 * export const describe = (result: CollectionMembershipJudgment) => Match.value(result).pipe(
 *   Match.tagsExhaustive({
 *     Yes: ({ quantifier }) => `The ${quantifier} question returned Yes.`,
 *     No: ({ quantifier }) => `The ${quantifier} question returned No.`,
 *     Undetermined: ({ quantifier }) => `The ${quantifier} question remains unresolved.`,
 *     MultipleTaxaInTarget: ({ target }) =>
 *       `Review the combined target ${target.record.scientificName ?? target.record.label ?? target.record.taxonId?.id}. ` +
 *       "If needed, replace it with separate TaxonSet.of expressions combined with TaxonSet.union, then retry.",
 *   }),
 * );
 */
export type CollectionMembershipJudgment<T extends TaxonomicRecord = TaxonomicRecord> = WithTarget<
  typeof collectionMembershipJudgmentSchema.Type,
  T
>;

const yes = (quantifier: RecordQuantifier) =>
  collectionMembershipJudgmentSchema.cases.Yes.make({ quantifier });
const no = (quantifier: RecordQuantifier) =>
  collectionMembershipJudgmentSchema.cases.No.make({ quantifier });

const completedScanJudgment = (quantifier: RecordQuantifier) =>
  Match.value(quantifier).pipe(
    Match.when("all", () => yes(quantifier)),
    Match.when("any", () => no(quantifier)),
    Match.when("none", () => yes(quantifier)),
    Match.exhaustive,
  );

const quantifyRecords = Effect.fnUntraced(function* <T extends TaxonomicRecord>(
  quantifier: RecordQuantifier,
  records: readonly RecordInput[],
  target: MembershipTarget<T>,
  options: CollectionOptions = {},
): Effect.fn.Return<
  CollectionMembershipJudgment<T | { readonly scientificName: TaxonName }>,
  Errors.TaxonomyError,
  DecisionModel.DecisionModel
> {
  if (!Array.isReadonlyArrayNonEmpty(records)) return completedScanJudgment(quantifier);
  if (taxonSetSchema.guards.Empty(target))
    return Match.value(quantifier).pipe(
      Match.when("all", () => no(quantifier)),
      Match.when("any", () => no(quantifier)),
      Match.when("none", () => yes(quantifier)),
      Match.exhaustive,
    );

  const execution = options.execution ?? defaultCollectionExecution;
  const input = Array.copy(records);
  const prepared = yield* prepareMembershipTarget(target);
  const policy = options.policy ?? defaultPolicy;
  const batches = Iterable.filter(
    Iterable.chunksOf(input, execution.batchSize),
    Array.isArrayNonEmpty,
  );
  const windows = Iterable.chunksOf(batches, execution.concurrency);
  let encounteredUncertainty = false;

  for (const window of windows) {
    const resultsByBatch = yield* Effect.forEach(
      window,
      (batch) => decideMembershipBatch(batch, prepared),
      { concurrency: execution.concurrency },
    );
    for (const results of resultsByBatch) {
      for (const answer of results) {
        const p = answer.probabilities;
        const candidates: Array.NonEmptyReadonlyArray<
          Scored<boolean | CollectionMembershipJudgment<T | { readonly scientificName: TaxonName }>>
        > = [
          { answer: true, support: p.member },
          { answer: false, support: sumProbabilities([p.notMember, p.mixed]) },
          {
            answer: collectionMembershipJudgmentSchema.cases.Undetermined.make({ quantifier }),
            support: p.undetermined,
          },
        ];
        const clarifications = Array.map(
          prepared.targetTaxa,
          (
            target,
            index,
          ): Scored<
            boolean | CollectionMembershipJudgment<T | { readonly scientificName: TaxonName }>
          > => ({
            answer: {
              ...collectionMembershipJudgmentSchema.cases.MultipleTaxaInTarget.make({
                quantifier,
                target,
              }),
              target,
            },
            support: Record.get(p, `multipleTarget${index}`).pipe(Option.getOrThrow),
          }),
        );
        const selected = select(Array.appendAll(candidates, clarifications), policy);
        if (Option.isNone(selected)) {
          encounteredUncertainty = true;
          continue;
        }
        const decisive: Option.Option<
          CollectionMembershipJudgment<T | { readonly scientificName: TaxonName }>
        > = Match.value(selected.value).pipe(
          Match.when(true, () =>
            Match.value(quantifier).pipe(
              Match.when("all", () =>
                Option.none<
                  CollectionMembershipJudgment<T | { readonly scientificName: TaxonName }>
                >(),
              ),
              Match.when("any", () => Option.some(yes(quantifier))),
              Match.when("none", () => Option.some(no(quantifier))),
              Match.exhaustive,
            ),
          ),
          Match.when(false, () =>
            Match.value(quantifier).pipe(
              Match.when("all", () => Option.some(no(quantifier))),
              Match.when("any", () =>
                Option.none<
                  CollectionMembershipJudgment<T | { readonly scientificName: TaxonName }>
                >(),
              ),
              Match.when("none", () =>
                Option.none<
                  CollectionMembershipJudgment<T | { readonly scientificName: TaxonName }>
                >(),
              ),
              Match.exhaustive,
            ),
          ),
          Match.when(collectionMembershipJudgmentSchema.guards.Undetermined, () => {
            encounteredUncertainty = true;
            return Option.none<
              CollectionMembershipJudgment<T | { readonly scientificName: TaxonName }>
            >();
          }),
          Match.orElse((judgment) => Option.some(judgment)),
        );
        if (Option.isSome(decisive)) return decisive.value;
      }
    }
  }
  if (encounteredUncertainty)
    return collectionMembershipJudgmentSchema.cases.Undetermined.make({ quantifier });
  return completedScanJudgment(quantifier);
});

/**
 * Ask whether every complete record belongs to the target.
 * Accepted support ruling out whole-record membership, including mixed subjects,
 * settles No. An empty collection returns Yes without a model call.
 * Process bounded request windows until the answer is settled; every call in the
 * current window must succeed before answers are scanned in input order.
 * Defaults are 16 records per batch and one concurrent call; execution can override both.
 *
 * @category collections
 * @since 0.1.0
 * @example
 * import { RecordLabel, TaxonName, Taxonomy } from "robo-taxonomist";
 * export const all = Taxonomy.allRecordsBelongTo([RecordLabel.make("oak specimen")], TaxonName.make("Quercus"));
 */
export function allRecordsBelongTo<T extends TaxonomicRecord>(
  records: readonly RecordInput[],
  target: T | TaxonSet<T>,
  options?: CollectionOptions,
): Effect.Effect<
  CollectionMembershipJudgment<T>,
  Errors.TaxonomyError,
  DecisionModel.DecisionModel
>;
export function allRecordsBelongTo(
  records: readonly RecordInput[],
  target: TaxonName,
  options?: CollectionOptions,
): Effect.Effect<
  CollectionMembershipJudgment<Named>,
  Errors.TaxonomyError,
  DecisionModel.DecisionModel
>;
export function allRecordsBelongTo<T extends TaxonomicRecord = TaxonomicRecord>(
  records: readonly RecordInput[],
  target: MembershipTarget<T>,
  options?: CollectionOptions,
): Effect.Effect<
  CollectionMembershipJudgment<T | Named>,
  Errors.TaxonomyError,
  DecisionModel.DecisionModel
>;
export function allRecordsBelongTo(
  records: readonly RecordInput[],
  target: MembershipTarget,
  options?: CollectionOptions,
): Effect.Effect<CollectionMembershipJudgment, Errors.TaxonomyError, DecisionModel.DecisionModel> {
  return allRecordsBelongToEffect(records, target, options);
}

const allRecordsBelongToEffect = Effect.fn("Taxonomy.allRecordsBelongTo")(function* <
  T extends TaxonomicRecord,
>(records: readonly RecordInput[], target: MembershipTarget<T>, options: CollectionOptions = {}) {
  return yield* quantifyRecords("all", records, target, options);
});

/**
 * Ask whether at least one complete record belongs to the target.
 * Accepted whole-record membership settles Yes; mixed subjects alone are not a witness.
 * An empty collection returns No without a model call. Every call in the current
 * bounded request window must succeed before answers are scanned in input order,
 * so calls may include records beyond the one that settles the answer.
 *
 * @category collections
 * @since 0.1.0
 * @example
 * import { RecordLabel, TaxonName, Taxonomy } from "robo-taxonomist";
 * export const any = Taxonomy.anyRecordBelongsTo([RecordLabel.make("oak specimen")], TaxonName.make("Quercus"));
 */
export function anyRecordBelongsTo<T extends TaxonomicRecord>(
  records: readonly RecordInput[],
  target: T | TaxonSet<T>,
  options?: CollectionOptions,
): Effect.Effect<
  CollectionMembershipJudgment<T>,
  Errors.TaxonomyError,
  DecisionModel.DecisionModel
>;
export function anyRecordBelongsTo(
  records: readonly RecordInput[],
  target: TaxonName,
  options?: CollectionOptions,
): Effect.Effect<
  CollectionMembershipJudgment<Named>,
  Errors.TaxonomyError,
  DecisionModel.DecisionModel
>;
export function anyRecordBelongsTo<T extends TaxonomicRecord = TaxonomicRecord>(
  records: readonly RecordInput[],
  target: MembershipTarget<T>,
  options?: CollectionOptions,
): Effect.Effect<
  CollectionMembershipJudgment<T | Named>,
  Errors.TaxonomyError,
  DecisionModel.DecisionModel
>;
export function anyRecordBelongsTo(
  records: readonly RecordInput[],
  target: MembershipTarget,
  options?: CollectionOptions,
): Effect.Effect<CollectionMembershipJudgment, Errors.TaxonomyError, DecisionModel.DecisionModel> {
  return anyRecordBelongsToEffect(records, target, options);
}

const anyRecordBelongsToEffect = Effect.fn("Taxonomy.anyRecordBelongsTo")(function* <
  T extends TaxonomicRecord,
>(records: readonly RecordInput[], target: MembershipTarget<T>, options: CollectionOptions = {}) {
  return yield* quantifyRecords("any", records, target, options);
});

/**
 * Ask whether zero complete records belong to the target.
 * Mixed subjects do not count as a wholly belonging record, so a collection of only
 * accepted mixed or outside records can yield Yes. An empty collection returns Yes
 * without a model call. Every call in the current bounded request window must succeed
 * before answers are scanned in input order, including calls beyond a decisive record.
 *
 * @category collections
 * @since 0.1.0
 * @example
 * import { RecordLabel, TaxonName, Taxonomy } from "robo-taxonomist";
 * export const none = Taxonomy.noRecordBelongsTo([RecordLabel.make("beech specimen")], TaxonName.make("Quercus"));
 */
export function noRecordBelongsTo<T extends TaxonomicRecord>(
  records: readonly RecordInput[],
  target: T | TaxonSet<T>,
  options?: CollectionOptions,
): Effect.Effect<
  CollectionMembershipJudgment<T>,
  Errors.TaxonomyError,
  DecisionModel.DecisionModel
>;
export function noRecordBelongsTo(
  records: readonly RecordInput[],
  target: TaxonName,
  options?: CollectionOptions,
): Effect.Effect<
  CollectionMembershipJudgment<Named>,
  Errors.TaxonomyError,
  DecisionModel.DecisionModel
>;
export function noRecordBelongsTo<T extends TaxonomicRecord = TaxonomicRecord>(
  records: readonly RecordInput[],
  target: MembershipTarget<T>,
  options?: CollectionOptions,
): Effect.Effect<
  CollectionMembershipJudgment<T | Named>,
  Errors.TaxonomyError,
  DecisionModel.DecisionModel
>;
export function noRecordBelongsTo(
  records: readonly RecordInput[],
  target: MembershipTarget,
  options?: CollectionOptions,
): Effect.Effect<CollectionMembershipJudgment, Errors.TaxonomyError, DecisionModel.DecisionModel> {
  return noRecordBelongsToEffect(records, target, options);
}

const noRecordBelongsToEffect = Effect.fn("Taxonomy.noRecordBelongsTo")(function* <
  T extends TaxonomicRecord,
>(records: readonly RecordInput[], target: MembershipTarget<T>, options: CollectionOptions = {}) {
  return yield* quantifyRecords("none", records, target, options);
});
