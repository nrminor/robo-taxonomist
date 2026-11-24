import * as Decision from "effect/ai/Decision";
import * as DecisionModel from "effect/ai/DecisionModel";
import * as Effect from "effect/Effect";
import * as Function from "effect/Function";
import * as Match from "effect/Match";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import * as AcceptancePolicy from "../AcceptancePolicy.ts";
import * as Errors from "../errors.ts";
import { TaxonomicRecord, TaxonName, TaxonomyHint, type JudgmentOptions } from "../schemas.ts";
import * as TaxonRelations from "../TaxonRelations.ts";
import * as TaxonomyHints from "../TaxonomyHints.ts";
import { asTaxonomicRecord, describeRecord, hintsInstruction } from "./RecordInput.ts";

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

const makeIdentityQuestion = (
  input: typeof scalarInputSchema.Encoded,
  hints: ReadonlyArray<TaxonomyHint>,
) =>
  Decision.make({
    input: Schema.Null,
    decisions: {
      identity: Decision.classify({
        instructions:
          "Do these records identify the same taxon? Interpret all supplied identifying fields together.\n" +
          "Include resolved synonyms. Flag a combined assignment only when it prevents comparison. " +
          "Choose multipleBoth when both records need clarification.\n" +
          `Left taxon:\n${describeRecord(input.left)}\n` +
          `Right taxon:\n${describeRecord(input.right)}` +
          hintsInstruction(hints),
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

const interpretIdentity = Match.fn(
  (answer: IdentityAnswer, _policy: AcceptancePolicy.AcceptancePolicy) => answer,
).pipe(
  Match.when({ label: "same" }, ({ probabilities: p }, _answer, policy) => {
    const support = p.same;

    const competitorSupport = Math.max(
      p.different,
      p.undetermined,
      p.multipleLeft,
      p.multipleRight,
      p.multipleBoth,
    );

    return AcceptancePolicy.accepts(support, competitorSupport, policy)
      ? TaxonIdentityJudgment.cases.SameTaxon.make({})
      : TaxonIdentityJudgment.cases.Undetermined.make({});
  }),
  Match.when({ label: "different" }, ({ probabilities: p }, _answer, policy) => {
    const support = p.different;

    const competitorSupport = Math.max(
      p.same,
      p.undetermined,
      p.multipleLeft,
      p.multipleRight,
      p.multipleBoth,
    );

    return AcceptancePolicy.accepts(support, competitorSupport, policy)
      ? TaxonIdentityJudgment.cases.DifferentTaxa.make({})
      : TaxonIdentityJudgment.cases.Undetermined.make({});
  }),
  Match.when({ label: "multipleLeft" }, ({ probabilities: p }, _answer, policy) => {
    const support = p.multipleLeft;

    const competitorSupport = Math.max(
      p.same,
      p.different,
      p.undetermined,
      p.multipleRight,
      p.multipleBoth,
    );

    return AcceptancePolicy.accepts(support, competitorSupport, policy)
      ? TaxonIdentityJudgment.cases.MultipleTaxa.make({ side: "left" })
      : TaxonIdentityJudgment.cases.Undetermined.make({});
  }),
  Match.when({ label: "multipleRight" }, ({ probabilities: p }, _answer, policy) => {
    const support = p.multipleRight;

    const competitorSupport = Math.max(
      p.same,
      p.different,
      p.undetermined,
      p.multipleLeft,
      p.multipleBoth,
    );

    return AcceptancePolicy.accepts(support, competitorSupport, policy)
      ? TaxonIdentityJudgment.cases.MultipleTaxa.make({ side: "right" })
      : TaxonIdentityJudgment.cases.Undetermined.make({});
  }),
  Match.when({ label: "multipleBoth" }, ({ probabilities: p }, _answer, policy) => {
    const support = p.multipleBoth;

    const competitorSupport = Math.max(
      p.same,
      p.different,
      p.undetermined,
      p.multipleLeft,
      p.multipleRight,
    );

    return AcceptancePolicy.accepts(support, competitorSupport, policy)
      ? TaxonIdentityJudgment.cases.MultipleTaxa.make({ side: "both" })
      : TaxonIdentityJudgment.cases.Undetermined.make({});
  }),
  Match.when({ label: "undetermined" }, () => TaxonIdentityJudgment.cases.Undetermined.make({})),
  Match.exhaustive,
);

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
  const hints = yield* TaxonomyHints.snapshot(options.hints);

  const encoded = yield* Schema.encodeEffect(scalarInputSchema)({
    left: asTaxonomicRecord(left),
    right: asTaxonomicRecord(right),
  }).pipe(Effect.mapError(Errors.InvalidInput.from));

  const { answers } = yield* DecisionModel.decide(makeIdentityQuestion(encoded, hints), {
    input: null,
  });

  return interpretIdentity(answers.identity, options.policy ?? AcceptancePolicy.defaultPolicy);
});

/** Construct or validate a taxon containment judgment.
 * @category schemas
 */
export const TaxonContainmentJudgment = Schema.TaggedUnion({
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
export type TaxonContainmentJudgment = typeof TaxonContainmentJudgment.Type;

type TaxonWithinFn = (
  inner: TaxonName | TaxonomicRecord,
  outer: TaxonName | TaxonomicRecord,
  options?: JudgmentOptions,
) => Effect.Effect<TaxonContainmentJudgment, Errors.TaxonomyError, DecisionModel.DecisionModel>;

const makeContainmentQuestion = (
  input: typeof scalarInputSchema.Encoded,
  hints: ReadonlyArray<TaxonomyHint>,
) =>
  Decision.make({
    input: Schema.Null,
    decisions: {
      containment: Decision.classify({
        instructions:
          "Compare the organisms represented by inner and outer. Interpret all supplied identifying fields and clear combinations together. " +
          "Flag a combined assignment only when it prevents comparison; choose multipleBoth when both records need clarification.\n" +
          `Left (inner) taxon:\n${describeRecord(input.left)}\n` +
          `Right (outer) taxon:\n${describeRecord(input.right)}` +
          hintsInstruction(hints),
        criteria: Function.pipe(
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
  policy: AcceptancePolicy.AcceptancePolicy,
): TaxonContainmentJudgment => {
  const p = answer.probabilities;
  const support = TaxonRelations.containmentSupports(p);
  const judgments = TaxonContainmentJudgment.cases;

  const unresolvedSupport = Math.max(
    p.undetermined,
    p.multipleLeft,
    p.multipleRight,
    p.multipleBoth,
  );

  if (
    AcceptancePolicy.accepts(
      support.contained,
      Math.max(support.notContained, unresolvedSupport),
      policy,
    )
  ) {
    return judgments.Contained.make({});
  }

  if (
    AcceptancePolicy.accepts(
      support.notContained,
      Math.max(support.contained, unresolvedSupport),
      policy,
    )
  ) {
    // Contained remains a competitor when refining the accepted NotContained answer.
    const containedOrUnresolvedSupport = Math.max(support.contained, unresolvedSupport);

    if (
      AcceptancePolicy.accepts(
        support.partlyContained,
        Math.max(support.disjoint, containedOrUnresolvedSupport),
        policy,
      )
    ) {
      return judgments.PartlyContained.make({});
    }

    if (
      AcceptancePolicy.accepts(
        support.disjoint,
        Math.max(support.partlyContained, containedOrUnresolvedSupport),
        policy,
      )
    ) {
      return judgments.Disjoint.make({});
    }

    return judgments.NotContained.make({});
  }

  const otherBroadSupport = Math.max(support.contained, support.notContained, p.undetermined);

  if (
    AcceptancePolicy.accepts(
      p.multipleLeft,
      Math.max(p.multipleRight, p.multipleBoth, otherBroadSupport),
      policy,
    )
  ) {
    return judgments.MultipleTaxa.make({ side: "left" });
  }

  if (
    AcceptancePolicy.accepts(
      p.multipleRight,
      Math.max(p.multipleLeft, p.multipleBoth, otherBroadSupport),
      policy,
    )
  ) {
    return judgments.MultipleTaxa.make({ side: "right" });
  }

  if (
    AcceptancePolicy.accepts(
      p.multipleBoth,
      Math.max(p.multipleLeft, p.multipleRight, otherBroadSupport),
      policy,
    )
  ) {
    return judgments.MultipleTaxa.make({ side: "both" });
  }

  return judgments.Undetermined.make({});
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
  const hints = yield* TaxonomyHints.snapshot(options.hints);

  const encoded = yield* Schema.encodeEffect(scalarInputSchema)({
    left: asTaxonomicRecord(inner),
    right: asTaxonomicRecord(outer),
  }).pipe(Effect.mapError(Errors.InvalidInput.from));

  const { answers } = yield* DecisionModel.decide(makeContainmentQuestion(encoded, hints), {
    input: null,
  });

  return interpretContainment(
    answers.containment,
    options.policy ?? AcceptancePolicy.defaultPolicy,
  );
});
