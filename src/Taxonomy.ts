import {
  Array,
  Effect,
  Equivalence,
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
  JudgmentPolicy,
  RankComparisonPolicy,
  RecordLabel,
  TaxonomicRecord,
  TaxonName,
  collectTaxonNames,
  taxonSetSchema,
} from "./schemas.ts";

/**
 * Compares original label text, not species or taxonomic identity.
 * Returns a plain boolean and needs no model service.
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
 * One of the eight supported ranks, from domain through species.
 * Strains, isolates, and clades are not additional ranks in this API.
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
 * A model judgment, uncertainty, or localized multiple-taxa diagnosis.
 * A diagnosis identifies an operand; it does not certify the other operand.
 * Match all four outcomes rather than treating undetermined as different.
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
 *       `The model reads ${side} as representing multiple taxa at ${rank} rank`,
 *   }),
 * );
 */
export type RankComparisonResult = typeof rankComparisonResultSchema.Type;

type RankComparisonEffect = Effect.Effect<
  RankComparisonResult,
  AiError.AiError,
  DecisionModel.DecisionModel
>;

type RecordOperand = RecordLabel | TaxonomicRecord;

type RankComparisonOptions = {
  readonly policy?: RankComparisonPolicy;
};

const defaultRankComparisonPolicy = RankComparisonPolicy.make({
  minimumSupport: 0.5,
  minimumMargin: 0,
});

const recordOperandSchema = Schema.Union([RecordLabel, TaxonomicRecord]);

const quoteText = Schema.encodeSync(Schema.fromJsonString(Schema.String));

