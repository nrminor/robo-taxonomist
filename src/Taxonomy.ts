import {
  Array,
  Data,
  Effect,
  Equivalence,
  Iterable,
  Match,
  Number,
  Option,
  Predicate,
  Record,
  Schema,
  Struct,
  pipe,
} from "effect";
import { AiError, Decision, DecisionModel } from "effect/ai";
import type { TaxonSet } from "./TaxonSet.ts";
import {
  CollectionExecution,
  JudgmentPolicy,
  RankComparisonPolicy,
  RecordLabel,
  TaxonomicRecord,
  TaxonName,
  taxonSetSchema,
} from "./schemas.ts";
import * as TaxonSetGraph from "./TaxonSetGraph.ts";

/**
 * Check whether two record labels contain exactly the same text. This is a simple
 * deterministic string comparison and does not invoke a model.
 *
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
 * @example
 * import type { TaxonomicRank } from "robo-taxonomist";
 * export const requestedRank: TaxonomicRank = "species";
 */
export type TaxonomicRank = typeof taxonomicRankSchema.Type;

const rankComparisonResultSchema = Schema.TaggedUnion({
  SameTaxonAtRank: { rank: taxonomicRankSchema },
  DifferentTaxaAtRank: { rank: taxonomicRankSchema },
  Undetermined: { rank: taxonomicRankSchema },
  MultipleTaxaAtRank: {
    rank: taxonomicRankSchema,
    side: Schema.Literals(["left", "right", "both"]),
  },
});

/**
 * Taxonomy.sameTaxonAtRank and its rank helpers return this type.
 * The result reports whether two records describe the same taxon or different
 * taxa at the requested rank, whether either record describes multiple taxa,
 * or whether the comparison remains unresolved.
 * You can use Match.tagsExhaustive to handle each possible result.
 * In a MultipleTaxaAtRank result, side identifies which records, left or right,
 * describe multiple taxa.
 * Compare records that each describe one taxon at the requested rank.
 * To compare intentional combinations, construct each taxon with TaxonSet.of,
 * combine the expressions with TaxonSet.union, and use a set-relation operation.
 *
 * @example
 * import { Match } from "effect";
 * import type { RankComparisonResult } from "robo-taxonomist";
 * export const describe = (result: RankComparisonResult) => Match.value(result).pipe(
 *   Match.tagsExhaustive({
 *     SameTaxonAtRank: ({ rank }) => `Same taxon at ${rank} rank`,
 *     DifferentTaxaAtRank: ({ rank }) => `Different taxa at ${rank} rank`,
 *     Undetermined: ({ rank }) => `Undetermined at ${rank} rank`,
 *     MultipleTaxaAtRank: ({ rank, side }) =>
 *       `Several taxa occur at ${rank} rank (${side}). ` +
 *       "Compare records with one taxon at this rank each, or build explicit taxon sets.",
 *   }),
 * );
 */
export type RankComparisonResult = typeof rankComparisonResultSchema.Type;

const recordInputSchema = Schema.Union([RecordLabel, TaxonomicRecord]);
type RecordInput = typeof recordInputSchema.Type;

type RankComparisonOptions = {
  readonly policy?: RankComparisonPolicy;
};

// Fn aliases keep public calling contracts separate from traced implementations.
type CompareRecordsAtRankFn = (
  left: RecordInput,
  right: RecordInput,
  rank: TaxonomicRank,
  options?: RankComparisonOptions,
) => Effect.Effect<RankComparisonResult, AiError.AiError, DecisionModel.DecisionModel>;

type CompareRecordsFn = (
  left: RecordInput,
  right: RecordInput,
  options?: RankComparisonOptions,
) => Effect.Effect<RankComparisonResult, AiError.AiError, DecisionModel.DecisionModel>;

