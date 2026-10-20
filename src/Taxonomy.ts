import {
  Array,
  Data,
  Effect,
  Equivalence,
  Iterable,
  Match,
  Option,
  Predicate,
  Record,
  Schema,
  Struct,
  pipe,
} from "effect";
import { AiError, Decision, DecisionModel } from "effect/ai";
import {
  accepts,
  defaultPolicy,
  select,
  sumProbabilities,
  type AcceptancePolicy,
  type Scored,
} from "./AcceptancePolicy.ts";
import type { TaxonSet } from "./TaxonSet.ts";
import {
  CollectionExecution,
  RecordLabel,
  TaxonomicRecord,
  TaxonName,
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
) => Effect.Effect<RankComparisonJudgment, AiError.AiError, DecisionModel.DecisionModel>;

type CompareRecordsFn = (
  left: RecordInput,
  right: RecordInput,
  options?: JudgmentOptions,
) => Effect.Effect<RankComparisonJudgment, AiError.AiError, DecisionModel.DecisionModel>;

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
    }).pipe(
      Effect.mapError((error) =>
        AiError.make({
          module: "Taxonomy",
          method: "sameTaxonAtRank",
          reason: new AiError.InvalidUserInputError({ description: error.message }),
        }),
      ),
    );
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

const identityJudgmentSchema = Schema.TaggedUnion({
  SameTaxon: {},
  DifferentTaxa: {},
  MultipleTaxa: { side: Schema.Literals(["left", "right", "both"]) },
  Undetermined: {},
});

/**
 * Taxonomy.sameTaxon returns this type to report its answer about two supplied names.
 * You can use Match.tagsExhaustive to handle each result.
 * MultipleTaxa reports which combined name the model asks the caller to review.
 * Clear combinations are interpreted directly, while Undetermined leaves the identity unresolved.
 *
 * @category models
 * @since 0.1.0
 * @example
 * import { Match } from "effect";
 * import type { TaxonIdentityJudgment } from "robo-taxonomist";
 * export const describe = (result: TaxonIdentityJudgment) => Match.value(result).pipe(
 *   Match.tagsExhaustive({
 *     SameTaxon: () => "The names refer to the same taxon.",
 *     DifferentTaxa: () => "The names refer to different taxa.",
 *     MultipleTaxa: ({ side }) =>
 *       `Clarify the combined name (${side}), or compare explicit sets with TaxonSet.equivalent.`,
 *     Undetermined: () => "The comparison remains unresolved.",
 *   }),
 * );
 */
export type TaxonIdentityJudgment = typeof identityJudgmentSchema.Type;

type CompareTaxaFn = (
  left: TaxonName,
  right: TaxonName,
  options?: JudgmentOptions,
) => Effect.Effect<TaxonIdentityJudgment, AiError.AiError, DecisionModel.DecisionModel>;

