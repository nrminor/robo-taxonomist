import { Array, Effect, Equivalence, Match, Number, Predicate, Record, Schema, pipe } from "effect";
import { AiError, Decision, DecisionModel } from "effect/ai";
import { RankComparisonPolicy, RecordLabel, TaxonomicRecord } from "./schemas.ts";

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