const defaultRankComparisonPolicy = RankComparisonPolicy.make({
  minimumSupport: 0.5,
  minimumMargin: 0,
});

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
          `Do these records represent the same taxon at ${rank} rank?\n` +
          "Determine which taxa each record represents at the requested rank. " +
          "Several subjects or species can belong to one taxon at that rank. " +
          "Compare the records when each represents one taxon at that rank. " +
          "If a record clearly represents several distinct taxa at that rank, identify that record instead. " +
          "Choose multipleBoth when both records clearly represent several distinct taxa at the requested rank. " +
          "Otherwise, choose multipleLeft for several distinct taxa in the left record, or multipleRight for several distinct taxa in the right record. " +
          "Synonyms and acronyms for one taxon still represent one taxon. " +
          "Use undetermined when you cannot compare the records at the requested rank and cannot identify several distinct taxa in either record.\n" +
          `Left record:\n${describeRecord(left)}\n` +
          `Right record:\n${describeRecord(right)}`,
        criteria: {
          same: "Each record represents one taxon at the requested rank, and these taxa are the same, including any acronyms and/or synonyms.",
          different:
            "Each record represents one taxon at the requested rank, and these taxa differ.",
          undetermined:
            "The available information is insufficient to compare the records' taxonomic ranks.",
          multipleLeft:
            "The left record represents multiple distinct taxa at the requested rank, preventing a comparison of one taxon per record at that rank.",
          multipleRight:
            "The right record represents multiple distinct taxa at the requested rank, preventing a comparison of one taxon per record at that rank.",
          multipleBoth: "Each record represents multiple distinct taxa at the requested rank.",
        },
      }),
    },
  });

type RankComparisonAnswer = Decision.Answer<
  ReturnType<typeof makeRankComparisonQuestion>["decisions"]["comparison"]
>;

const interpretRankComparison = (
  rank: TaxonomicRank,
  answer: RankComparisonAnswer,
  policy: RankComparisonPolicy,
): RankComparisonResult => {
  if (answer.label === "undetermined") {
    return rankComparisonResultSchema.cases.Undetermined.make({ rank });
  }

  const support = answer.probabilities[answer.label];
  const strongestAlternative = Record.reduce(
    answer.probabilities,
    0,
    (strongest, probability, label) =>
      label === answer.label ? strongest : Number.max(strongest, probability),
  );
  const margin = support - strongestAlternative;

  // Unit-interval margins allow one machine epsilon for subtraction rounding.
  const accepted =
    margin > 0 &&
    support >= policy.minimumSupport &&
    (margin >= policy.minimumMargin || policy.minimumMargin - margin <= globalThis.Number.EPSILON);

  if (!accepted) {
    return rankComparisonResultSchema.cases.Undetermined.make({ rank });
  }

  return Match.value(answer.label).pipe(
    Match.when("same", () => rankComparisonResultSchema.cases.SameTaxonAtRank.make({ rank })),
    Match.when("different", () =>
      rankComparisonResultSchema.cases.DifferentTaxaAtRank.make({ rank }),
    ),
    Match.when("multipleLeft", () =>
      rankComparisonResultSchema.cases.MultipleTaxaAtRank.make({ rank, side: "left" }),
    ),
    Match.when("multipleRight", () =>
      rankComparisonResultSchema.cases.MultipleTaxaAtRank.make({ rank, side: "right" }),
    ),
    Match.when("multipleBoth", () =>
      rankComparisonResultSchema.cases.MultipleTaxaAtRank.make({ rank, side: "both" }),
    ),
    Match.exhaustive,
  );
};

/**
 * Decide whether the subjects described by two records are the same at a requested rank.
 * A record describing Quercus robur and Quercus petraea can resolve to one genus,
 * Quercus, while describing two species for a species-rank comparison.
 *
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
    options: RankComparisonOptions = {},
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

    return interpretRankComparison(
      rank,
      answers.comparison,
      options.policy ?? defaultRankComparisonPolicy,
    );
  },
);

/**
 * Compare two records at species rank.
 *
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
  options: RankComparisonOptions = {},
) => sameTaxonAtRank(left, right, "species", options);

/**
 * Compare two records at domain rank.
 *
 * @example
 * import { RecordLabel, Taxonomy } from "robo-taxonomist";
 * export const comparison = Taxonomy.sameDomain(
 *   RecordLabel.make("Quercus robur"), RecordLabel.make("Quercus petraea"),
 * );
 */