const describeRecord = (record: typeof recordOperandSchema.Encoded): string => {
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
  left: recordOperandSchema,
  right: recordOperandSchema,
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
          `Left record:\n${describeRecord(left)}\n` +
          `Right record:\n${describeRecord(right)}`,
        criteria: {
          same: "Each record represents one taxon at the requested rank, and these taxa are the same, including resolved synonyms.",
          different:
            "Each record represents one taxon at the requested rank, and these taxa differ.",
          undetermined: "The available information is insufficient.",
          multipleLeft:
            "The left record jointly represents distinct taxa at the requested rank; this is not established for the right record.",
          multipleRight:
            "The right record jointly represents distinct taxa at the requested rank; this is not established for the left record.",
          multipleBoth: "Each record jointly represents distinct taxa at the requested rank.",
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
 * Asks your application's DecisionModel to compare records at a standard rank.
 * Quotes supplied record fields in the question; adapters receive null state.
 * Defaults to at least half the support and a unique leading selection.
 * Uncertainty and multiple-taxa diagnoses succeed; provider failures remain AiError.
 *
 * @example
 * import { RecordLabel, Taxonomy } from "robo-taxonomist";
 * export const comparison = Taxonomy.sameTaxonAtRank(
 *   RecordLabel.make("Voucher A17 | Quercus robur"),
 *   RecordLabel.make("Voucher B42 | Quercus petraea"),
 *   "genus",
 * );
 */
export const sameTaxonAtRank = Effect.fn("Taxonomy.sameTaxonAtRank")(function* (
  left: RecordOperand,
  right: RecordOperand,
  rank: TaxonomicRank,
  options: RankComparisonOptions = {},
): Effect.fn.Return<RankComparisonResult, AiError.AiError, DecisionModel.DecisionModel> {
  const encoded = yield* Schema.encodeEffect(rankComparisonInputSchema)({ left, right, rank }).pipe(
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
});

/**
 * Compares records at species rank using the shared rank operation and policy.
 * Provide your application's DecisionModel layer before running the Effect.
 *
 * @example
 * import { RecordLabel, Taxonomy } from "robo-taxonomist";
 * export const comparison = Taxonomy.sameSpecies(
 *   RecordLabel.make("Voucher A17 | Quercus robur"),
 *   RecordLabel.make("Voucher B42 | Quercus robur"),
 * );
 */
export const sameSpecies = (
  left: RecordOperand,
  right: RecordOperand,
  options: RankComparisonOptions = {},
): RankComparisonEffect => sameTaxonAtRank(left, right, "species", options);

/**
 * Compares records at domain rank with the same policy as sameTaxonAtRank.
 *
 * @example
 * import { RecordLabel, Taxonomy } from "robo-taxonomist";
 * export const comparison = Taxonomy.sameDomain(
 *   RecordLabel.make("Quercus robur"), RecordLabel.make("Quercus petraea"),
 * );
 */
export const sameDomain = (
  left: RecordOperand,
  right: RecordOperand,
  options: RankComparisonOptions = {},
): RankComparisonEffect => sameTaxonAtRank(left, right, "domain", options);

/**
 * Compares records at kingdom rank with the shared rank policy.
 *
 * @example
 * import { RecordLabel, Taxonomy } from "robo-taxonomist";
 * export const comparison = Taxonomy.sameKingdom(
 *   RecordLabel.make("Quercus robur"), RecordLabel.make("Quercus petraea"),
 * );
 */
export const sameKingdom = (
  left: RecordOperand,
  right: RecordOperand,
  options: RankComparisonOptions = {},
): RankComparisonEffect => sameTaxonAtRank(left, right, "kingdom", options);

/**
 * Compares records at phylum rank with the shared rank policy.
 *
 * @example
 * import { RecordLabel, Taxonomy } from "robo-taxonomist";
 * export const comparison = Taxonomy.samePhylum(
 *   RecordLabel.make("Quercus robur"), RecordLabel.make("Quercus petraea"),
 * );
 */
export const samePhylum = (
  left: RecordOperand,
  right: RecordOperand,
  options: RankComparisonOptions = {},
): RankComparisonEffect => sameTaxonAtRank(left, right, "phylum", options);

/**
 * Compares records at class rank with the shared rank policy.
 *
 * @example
 * import { RecordLabel, Taxonomy } from "robo-taxonomist";
 * export const comparison = Taxonomy.sameClass(
 *   RecordLabel.make("Quercus robur"), RecordLabel.make("Quercus petraea"),
 * );
 */
export const sameClass = (
  left: RecordOperand,
  right: RecordOperand,
  options: RankComparisonOptions = {},
): RankComparisonEffect => sameTaxonAtRank(left, right, "class", options);

/**
 * Compares records at order rank with the shared rank policy.
 *
 * @example
 * import { RecordLabel, Taxonomy } from "robo-taxonomist";
 * export const comparison = Taxonomy.sameOrder(
 *   RecordLabel.make("Quercus robur"), RecordLabel.make("Quercus petraea"),
 * );
 */
export const sameOrder = (
  left: RecordOperand,
  right: RecordOperand,
  options: RankComparisonOptions = {},
): RankComparisonEffect => sameTaxonAtRank(left, right, "order", options);

/**
 * Compares records at family rank with the shared rank policy.
 *
 * @example
 * import { RecordLabel, Taxonomy } from "robo-taxonomist";
 * export const comparison = Taxonomy.sameFamily(
 *   RecordLabel.make("Quercus robur"), RecordLabel.make("Quercus petraea"),
 * );
 */
export const sameFamily = (
  left: RecordOperand,
  right: RecordOperand,
  options: RankComparisonOptions = {},
): RankComparisonEffect => sameTaxonAtRank(left, right, "family", options);

/**
 * Compares records at genus rank with the shared rank policy.
 *
 * @example
 * import { RecordLabel, Taxonomy } from "robo-taxonomist";
 * export const comparison = Taxonomy.sameGenus(
 *   RecordLabel.make("Quercus robur"), RecordLabel.make("Quercus petraea"),
 * );
 */
export const sameGenus = (
  left: RecordOperand,
  right: RecordOperand,
  options: RankComparisonOptions = {},
): RankComparisonEffect => sameTaxonAtRank(left, right, "genus", options);

const identityResultSchema = Schema.TaggedUnion({
  SameTaxon: {},
  DifferentTaxa: {},
  MultipleTaxa: { side: Schema.Literals(["left", "right", "both"]) },
  Undetermined: {},
});

/**
 * Taxonomic grouping identity, uncertainty, or a localized joint-name diagnosis.
 * @example
 * import type { TaxonIdentityResult } from "robo-taxonomist";
 * export const tag = (result: TaxonIdentityResult) => result._tag;
 */
export type TaxonIdentityResult = typeof identityResultSchema.Type;

type JudgmentOptions = { readonly policy?: JudgmentPolicy };
const defaultJudgmentPolicy = JudgmentPolicy.make({ minimumSupport: 0.5, minimumMargin: 0 });

const accepts = (answer: Decision.ClassifyAnswer<string>, policy: JudgmentPolicy): boolean => {
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
          `Left taxon name: ${quoteText(input.left)}\n` +
          `Right taxon name: ${quoteText(input.right)}`,
        criteria: {
          same: "Both names refer to the same taxonomic grouping, including resolved synonyms.",
          different: "The names refer to distinct taxonomic groupings.",
          undetermined: "The available information is insufficient.",
          multipleLeft:
            "The left name is established to jointly name distinct taxa rather than one taxon; this is not established for the right name.",
          multipleRight:
            "The right name is established to jointly name distinct taxa rather than one taxon; this is not established for the left name.",
          multipleBoth:
            "Each name is established to jointly name distinct taxa rather than one taxon.",
        },
      }),
    },
  });