const scalarInputSchema = Schema.Struct({ left: TaxonName, right: TaxonName });
const makeIdentityQuestion = (input: typeof scalarInputSchema.Encoded) =>
  Decision.make({
    input: Schema.Null,
    decisions: {
      identity: Decision.classify({
        instructions:
          "Do these names refer to the same taxon?\n" +
          "Include resolved synonyms. Flag a combined name only when it prevents comparison. " +
          "Choose multipleBoth when both names need clarification.\n" +
          `Left taxon name: ${quoteText(input.left)}\n` +
          `Right taxon name: ${quoteText(input.right)}`,
        criteria: {
          same: "Both names refer to the same taxonomic grouping, including resolved synonyms.",
          different: "The names refer to distinct taxonomic groupings.",
          undetermined: "The available information is insufficient.",
          multipleLeft: "The left name combines taxa and needs clarification.",
          multipleRight: "The right name combines taxa and needs clarification.",
          multipleBoth: "Both names combine taxa and need clarification.",
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
    return identityJudgmentSchema.cases.Undetermined.make({});
  return Match.value(answer.label).pipe(
    Match.when("same", () => identityJudgmentSchema.cases.SameTaxon.make({})),
    Match.when("different", () => identityJudgmentSchema.cases.DifferentTaxa.make({})),
    Match.when("multipleLeft", () =>
      identityJudgmentSchema.cases.MultipleTaxa.make({ side: "left" }),
    ),
    Match.when("multipleRight", () =>
      identityJudgmentSchema.cases.MultipleTaxa.make({ side: "right" }),
    ),
    Match.when("multipleBoth", () =>
      identityJudgmentSchema.cases.MultipleTaxa.make({ side: "both" }),
    ),
    Match.exhaustive,
  );
};

/**
 * Ask whether two supplied taxonomic names refer to the same taxon.
 * Resolved synonyms can match.
 *
 * @category comparisons
 * @since 0.1.0
 * @example
 * import { TaxonName, Taxonomy } from "robo-taxonomist";
 * export const identity = Taxonomy.sameTaxon(TaxonName.make("Quercus"), TaxonName.make("Fagus"));
 */
export const sameTaxon: CompareTaxaFn = Effect.fn("Taxonomy.sameTaxon")(function* (
  left: TaxonName,
  right: TaxonName,
  options: JudgmentOptions = {},
) {
  const encoded = yield* Schema.encodeEffect(scalarInputSchema)({ left, right }).pipe(
    Effect.mapError((error) =>
      AiError.make({
        module: "Taxonomy",
        method: "sameTaxon",
        reason: new AiError.InvalidUserInputError({ description: error.message }),
      }),
    ),
  );
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
 *       `Clarify the combined name (${side}), or use TaxonSet.union and TaxonSet.isSubsetOf.`,
 *     Undetermined: () => "The question remains unresolved.",
 *   }),
 * );
 */
export type TaxonContainmentJudgment = typeof containmentJudgmentSchema.Type;

type TaxonWithinFn = (
  inner: TaxonName,
  outer: TaxonName,
  options?: JudgmentOptions,
) => Effect.Effect<TaxonContainmentJudgment, AiError.AiError, DecisionModel.DecisionModel>;

const makeContainmentQuestion = (input: typeof scalarInputSchema.Encoded) =>
  Decision.make({
    input: Schema.Null,
    decisions: {
      containment: Decision.classify({
        instructions:
          "Compare the organisms represented by inner and outer. Interpret clear combinations together. " +
          "Flag a combined name only when it prevents comparison; choose multipleBoth when both names need clarification.\n" +
          `Left (inner) taxon name: ${quoteText(input.left)}\n` +
          `Right (outer) taxon name: ${quoteText(input.right)}`,
        criteria: pipe(
          TaxonRelations.criteria,
          Struct.assign({
            multipleLeft: "The inner name combines taxa and needs clarification.",
            multipleRight: "The outer name combines taxa and needs clarification.",
            multipleBoth: "Both names combine taxa and need clarification.",
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
  inner: TaxonName,
  outer: TaxonName,
  options: JudgmentOptions = {},
) {
  const encoded = yield* Schema.encodeEffect(scalarInputSchema)({ left: inner, right: outer }).pipe(
    Effect.mapError((error) =>
      AiError.make({
        module: "Taxonomy",
        method: "taxonWithin",
        reason: new AiError.InvalidUserInputError({ description: error.message }),
      }),
    ),
  );
  const { answers } = yield* DecisionModel.decide(makeContainmentQuestion(encoded), {
    input: null,
  });
  return interpretContainment(answers.containment, options.policy ?? defaultPolicy);
});

const membershipJudgmentSchema = Schema.TaggedUnion({
  Member: {},
  NotMember: {},
  MixedMembership: {},
  MultipleTaxaInTargetName: { targetName: TaxonName },
  Undetermined: {},
});

/**
 * Taxonomy.recordBelongsTo returns this type for one record and target.
 * The result reports whether all described subjects belong, all lie outside,
 * or some lie inside and others outside the target.
 * It can also identify a target name requiring review or leave the question unresolved.
 * You can use Match.tagsExhaustive to handle each result.
 * MultipleTaxaInTargetName retains the exact supplied target name for review.
 * If clarification is warranted, replace that name with a TaxonSet.union of separate
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
 *     MultipleTaxaInTargetName: ({ targetName }) =>
 *       `Review the combined target name ${targetName}. ` +
 *       "If needed, replace it with separate TaxonSet.of expressions combined with TaxonSet.union, then retry.",
 *   }),
 * );
 */
export type TaxonMembershipJudgment = typeof membershipJudgmentSchema.Type;

type MembershipTarget = TaxonName | TaxonSet;

type RecordBelongsToFn = (
  record: RecordInput,
  target: MembershipTarget,
  options?: JudgmentOptions,
) => Effect.Effect<TaxonMembershipJudgment, AiError.AiError, DecisionModel.DecisionModel>;

const batchRecordsSchema = Schema.NonEmptyArray(recordInputSchema);

const prepareMembershipTarget = Effect.fnUntraced(function* (target: MembershipTarget) {
  const invalid = (description: string) =>
    AiError.make({
      module: "Taxonomy",
      method: "makeMembershipBatchQuestion",
      reason: new AiError.InvalidUserInputError({ description }),
    });
  const expression = Predicate.isString(target)
    ? taxonSetSchema.cases.Taxon.make({
        name: yield* Schema.decodeEffect(TaxonName)(target).pipe(
          Effect.mapError((error) => invalid(error.message)),
        ),
      })
    : target;
  const compiled = yield* TaxonSetGraph.compile({ target: expression }).pipe(
    Effect.mapError((reason) =>
      AiError.make({
        module: "Taxonomy",
        method: "makeMembershipBatchQuestion",
        reason,
      }),
    ),
  );
  const targetNames = compiled.names.target;
  const input = yield* Schema.encodeEffect(TaxonSetGraph.membershipTargetSchema)({
    nodes: compiled.nodes,
    ...compiled.roots,
  }).pipe(Effect.mapError((error) => invalid(error.message)));
  const membershipChoices = {
    member: "Everything represented by the record belongs.",
    notMember: "Everything represented by the record is outside.",
    mixed: "The record jointly represents taxa inside and outside.",
    undetermined: "The available information is insufficient.",
  };
  const targetNameChoices = Record.fromEntries(
    Array.map(
      targetNames,
      (name, index) =>
        [
          `multipleTarget${index}`,
          `The target name ${quoteText(name)} combines taxa and needs clarification.`,
        ] as const,
    ),
  );
  return {
    input,
    targetNames,
    criteria: pipe(membershipChoices, Struct.assign(targetNameChoices)),
  };
});

const makeMembershipBatchQuestion = Effect.fnUntraced(function* (
  records: typeof batchRecordsSchema.Type,
  prepared: Effect.Success<ReturnType<typeof prepareMembershipTarget>>,
) {
  const encoded = yield* Schema.encodeEffect(batchRecordsSchema)(records).pipe(
    Effect.mapError((error) =>
      AiError.make({
        module: "Taxonomy",
        method: "makeMembershipBatchQuestion",
        reason: new AiError.InvalidUserInputError({ description: error.message }),
      }),
    ),
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

const interpretMembership = (
  answer: MembershipAnswer,
  targetNames: readonly TaxonName[],
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
        targetNames,
        (_name, index) => answer.label === `multipleTarget${index}`,
      ).pipe(
        Option.map((targetName) =>
          membershipJudgmentSchema.cases.MultipleTaxaInTargetName.make({ targetName }),
        ),
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
export const recordBelongsTo: RecordBelongsToFn = Effect.fn("Taxonomy.recordBelongsTo")(function* (
  record: RecordInput,
  target: MembershipTarget,
  options: JudgmentOptions = {},
) {
  if (taxonSetSchema.guards.Empty(target)) return membershipJudgmentSchema.cases.NotMember.make({});
  const prepared = yield* prepareMembershipTarget(target);
  const answers = yield* decideMembershipBatch([record], prepared);
  return interpretMembership(
    Array.headNonEmpty(answers),
    prepared.targetNames,
    options.policy ?? defaultPolicy,
  );
});

const defaultCollectionExecution = CollectionExecution.make({ batchSize: 16, concurrency: 1 });

type CollectionOptions = {
  readonly policy?: AcceptancePolicy;
  readonly execution?: CollectionExecution;
};

class MembershipPartition<A extends RecordInput> extends Data.Class<{
  readonly Member: readonly A[];
  readonly NotMember: readonly A[];
  readonly MixedMembership: readonly A[];
  readonly Undetermined: readonly A[];
  readonly MultipleTaxaInTargetName: readonly {
    readonly record: A;
    readonly targetName: TaxonName;
  }[];
}> {
  /**
   * Build ordered buckets from corresponding record and judgment batches.
   * Each judgment batch contains one judgment per record, in the same order.
   */
  static fromBatches<A extends RecordInput>(
    batches: readonly (readonly A[])[],
    judgmentsByBatch: readonly (readonly TaxonMembershipJudgment[])[],
  ): MembershipPartition<A> {
    const Member: A[] = [];
    const NotMember: A[] = [];
    const MixedMembership: A[] = [];
    const Undetermined: A[] = [];
    const MultipleTaxaInTargetName: { readonly record: A; readonly targetName: TaxonName }[] = [];

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
            MultipleTaxaInTargetName: ({ targetName }) => {
              MultipleTaxaInTargetName.push({ record, targetName });
            },
          }),
        );
      }
    }

    return new MembershipPartition<A>({
      Member,
      NotMember,
      MixedMembership,
      Undetermined,
      MultipleTaxaInTargetName,
    });
  }
}

/**
 * Taxonomy.partitionRecordsByMembership returns this type.
 * Its five buckets retain original record references, caller-supplied fields,
 * repeated occurrences, and input order within each bucket.
 * You can use .pipe() to transform the partition.
 * Entries in MultipleTaxaInTargetName retain both the record and diagnosed target name for review.
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
export type RecordMembershipPartition<A extends RecordInput> = MembershipPartition<A>;

type PartitionRecordsFn = <A extends RecordInput>(
  records: readonly A[],
  target: MembershipTarget,
  options?: CollectionOptions,
) => Effect.Effect<RecordMembershipPartition<A>, AiError.AiError, DecisionModel.DecisionModel>;

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
export const partitionRecordsByMembership: PartitionRecordsFn = Effect.fn(
  "Taxonomy.partitionRecordsByMembership",
)(function* <A extends RecordInput>(
  records: readonly A[],
  target: MembershipTarget,
  options: CollectionOptions = {},
) {
  if (taxonSetSchema.guards.Empty(target)) {
    return new MembershipPartition<A>({
      Member: [],
      NotMember: Array.copy(records),
      MixedMembership: [],
      Undetermined: [],
      MultipleTaxaInTargetName: [],
    });
  }
  if (!Array.isReadonlyArrayNonEmpty(records)) return MembershipPartition.fromBatches<A>([], []);

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
          Array.map(answers, (answer) => interpretMembership(answer, prepared.targetNames, policy)),
        ),
      ),
    { concurrency: execution.concurrency },
  );
  return MembershipPartition.fromBatches(batches, judgmentsByBatch);
});

class MembershipPartitionsByTarget<A extends RecordInput> extends Data.Class<{
  readonly groups: readonly {
    readonly target: MembershipTarget;
    readonly partition: RecordMembershipPartition<A>;
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
export type RecordsGroupedByTaxa<A extends RecordInput> = MembershipPartitionsByTarget<A>;

type GroupRecordsFn = <A extends RecordInput>(
  records: readonly A[],
  targets: readonly MembershipTarget[],
  options?: CollectionOptions,
) => Effect.Effect<RecordsGroupedByTaxa<A>, AiError.AiError, DecisionModel.DecisionModel>;

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
export const groupRecordsByTaxa: GroupRecordsFn = Effect.fn("Taxonomy.groupRecordsByTaxa")(
  function* <A extends RecordInput>(
    records: readonly A[],
    targets: readonly MembershipTarget[],
    options: CollectionOptions = {},
  ) {
    const groups = yield* Effect.forEach(
      targets,
      (target) =>
        partitionRecordsByMembership(records, target, options).pipe(
          Effect.map((partition) => ({ target, partition })),
        ),
      { concurrency: 1 },
    );
    return new MembershipPartitionsByTarget<A>({ groups });
  },
);

const quantifierSchema = Schema.Literals(["all", "any", "none"]);
type RecordQuantifier = typeof quantifierSchema.Type;

const collectionMembershipJudgmentSchema = Schema.TaggedUnion({
  Yes: { quantifier: quantifierSchema },
  No: { quantifier: quantifierSchema },
  Undetermined: { quantifier: quantifierSchema },
  MultipleTaxaInTargetName: { quantifier: quantifierSchema, targetName: TaxonName },
});

/**
 * The allRecordsBelongTo, anyRecordBelongsTo, and noRecordBelongsTo functions return this type.
 * The quantifier field identifies which question they answered.
 * You can use Match.tagsExhaustive to handle the answer or report a target name requiring review.
 * Each question concerns whole-record membership: every subject in a qualifying record belongs.
 * The policy combines support for outside and mixed subjects to rule out whole-record membership,
 * including cases where their separate judgments remain uncertain. A coarse Yes or No can
 * therefore settle a question whose fine-grained partition buckets remain uncertain.
 * MultipleTaxaInTargetName retains the diagnosed name for review. If needed, clarify it
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
 *     MultipleTaxaInTargetName: ({ targetName }) =>
 *       `Review the combined target name ${targetName}. ` +
 *       "If needed, replace it with separate TaxonSet.of expressions combined with TaxonSet.union, then retry.",
 *   }),
 * );
 */
export type CollectionMembershipJudgment = typeof collectionMembershipJudgmentSchema.Type;

const yes = (quantifier: RecordQuantifier) =>
  collectionMembershipJudgmentSchema.cases.Yes.make({ quantifier });
const no = (quantifier: RecordQuantifier) =>
  collectionMembershipJudgmentSchema.cases.No.make({ quantifier });

const completedScanJudgment = (quantifier: RecordQuantifier): CollectionMembershipJudgment =>
  Match.value(quantifier).pipe(
    Match.when("all", () => yes(quantifier)),
    Match.when("any", () => no(quantifier)),
    Match.when("none", () => yes(quantifier)),
    Match.exhaustive,
  );

const quantifyRecords = Effect.fnUntraced(function* (
  quantifier: RecordQuantifier,
  records: readonly RecordInput[],
  target: MembershipTarget,
  options: CollectionOptions = {},
): Effect.fn.Return<CollectionMembershipJudgment, AiError.AiError, DecisionModel.DecisionModel> {
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
          Scored<boolean | CollectionMembershipJudgment>
        > = [
          { answer: true, support: p.member },
          { answer: false, support: sumProbabilities([p.notMember, p.mixed]) },
          {
            answer: collectionMembershipJudgmentSchema.cases.Undetermined.make({ quantifier }),
            support: p.undetermined,
          },
        ];
        const clarifications = Array.map(
          prepared.targetNames,
          (targetName, index): Scored<boolean | CollectionMembershipJudgment> => ({
            answer: collectionMembershipJudgmentSchema.cases.MultipleTaxaInTargetName.make({
              quantifier,
              targetName,
            }),
            support: Record.get(p, `multipleTarget${index}`).pipe(Option.getOrThrow),
          }),
        );
        const selected = select(Array.appendAll(candidates, clarifications), policy);
        if (Option.isNone(selected)) {
          encounteredUncertainty = true;
          continue;
        }
        const decisive: Option.Option<CollectionMembershipJudgment> = Match.value(
          selected.value,
        ).pipe(
          Match.when(true, () =>
            Match.value(quantifier).pipe(
              Match.when("all", () => Option.none<CollectionMembershipJudgment>()),
              Match.when("any", () => Option.some(yes(quantifier))),
              Match.when("none", () => Option.some(no(quantifier))),
              Match.exhaustive,
            ),
          ),
          Match.when(false, () =>
            Match.value(quantifier).pipe(
              Match.when("all", () => Option.some(no(quantifier))),
              Match.when("any", () => Option.none<CollectionMembershipJudgment>()),
              Match.when("none", () => Option.none<CollectionMembershipJudgment>()),
              Match.exhaustive,
            ),
          ),
          Match.when(collectionMembershipJudgmentSchema.guards.Undetermined, () => {
            encounteredUncertainty = true;
            return Option.none<CollectionMembershipJudgment>();
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

type QuantifyRecordsFn = (
  records: readonly RecordInput[],
  target: MembershipTarget,
  options?: CollectionOptions,
) => Effect.Effect<CollectionMembershipJudgment, AiError.AiError, DecisionModel.DecisionModel>;

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
export const allRecordsBelongTo: QuantifyRecordsFn = Effect.fn("Taxonomy.allRecordsBelongTo")(
  function* (
    records: readonly RecordInput[],
    target: MembershipTarget,
    options: CollectionOptions = {},
  ) {
    return yield* quantifyRecords("all", records, target, options);
  },
);

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
export const anyRecordBelongsTo: QuantifyRecordsFn = Effect.fn("Taxonomy.anyRecordBelongsTo")(
  function* (
    records: readonly RecordInput[],
    target: MembershipTarget,
    options: CollectionOptions = {},
  ) {
    return yield* quantifyRecords("any", records, target, options);
  },
);

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
export const noRecordBelongsTo: QuantifyRecordsFn = Effect.fn("Taxonomy.noRecordBelongsTo")(
  function* (
    records: readonly RecordInput[],
    target: MembershipTarget,
    options: CollectionOptions = {},
  ) {
    return yield* quantifyRecords("none", records, target, options);
  },
);