export const sameDomain: CompareRecordsFn = (
  left: RecordInput,
  right: RecordInput,
  options: RankComparisonOptions = {},
) => sameTaxonAtRank(left, right, "domain", options);

/**
 * Compare two records at kingdom rank.
 *
 * @example
 * import { RecordLabel, Taxonomy } from "robo-taxonomist";
 * export const comparison = Taxonomy.sameKingdom(
 *   RecordLabel.make("Quercus robur"), RecordLabel.make("Quercus petraea"),
 * );
 */
export const sameKingdom: CompareRecordsFn = (
  left: RecordInput,
  right: RecordInput,
  options: RankComparisonOptions = {},
) => sameTaxonAtRank(left, right, "kingdom", options);

/**
 * Compare two records at phylum rank.
 *
 * @example
 * import { RecordLabel, Taxonomy } from "robo-taxonomist";
 * export const comparison = Taxonomy.samePhylum(
 *   RecordLabel.make("Quercus robur"), RecordLabel.make("Quercus petraea"),
 * );
 */
export const samePhylum: CompareRecordsFn = (
  left: RecordInput,
  right: RecordInput,
  options: RankComparisonOptions = {},
) => sameTaxonAtRank(left, right, "phylum", options);

/**
 * Compare two records at class rank.
 *
 * @example
 * import { RecordLabel, Taxonomy } from "robo-taxonomist";
 * export const comparison = Taxonomy.sameClass(
 *   RecordLabel.make("Quercus robur"), RecordLabel.make("Quercus petraea"),
 * );
 */
export const sameClass: CompareRecordsFn = (
  left: RecordInput,
  right: RecordInput,
  options: RankComparisonOptions = {},
) => sameTaxonAtRank(left, right, "class", options);

/**
 * Compare two records at order rank.
 *
 * @example
 * import { RecordLabel, Taxonomy } from "robo-taxonomist";
 * export const comparison = Taxonomy.sameOrder(
 *   RecordLabel.make("Quercus robur"), RecordLabel.make("Quercus petraea"),
 * );
 */
export const sameOrder: CompareRecordsFn = (
  left: RecordInput,
  right: RecordInput,
  options: RankComparisonOptions = {},
) => sameTaxonAtRank(left, right, "order", options);

/**
 * Compare two records at family rank.
 *
 * @example
 * import { RecordLabel, Taxonomy } from "robo-taxonomist";
 * export const comparison = Taxonomy.sameFamily(
 *   RecordLabel.make("Quercus robur"), RecordLabel.make("Quercus petraea"),
 * );
 */
export const sameFamily: CompareRecordsFn = (
  left: RecordInput,
  right: RecordInput,
  options: RankComparisonOptions = {},
) => sameTaxonAtRank(left, right, "family", options);

/**
 * Compare two records at genus rank.
 *
 * @example
 * import { RecordLabel, Taxonomy } from "robo-taxonomist";
 * export const comparison = Taxonomy.sameGenus(
 *   RecordLabel.make("Quercus robur"), RecordLabel.make("Quercus petraea"),
 * );
 */
export const sameGenus: CompareRecordsFn = (
  left: RecordInput,
  right: RecordInput,
  options: RankComparisonOptions = {},
) => sameTaxonAtRank(left, right, "genus", options);

const identityResultSchema = Schema.TaggedUnion({
  SameTaxon: {},
  DifferentTaxa: {},
  MultipleTaxa: { side: Schema.Literals(["left", "right", "both"]) },
  Undetermined: {},
});

/**
 * Taxonomy.sameTaxon returns this type to report its answer about two supplied names.
 * You can use Match.tagsExhaustive to handle each result.
 * In a MultipleTaxa result, side identifies the names that jointly refer to multiple taxa.
 * Build each intended taxon with TaxonSet.of and combine the expressions with TaxonSet.union.
 * Use TaxonSet.equivalent to compare the organisms in the resulting sets.
 * @example
 * import { Match } from "effect";
 * import type { TaxonIdentityResult } from "robo-taxonomist";
 * export const describe = (result: TaxonIdentityResult) => Match.value(result).pipe(
 *   Match.tagsExhaustive({
 *     SameTaxon: () => "The names refer to the same taxon.",
 *     DifferentTaxa: () => "The names refer to different taxa.",
 *     MultipleTaxa: ({ side }) =>
 *       `Several taxa were identified (${side}). ` +
 *       "Build separate TaxonSet.of expressions, combine them with TaxonSet.union, " +
 *       "and compare their organism sets with TaxonSet.equivalent.",
 *     Undetermined: () => "The comparison remains unresolved.",
 *   }),
 * );
 */