type IdentityAnswer = Decision.Answer<
  ReturnType<typeof makeIdentityQuestion>["decisions"]["identity"]
>;
const interpretIdentity = (answer: IdentityAnswer, policy: JudgmentPolicy): TaxonIdentityResult => {
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
 * Asks whether names describe the same taxonomic grouping, including resolved synonyms.
 * Even identical text needs one model judgment. Negative does not mean disjoint.
 * @example
 * import { TaxonName, Taxonomy } from "robo-taxonomist";
 * export const identity = Taxonomy.sameTaxon(TaxonName.make("Quercus"), TaxonName.make("Fagus"));
 */
export const sameTaxon = Effect.fn("Taxonomy.sameTaxon")(function* (
  left: TaxonName,
  right: TaxonName,
  options: JudgmentOptions = {},
): Effect.fn.Return<TaxonIdentityResult, AiError.AiError, DecisionModel.DecisionModel> {
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
 * Whole-taxon inclusion, uncertainty, or a joint-name diagnosis; left means inner.
 * @example
 * import type { TaxonContainmentResult } from "robo-taxonomist";
 * export const tag = (result: TaxonContainmentResult) => result._tag;
 */
export type TaxonContainmentResult = typeof containmentResultSchema.Type;

const makeContainmentQuestion = (input: typeof scalarInputSchema.Encoded) =>
  Decision.make({
    input: Schema.Null,
    decisions: {
      containment: Decision.classify({
        instructions:
          "Is the inner taxon contained in the outer taxon?\n" +
          `Left (inner) taxon name: ${quoteText(input.left)}\n` +
          `Right (outer) taxon name: ${quoteText(input.right)}`,
        criteria: {
          contained:
            "Every organism belonging to the inner taxon belongs to the outer taxon; equality counts.",
          notContained:
            "At least one organism belonging to the inner taxon is outside the outer taxon.",
          undetermined: "The available information is insufficient.",
          multipleLeft:
            "The inner name is established to jointly name distinct taxa rather than one taxon; this is not established for the outer name.",
          multipleRight:
            "The outer name is established to jointly name distinct taxa rather than one taxon; this is not established for the inner name.",
          multipleBoth:
            "Each name is established to jointly name distinct taxa rather than one taxon.",
        },
      }),
    },
  });

type ContainmentAnswer = Decision.Answer<
  ReturnType<typeof makeContainmentQuestion>["decisions"]["containment"]
>;
const interpretContainment = (
  answer: ContainmentAnswer,
  policy: JudgmentPolicy,
): TaxonContainmentResult => {
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
 * Asks whether every organism in inner belongs to outer; equality counts.
 * NotContained does not establish disjointness. Supply your application's DecisionModel.
 * @example
 * import { TaxonName, Taxonomy } from "robo-taxonomist";
 * export const inclusion = Taxonomy.taxonWithin(TaxonName.make("Quercus"), TaxonName.make("Fagaceae"));
 */
export const taxonWithin = Effect.fn("Taxonomy.taxonWithin")(function* (
  inner: TaxonName,
  outer: TaxonName,
  options: JudgmentOptions = {},
): Effect.fn.Return<TaxonContainmentResult, AiError.AiError, DecisionModel.DecisionModel> {
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
 * Whole-record membership, mixed/uncertain membership, or an original target-name diagnosis.
 * @example
 * import { Match } from "effect";
 * import type { TaxonMembershipResult } from "robo-taxonomist";
 * export const describe = (result: TaxonMembershipResult) => Match.value(result).pipe(
 *   Match.tagsExhaustive({
 *     Member: () => "Wholly inside", NotMember: () => "Wholly outside",
 *     MixedMembership: () => "Subjects both inside and outside",
 *     Undetermined: () => "Needs review",
 *     MultipleTaxaInTargetName: ({ targetName }) => `Review the target name ${targetName}`,
 *   }),
 * );
 */
export type TaxonMembershipResult = typeof membershipResultSchema.Type;

type MembershipJudgment = (
  record: RecordOperand,
  target: TaxonName | TaxonSet,
  options?: JudgmentOptions,
) => Effect.Effect<TaxonMembershipResult, AiError.AiError, DecisionModel.DecisionModel>;

const targetSchema = Schema.Union([TaxonName, taxonSetSchema]);
const batchRecordsSchema = Schema.NonEmptyArray(recordOperandSchema);
const membershipBatchInputSchema = Schema.Struct({
  records: batchRecordsSchema,
  target: targetSchema,
});
const targetNamesSchema = Schema.Array(TaxonName);

const makeMembershipBatchQuestion = Effect.fnUntraced(function* (
  records: typeof batchRecordsSchema.Type,
  target: typeof targetSchema.Type,
) {
  const encoded = yield* Schema.encodeEffect(membershipBatchInputSchema)({ records, target }).pipe(
    Effect.mapError((error) =>
      AiError.make({
        module: "Taxonomy",
        method: "makeMembershipBatchQuestion",
        reason: new AiError.InvalidUserInputError({ description: error.message }),
      }),
    ),
  );
  const targetNames = targetNamesSchema.make(
    Predicate.isString(target) ? [target] : collectTaxonNames(target),
  );
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
          `The name ${quoteText(name)} jointly names distinct taxa, rather than one taxon.`,
        ] as const,
    ),
  );
  const criteria = pipe(membershipChoices, Struct.assign(targetNameChoices));
  return {
    input: encoded.target,
    targetNames,
    definition: Decision.make({
      input: Schema.toEncoded(targetSchema),
      decisions: Record.fromEntries(
        Array.map(
          encoded.records,
          (record, index) =>
            [
              `record${index}`,
              Decision.classify({
                instructions:
                  "Classify this record's membership in the supplied taxon or taxon-set expression.\n" +
                  describeRecord(record),
                criteria,
              }),
            ] as const,
        ),
      ),
    }),
  };
});

const interpretMembership = (
  answer: Decision.ClassifyAnswer<string>,
  targetNames: typeof targetNamesSchema.Type,
  policy: JudgmentPolicy,
): TaxonMembershipResult => {
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
  target: typeof targetSchema.Type,
  options: JudgmentOptions = {},
) {
  const request = yield* makeMembershipBatchQuestion(records, target);
  const { answers } = yield* DecisionModel.decide(request.definition, { input: request.input });
  const policy = options.policy ?? defaultJudgmentPolicy;
  return Array.map(records, (_record, index) =>
    interpretMembership(
      Record.get(answers, `record${index}`).pipe(Option.getOrThrow),
      request.targetNames,
      policy,
    ),
  );
});

/**
 * Asks about every subject represented by one record against the complete target.
 * MixedMembership is established subjects on both sides, not mere plurality.
 * Literal Empty returns NotMember without a call; other targets use one classification.
 * @example
 * import { RecordLabel, TaxonName, Taxonomy } from "robo-taxonomist";
 * export const membership = Taxonomy.recordBelongsTo(RecordLabel.make("Quercus robur specimen"), TaxonName.make("Quercus"));
 */
export const recordBelongsTo: MembershipJudgment = Effect.fn("Taxonomy.recordBelongsTo")(function* (
  record: RecordOperand,
  target: TaxonName | TaxonSet,
  options: JudgmentOptions = {},
) {
  if (taxonSetSchema.guards.Empty(target)) return membershipResultSchema.cases.NotMember.make({});
  const results = yield* decideMembershipBatch([record], target, options);
  return Array.head(results).pipe(Option.getOrThrow);
});