export type TaxonIdentityResult = typeof identityResultSchema.Type;

type JudgmentOptions = { readonly policy?: JudgmentPolicy };

type CompareTaxaFn = (
  left: TaxonName,
  right: TaxonName,
  options?: JudgmentOptions,
) => Effect.Effect<TaxonIdentityResult, AiError.AiError, DecisionModel.DecisionModel>;

const defaultJudgmentPolicy = JudgmentPolicy.make({ minimumSupport: 0.5, minimumMargin: 0 });

const accepts = (answer: Decision.ClassifyAnswer<string>, policy: JudgmentPolicy) => {
  if (answer.label === "undetermined") return false;
  const support = Record.get(answer.probabilities, answer.label).pipe(Option.getOrThrow);
  const strongestAlternative = Record.reduce(
    answer.probabilities,
    0,
    (strongest, probability, label) =>
      label === answer.label ? strongest : Number.max(strongest, probability),
  );
  const margin = support - strongestAlternative;
  return (
    margin > 0 &&
    support >= policy.minimumSupport &&
    (margin >= policy.minimumMargin || policy.minimumMargin - margin <= globalThis.Number.EPSILON)
  );
};

const scalarInputSchema = Schema.Struct({ left: TaxonName, right: TaxonName });
const makeIdentityQuestion = (input: typeof scalarInputSchema.Encoded) =>
  Decision.make({
    input: Schema.Null,
    decisions: {
      identity: Decision.classify({
        instructions:
          "Do these names refer to the same taxon?\n" +
          "Compare the names when each identifies one taxon. Synonyms and acronyms for one taxon still identify one taxon. " +
          "If a name clearly describes several distinct taxa together, choose its multiple-taxa label instead of interpreting the name as a set expression. " +
          "Choose multipleBoth when both names clearly refer to several distinct taxa. " +
          "Otherwise, choose multipleLeft when the left name clearly refers to several distinct taxa, or multipleRight when the right name clearly refers to several distinct taxa. " +
          "The caller can construct each intended taxon with TaxonSet.of, combine the expressions with TaxonSet.union, and compare their organism sets with TaxonSet.equivalent. " +
          "Use undetermined when you cannot tell whether the names refer to the same or different taxa and cannot identify a name that clearly refers to several taxa.\n" +
          `Left taxon name: ${quoteText(input.left)}\n` +
          `Right taxon name: ${quoteText(input.right)}`,
        criteria: {
          same: "Both names refer to the same taxonomic grouping, including resolved synonyms.",
          different: "The names refer to distinct taxonomic groupings.",
          undetermined: "The available information is insufficient.",
          multipleLeft:
            "The left name refers to several distinct taxa together.",
          multipleRight:
            "The right name refers to several distinct taxa together.",
          multipleBoth:
            "Both the left and right names refer to several distinct taxa together.",
        },
      }),
    },
  });

type IdentityAnswer = Decision.Answer<
  ReturnType<typeof makeIdentityQuestion>["decisions"]["identity"]
>;
const interpretIdentity = (answer: IdentityAnswer, policy: JudgmentPolicy) => {
  if (!accepts(answer, policy)) return identityResultSchema.cases.Undetermined.make({});
  return Match.value(answer.label).pipe(
    Match.when("same", () => identityResultSchema.cases.SameTaxon.make({})),
    Match.when("different", () => identityResultSchema.cases.DifferentTaxa.make({})),
    Match.when("multipleLeft", () =>
      identityResultSchema.cases.MultipleTaxa.make({ side: "left" }),
    ),
    Match.when("multipleRight", () =>
      identityResultSchema.cases.MultipleTaxa.make({ side: "right" }),
    ),
    Match.when("multipleBoth", () =>
      identityResultSchema.cases.MultipleTaxa.make({ side: "both" }),
    ),
    Match.when("undetermined", () => identityResultSchema.cases.Undetermined.make({})),
    Match.exhaustive,
  );
};

/**
 * Ask whether two supplied taxonomic names refer to the same taxon.
 *
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
  return interpretIdentity(answers.identity, options.policy ?? defaultJudgmentPolicy);
});

const containmentResultSchema = Schema.TaggedUnion({
  Contained: {},
  NotContained: {},
  MultipleTaxa: { side: Schema.Literals(["left", "right", "both"]) },
  Undetermined: {},
});

/**
 * Taxonomy.taxonWithin returns this type to report whether the inner taxon belongs wholly to outer.
 * You can use Match.tagsExhaustive to handle each result.
 * In a MultipleTaxa result, side identifies the supplied names requiring review:
 * left identifies inner, right identifies outer, and both identifies both names.
 * Build each intended taxon with TaxonSet.of and combine the expressions with TaxonSet.union.
 * Use TaxonSet.isSubsetOf to compare the resulting inner and outer sets.
 * @example
 * import { Match } from "effect";
 * import type { TaxonContainmentResult } from "robo-taxonomist";
 * export const describe = (result: TaxonContainmentResult) => Match.value(result).pipe(
 *   Match.tagsExhaustive({
 *     Contained: () => "Every inner organism belongs to outer.",
 *     NotContained: () => "At least one inner organism lies outside outer.",
 *     MultipleTaxa: ({ side }) =>
 *       `Several taxa were identified (${side}). ` +
 *       "Build separate TaxonSet.of expressions, combine them with TaxonSet.union, " +
 *       "and compare the inner and outer sets with TaxonSet.isSubsetOf.",
 *     Undetermined: () => "The question remains unresolved.",
 *   }),
 * );
 */
export type TaxonContainmentResult = typeof containmentResultSchema.Type;

type TaxonWithinFn = (
  inner: TaxonName,
  outer: TaxonName,
  options?: JudgmentOptions,
) => Effect.Effect<TaxonContainmentResult, AiError.AiError, DecisionModel.DecisionModel>;

const makeContainmentQuestion = (input: typeof scalarInputSchema.Encoded) =>
  Decision.make({
    input: Schema.Null,
    decisions: {
      containment: Decision.classify({
        instructions:
          "Is the inner taxon contained in the outer taxon?\n" +
          "Assess containment when each supplied name identifies one taxon. Equality counts as containment. " +
          "Synonyms and acronyms for one taxon still identify one taxon. " +
          "If a name clearly describes several distinct taxa together, choose its multiple-taxa label even if their combined organisms would satisfy containment. " +
          "The caller can construct each intended taxon with TaxonSet.of, combine the expressions with TaxonSet.union, and use TaxonSet.isSubsetOf to compare the inner and outer sets. " +
          "Preserve each supplied name instead of splitting it or silently treating it as a union. " +
          "Choose multipleBoth when both names clearly refer to several distinct taxa. " +
          "Otherwise, choose multipleLeft when the inner name clearly refers to several distinct taxa, or multipleRight when the outer name clearly refers to several distinct taxa. " +
          "Use undetermined when you cannot answer whether the inner taxon is contained in the outer taxon and cannot identify a name that clearly refers to several taxa.\n" +
          `Left (inner) taxon name: ${quoteText(input.left)}\n` +
          `Right (outer) taxon name: ${quoteText(input.right)}`,
        criteria: {
          contained:
            "Every organism belonging to the inner taxon belongs to the outer taxon and is thus fully contained.",
          notContained:
            "At least one organism belonging to the inner taxon is outside the outer taxon.",
          undetermined:
            "The available information is insufficient to assess containment of the inner taxon within the outer taxon.",
          multipleLeft:
            "The inner name references multiple distinct taxa rather than a single taxon.",
          multipleRight:
            "The outer name references multiple distinct taxa rather than just one.",
          multipleBoth:
            "Both the left and right inputs reference multiple distinct taxa rather than a single one each.",
        },
      }),
    },
  });

type ContainmentAnswer = Decision.Answer<
  ReturnType<typeof makeContainmentQuestion>["decisions"]["containment"]
>;
const interpretContainment = (answer: ContainmentAnswer, policy: JudgmentPolicy) => {
  if (!accepts(answer, policy)) return containmentResultSchema.cases.Undetermined.make({});
  return Match.value(answer.label).pipe(
    Match.when("contained", () => containmentResultSchema.cases.Contained.make({})),
    Match.when("notContained", () => containmentResultSchema.cases.NotContained.make({})),
    Match.when("multipleLeft", () =>
      containmentResultSchema.cases.MultipleTaxa.make({ side: "left" }),
    ),
    Match.when("multipleRight", () =>
      containmentResultSchema.cases.MultipleTaxa.make({ side: "right" }),
    ),
    Match.when("multipleBoth", () =>
      containmentResultSchema.cases.MultipleTaxa.make({ side: "both" }),
    ),
    Match.when("undetermined", () => containmentResultSchema.cases.Undetermined.make({})),
    Match.exhaustive,
  );
};

/**
 * Ask whether every organism in the named inner taxon belongs to the named outer taxon.
 * Contained includes equality. NotContained reports at least one organism outside outer.
 *
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
  return interpretContainment(answers.containment, options.policy ?? defaultJudgmentPolicy);
});

const membershipResultSchema = Schema.TaggedUnion({
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
 * For MultipleTaxaInTargetName, replace the identified name in the target expression
 * with a TaxonSet.union of separately constructed TaxonSet.of expressions, then retry.
 * @example
 * import { Match } from "effect";
 * import type { TaxonMembershipResult } from "robo-taxonomist";
 * export const describe = (result: TaxonMembershipResult) => Match.value(result).pipe(
 *   Match.tagsExhaustive({
 *     Member: () => "Wholly inside", NotMember: () => "Wholly outside",
 *     MixedMembership: () => "Subjects both inside and outside",
 *     Undetermined: () => "Needs review",
 *     MultipleTaxaInTargetName: ({ targetName }) =>
 *       `The target name ${targetName} describes several taxa. ` +
 *       "Replace it with separate TaxonSet.of expressions combined with TaxonSet.union, then retry.",
 *   }),
 * );
 */
export type TaxonMembershipResult = typeof membershipResultSchema.Type;

type MembershipTarget = TaxonName | TaxonSet;

type RecordBelongsToFn = (
  record: RecordInput,
  target: MembershipTarget,
  options?: JudgmentOptions,
) => Effect.Effect<TaxonMembershipResult, AiError.AiError, DecisionModel.DecisionModel>;

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
  const targetNames = TaxonSetGraph.collectTaxonNames(compiled.nodes, compiled.roots.target);
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
          `The name ${quoteText(name)} jointly names distinct taxa, rather than one taxon. The caller needs to supply these taxa separately in an explicit union.`,
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
                "Classify this record's membership in the supplied taxon or taxon-set expression.\n" +
                `${TaxonSetGraph.instructions} Root is target.\n` +
                "A record may describe several subjects or taxa. Classify them together against the complete target. " +
                "Choose mixed only when the record clearly describes at least one subject inside the target and at least one outside.\n" +
                describeRecord(record),
              criteria: prepared.criteria,
            }),
          ] as const,
      ),
    ),
  });
});

const interpretMembership = (
  answer: Decision.ClassifyAnswer<string>,
  targetNames: readonly TaxonName[],
  policy: JudgmentPolicy,
) => {
  if (!accepts(answer, policy)) return membershipResultSchema.cases.Undetermined.make({});
  return Match.value(answer.label).pipe(
    Match.when("member", () => membershipResultSchema.cases.Member.make({})),
    Match.when("notMember", () => membershipResultSchema.cases.NotMember.make({})),
    Match.when("mixed", () => membershipResultSchema.cases.MixedMembership.make({})),
    Match.orElse(() =>
      Array.findFirst(
        targetNames,
        (_name, index) => answer.label === `multipleTarget${index}`,
      ).pipe(
        Option.map((targetName) =>
          membershipResultSchema.cases.MultipleTaxaInTargetName.make({ targetName }),
        ),
        Option.getOrThrow,
      ),
    ),
  );
};

const decideMembershipBatch = Effect.fnUntraced(function* (
  records: typeof batchRecordsSchema.Type,
  prepared: Effect.Success<ReturnType<typeof prepareMembershipTarget>>,
  options: JudgmentOptions = {},
) {
  const definition = yield* makeMembershipBatchQuestion(records, prepared);
  const { answers } = yield* DecisionModel.decide(definition, { input: prepared.input });
  const policy = options.policy ?? defaultJudgmentPolicy;
  return Array.map(records, (_record, index) =>
    interpretMembership(
      Record.get(answers, `record${index}`).pipe(Option.getOrThrow),
      prepared.targetNames,
      policy,
    ),
  );
});

/**
 * Ask whether every subject described by a record belongs to the complete target.
 * MixedMembership reports at least one subject inside and at least one outside the target.
 * Answer a literal Empty target directly; use one classification for other targets.
 * @example
 * import { RecordLabel, TaxonName, Taxonomy } from "robo-taxonomist";
 * export const membership = Taxonomy.recordBelongsTo(RecordLabel.make("Quercus robur specimen"), TaxonName.make("Quercus"));
 */
export const recordBelongsTo: RecordBelongsToFn = Effect.fn("Taxonomy.recordBelongsTo")(function* (
  record: RecordInput,
  target: MembershipTarget,
  options: JudgmentOptions = {},
) {
  if (taxonSetSchema.guards.Empty(target)) return membershipResultSchema.cases.NotMember.make({});
  const prepared = yield* prepareMembershipTarget(target);
  const results = yield* decideMembershipBatch([record], prepared, options);
  return Array.headNonEmpty(results);
});

const defaultCollectionExecution = CollectionExecution.make({ batchSize: 16, concurrency: 1 });

type CollectionOptions = {
  readonly policy?: JudgmentPolicy;
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
    judgmentsByBatch: readonly (readonly TaxonMembershipResult[])[],
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
 * Its five buckets retain original records, caller-supplied fields, and input order.
 * You can use .pipe() to transform the partition.
 * Entries in MultipleTaxaInTargetName identify target names to replace with
 * explicit unions of separately constructed taxon expressions before retrying.
 * @example
 * import type { RecordMembershipPartition, TaxonomicRecord } from "robo-taxonomist";
 * export const members = (partition: RecordMembershipPartition<TaxonomicRecord>) =>
 *   partition.pipe(value => value.Member);
 */
export type RecordMembershipPartition<A extends RecordInput> = MembershipPartition<A>;

type PartitionRecordsFn = <A extends RecordInput>(
  records: readonly A[],
  target: MembershipTarget,
  options?: CollectionOptions,
) => Effect.Effect<RecordMembershipPartition<A>, AiError.AiError, DecisionModel.DecisionModel>;

/**
 * Separate records into membership buckets for a supplied target.
 * Keep original references, caller fields, and input order within each bucket.
 * Default to 16 records per request and one active batch call.
 * Return the partition after every requested batch succeeds.
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
  const judgmentsByBatch = yield* Effect.forEach(
    batches,
    (batch) => decideMembershipBatch(batch, prepared, options),
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
 * The entries follow the supplied target order.
 * @example
 * import type { RecordsGroupedByTaxa, TaxonomicRecord } from "robo-taxonomist";
 * export const members = (grouped: RecordsGroupedByTaxa<TaxonomicRecord>) =>
 *   grouped.pipe(value => value.groups.map(group => group.partition.Member));
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

const collectionMembershipResultSchema = Schema.TaggedUnion({
  Yes: { quantifier: quantifierSchema },
  No: { quantifier: quantifierSchema },
  Undetermined: { quantifier: quantifierSchema },
  MultipleTaxaInTargetName: { quantifier: quantifierSchema, targetName: TaxonName },
});

/**
 * The allRecordsBelongTo, anyRecordBelongsTo, and noRecordBelongsTo functions return this type.
 * The quantifier field identifies which question they answered.
 * You can use Match.tagsExhaustive to handle the answer or report a target name requiring review.
 * For MultipleTaxaInTargetName, replace the identified target name with a TaxonSet.union
 * of separately constructed TaxonSet.of expressions, then retry the collection question.
 * @example
 * import { Match } from "effect";
 * import type { CollectionMembershipResult } from "robo-taxonomist";
 * export const describe = (result: CollectionMembershipResult) => Match.value(result).pipe(
 *   Match.tagsExhaustive({
 *     Yes: ({ quantifier }) => `The ${quantifier} question returned Yes.`,
 *     No: ({ quantifier }) => `The ${quantifier} question returned No.`,
 *     Undetermined: ({ quantifier }) => `The ${quantifier} question remains unresolved.`,
 *     MultipleTaxaInTargetName: ({ targetName }) =>
 *       `The target name ${targetName} describes several taxa. ` +
 *       "Replace it with separate TaxonSet.of expressions combined with TaxonSet.union, then retry.",
 *   }),
 * );
 */
export type CollectionMembershipResult = typeof collectionMembershipResultSchema.Type;

const yes = (quantifier: RecordQuantifier) =>
  collectionMembershipResultSchema.cases.Yes.make({ quantifier });
const no = (quantifier: RecordQuantifier) =>
  collectionMembershipResultSchema.cases.No.make({ quantifier });

const completedScanResult = (quantifier: RecordQuantifier): CollectionMembershipResult =>
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
): Effect.fn.Return<CollectionMembershipResult, AiError.AiError, DecisionModel.DecisionModel> {
  if (!Array.isReadonlyArrayNonEmpty(records)) return completedScanResult(quantifier);
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
  const batches = Iterable.filter(
    Iterable.chunksOf(input, execution.batchSize),
    Array.isArrayNonEmpty,
  );
  const windows = Iterable.chunksOf(batches, execution.concurrency);
  let encounteredUncertainty = false;

  for (const window of windows) {
    const resultsByBatch = yield* Effect.forEach(
      window,
      (batch) => decideMembershipBatch(batch, prepared, options),
      { concurrency: execution.concurrency },
    );
    for (const results of resultsByBatch) {
      for (const membership of results) {
        const decisive: Option.Option<CollectionMembershipResult> = Match.value(membership).pipe(
          Match.when({ _tag: "Member" }, () =>
            Match.value(quantifier).pipe(
              Match.when("all", () => Option.none<CollectionMembershipResult>()),
              Match.when("any", () => Option.some(yes(quantifier))),
              Match.when("none", () => Option.some(no(quantifier))),
              Match.exhaustive,
            ),
          ),
          Match.whenOr({ _tag: "NotMember" }, { _tag: "MixedMembership" }, () =>
            Match.value(quantifier).pipe(
              Match.when("all", () => Option.some(no(quantifier))),
              Match.when("any", () => Option.none<CollectionMembershipResult>()),
              Match.when("none", () => Option.none<CollectionMembershipResult>()),
              Match.exhaustive,
            ),
          ),
          Match.when({ _tag: "Undetermined" }, () => {
            encounteredUncertainty = true;
            return Option.none<CollectionMembershipResult>();
          }),
          Match.when({ _tag: "MultipleTaxaInTargetName" }, ({ targetName }) =>
            Option.some(
              collectionMembershipResultSchema.cases.MultipleTaxaInTargetName.make({
                quantifier,
                targetName,
              }),
            ),
          ),
          Match.exhaustive,
        );
        if (Option.isSome(decisive)) return decisive.value;
      }
    }
  }
  if (encounteredUncertainty)
    return collectionMembershipResultSchema.cases.Undetermined.make({ quantifier });
  return completedScanResult(quantifier);
});

type QuantifyRecordsFn = (
  records: readonly RecordInput[],
  target: MembershipTarget,
  options?: CollectionOptions,
) => Effect.Effect<CollectionMembershipResult, AiError.AiError, DecisionModel.DecisionModel>;

/**
 * Ask whether every complete record belongs to the target.
 * Return No for mixed membership and Yes for an empty collection.
 * Process bounded request windows until the answer is settled.
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
 * Return Yes after finding a Member record and No for an empty collection.
 * Require the current request window to succeed before selecting an answer.
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
 * Return Yes for an empty collection.
 * Send complete request windows, including records after the one that settles the answer.
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
