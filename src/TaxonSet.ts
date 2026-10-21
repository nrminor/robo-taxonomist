import * as AiError from "effect/ai/AiError";
import * as Decision from "effect/ai/Decision";
import * as DecisionModel from "effect/ai/DecisionModel";
import * as Array from "effect/Array";
import * as Effect from "effect/Effect";
import { pipe } from "effect/Function";
import * as Option from "effect/Option";
import * as Record from "effect/Record";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import { defaultPolicy, select, type AcceptancePolicy, type Scored } from "./AcceptancePolicy.ts";
import { TaxonName, taxonSetSchema } from "./schemas.ts";
import * as TaxonSetGraph from "./TaxonSetGraph.ts";
import * as TaxonRelations from "./TaxonRelations.ts";

/**
 * TaxonSet constructors return this type to describe a set of organisms.
 * Each value records how the set was built from names and set operations.
 * Syntax is preserved without automatic normalization or simplification.
 * You can use Match.tagsExhaustive to examine each expression.
 *
 * @category models
 * @since 0.1.0
 * @example
 * import { Match } from "effect";
 * import { TaxonSet } from "robo-taxonomist";
 * export const describe = (set: TaxonSet.TaxonSet) => Match.value(set).pipe(
 *   Match.tagsExhaustive({
 *     Empty: () => "The set is empty.",
 *     Taxon: ({ name }) => `The expression names ${name}.`,
 *     Union: ({ operands }) => `The union combines ${operands.length} expressions.`,
 *     Intersection: ({ operands }) => `The intersection combines ${operands.length} expressions.`,
 *     Difference: () => "The expression subtracts the right set from the left.",
 *   }),
 * );
 */
export type TaxonSet = typeof taxonSetSchema.Type;

/**
 * Build a fresh literal empty set.
 *
 * @category constructors
 * @since 0.1.0
 * @example
 * import { TaxonSet } from "robo-taxonomist";
 * export const none = TaxonSet.empty();
 */
export const empty = (): TaxonSet => taxonSetSchema.cases.Empty.make({});

/**
 * Build an expression for organisms belonging to the supplied taxon name.
 * To combine several taxa, build each expression separately and use TaxonSet.union.
 * The supplied name is preserved exactly, without normalization.
 *
 * @category constructors
 * @since 0.1.0
 * @example
 * import { TaxonName, TaxonSet } from "robo-taxonomist";
 * export const oaks = TaxonSet.of(TaxonName.make("Quercus"));
 */
export const of = (name: TaxonName): TaxonSet => taxonSetSchema.cases.Taxon.make({ name });

/**
 * Build a union expression for organisms in either input set.
 * Retain the original children in supplied order.
 * Child references and repeated occurrences are preserved, without simplification.
 *
 * @category constructors
 * @since 0.1.0
 * @example
 * import { TaxonName, TaxonSet } from "robo-taxonomist";
 * const oaks = TaxonSet.of(TaxonName.make("Quercus"));
 * const beeches = TaxonSet.of(TaxonName.make("Fagus"));
 * export const trees = TaxonSet.union(oaks, beeches);
 */
export const union = (left: TaxonSet, right: TaxonSet): TaxonSet =>
  taxonSetSchema.cases.Union.make({ operands: [left, right] });

/**
 * Build an intersection expression for organisms in both input sets.
 * Retain the original children in supplied order.
 * Child references and repeated occurrences are preserved, without simplification.
 *
 * @category constructors
 * @since 0.1.0
 * @example
 * import { TaxonName, TaxonSet } from "robo-taxonomist";
 * const oaks = TaxonSet.of(TaxonName.make("Quercus"));
 * const family = TaxonSet.of(TaxonName.make("Fagaceae"));
 * export const shared = TaxonSet.intersection(oaks, family);
 */
export const intersection = (left: TaxonSet, right: TaxonSet): TaxonSet =>
  taxonSetSchema.cases.Intersection.make({ operands: [left, right] });

/**
 * Build an expression for organisms in the left set that are outside the right set.
 * Child references and operand order are preserved, without simplification.
 *
 * @category constructors
 * @since 0.1.0
 * @example
 * import { TaxonName, TaxonSet } from "robo-taxonomist";
 * const family = TaxonSet.of(TaxonName.make("Fagaceae"));
 * const oaks = TaxonSet.of(TaxonName.make("Quercus"));
 * export const remaining = TaxonSet.difference(family, oaks);
 */
export const difference = (left: TaxonSet, right: TaxonSet): TaxonSet =>
  taxonSetSchema.cases.Difference.make({ left, right });

/**
 * Build an expression for organisms in exactly one input set using the two directed differences.
 * Each operand reference occurs in both differences; neither difference is simplified.
 *
 * @category constructors
 * @since 0.1.0
 * @example
 * import { TaxonName, TaxonSet } from "robo-taxonomist";
 * const oaks = TaxonSet.of(TaxonName.make("Quercus"));
 * const beeches = TaxonSet.of(TaxonName.make("Fagus"));
 * export const exclusive = TaxonSet.symmetricDifference(oaks, beeches);
 */
export const symmetricDifference = (left: TaxonSet, right: TaxonSet): TaxonSet =>
  union(difference(left, right), difference(right, left));

/**
 * Build universe minus set using the explicitly supplied universe.
 * Both original child references are retained, without simplification.
 *
 * @category constructors
 * @since 0.1.0
 * @example
 * import { TaxonName, TaxonSet } from "robo-taxonomist";
 * const oaks = TaxonSet.of(TaxonName.make("Quercus"));
 * const family = TaxonSet.of(TaxonName.make("Fagaceae"));
 * export const otherFamilyMembers = TaxonSet.complement(oaks, family);
 */
export const complement = (set: TaxonSet, universe: TaxonSet): TaxonSet =>
  difference(universe, set);

const setRelationSchema = Schema.Literals([
  "subset",
  "proper-subset",
  "equivalent",
  "overlap",
  "disjoint",
]);
const setRelationJudgmentSchema = Schema.TaggedUnion({
  Yes: { relation: setRelationSchema },
  No: { relation: setRelationSchema },
  Undetermined: { relation: setRelationSchema },
  MultipleTaxaInSetName: {
    relation: setRelationSchema,
    side: Schema.Literals(["left", "right"]),
    taxonName: TaxonName,
  },
});

/**
 * TaxonSet relation functions return this type to record a model judgment or literal-empty answer.
 * The relation field records which question they answered.
 * You can use Match.tagsExhaustive to handle the answer or locate a name requiring review.
 * Treat MultipleTaxaInSetName as the model's request to review a supplied name.
 * Its side and taxonName identify the exact supplied side and name, without normalization.
 * Review that name; if it combines taxa, replace it with a TaxonSet.union of separate
 * TaxonSet.of expressions, then retry.
 *
 * @category models
 * @since 0.1.0
 * @example
 * import { Match } from "effect";
 * import type { TaxonSetRelationJudgment } from "robo-taxonomist";
 * export const describe = (result: TaxonSetRelationJudgment) => Match.value(result).pipe(
 *   Match.tagsExhaustive({
 *     Yes: ({ relation }) => `Yes: ${relation}`, No: ({ relation }) => `No: ${relation}`,
 *     Undetermined: ({ relation }) => `Uncertain: ${relation}`,
 *     MultipleTaxaInSetName: ({ side, taxonName }) =>
 *       `The model flagged ${taxonName} in the ${side} set as combining taxa. ` +
 *       "Review it before replacing it with separate TaxonSet.of expressions combined with TaxonSet.union.",
 *   }),
 * );
 */
export type TaxonSetRelationJudgment = typeof setRelationJudgmentSchema.Type;

type JudgmentOptions = { readonly policy?: AcceptancePolicy };
// Fn aliases keep public calling contracts separate from traced implementations.
type SetRelationFn = (
  left: TaxonSet,
  right: TaxonSet,
  options?: JudgmentOptions,
) => Effect.Effect<TaxonSetRelationJudgment, AiError.AiError, DecisionModel.DecisionModel>;
const quoteText = Schema.encodeSync(Schema.fromJsonString(Schema.String));

const makeRelationQuestion = Effect.fnUntraced(function* (input: {
  readonly left: TaxonSet;
  readonly right: TaxonSet;
}) {
  const compiled = yield* TaxonSetGraph.compile(input).pipe(
    Effect.mapError((reason) =>
      AiError.make({
        module: "TaxonSet",
        method: "makeRelationQuestion",
        reason,
      }),
    ),
  );
  const names = {
    leftNames: compiled.names.left,
    rightNames: compiled.names.right,
  };
  const encoded = yield* Schema.encodeEffect(TaxonSetGraph.relationInputSchema)({
    nodes: compiled.nodes,
    ...compiled.roots,
  }).pipe(
    Effect.mapError((error) =>
      AiError.make({
        module: "TaxonSet",
        method: "makeRelationQuestion",
        reason: new AiError.InvalidUserInputError({ description: error.message }),
      }),
    ),
  );
  const leftNameChoices = Record.fromEntries(
    Array.map(
      names.leftNames,
      (name, index) =>
        [
          `multipleLeft${index}`,
          `The left-set name ${quoteText(name)} combines taxa and needs clarification.`,
        ] as const,
    ),
  );
  const rightNameChoices = Record.fromEntries(
    Array.map(
      names.rightNames,
      (name, index) =>
        [
          `multipleRight${index}`,
          `The right-set name ${quoteText(name)} combines taxa and needs clarification.`,
        ] as const,
    ),
  );
  const criteria = pipe(
    TaxonRelations.criteria,
    Struct.assign(leftNameChoices),
    Struct.assign(rightNameChoices),
  );
  return {
    input: encoded,
    names,
    definition: Decision.make({
      input: Schema.toEncoded(TaxonSetGraph.relationInputSchema),
      decisions: {
        relation: Decision.classify({
          instructions: `Compare the organisms in the complete left and right sets.\n${TaxonSetGraph.instructions} Roots are left and right.`,
          criteria,
        }),
      },
    }),
  };
});

type RelationAnswer = Decision.Answer<
  Effect.Success<ReturnType<typeof makeRelationQuestion>>["definition"]["decisions"]["relation"]
>;

const interpretRelation = (
  requestedRelation: typeof setRelationSchema.Type,
  answer: RelationAnswer,
  input: Effect.Success<ReturnType<typeof makeRelationQuestion>>["names"],
  policy: AcceptancePolicy,
): TaxonSetRelationJudgment => {
  const p = answer.probabilities;
  const support = TaxonRelations.predicateSupports[requestedRelation](p);
  const undetermined = setRelationJudgmentSchema.cases.Undetermined.make({
    relation: requestedRelation,
  });
  const candidates: Array.NonEmptyReadonlyArray<Scored<TaxonSetRelationJudgment>> = [
    {
      answer: setRelationJudgmentSchema.cases.Yes.make({ relation: requestedRelation }),
      support: support.yes,
    },
    {
      answer: setRelationJudgmentSchema.cases.No.make({ relation: requestedRelation }),
      support: support.no,
    },
    { answer: undetermined, support: p.undetermined },
  ];
  const withClarifications = pipe(
    candidates,
    Array.appendAll(
      Array.map(input.leftNames, (taxonName, index): Scored<TaxonSetRelationJudgment> => ({
        answer: setRelationJudgmentSchema.cases.MultipleTaxaInSetName.make({
          relation: requestedRelation,
          side: "left",
          taxonName,
        }),
        support: Record.get(p, `multipleLeft${index}`).pipe(Option.getOrThrow),
      })),
    ),
    Array.appendAll(
      Array.map(input.rightNames, (taxonName, index): Scored<TaxonSetRelationJudgment> => ({
        answer: setRelationJudgmentSchema.cases.MultipleTaxaInSetName.make({
          relation: requestedRelation,
          side: "right",
          taxonName,
        }),
        support: Record.get(p, `multipleRight${index}`).pipe(Option.getOrThrow),
      })),
    ),
  );
  return select(withClarifications, policy).pipe(Option.getOrElse(() => undetermined));
};

/**
 * Check whether every left-set organism belongs to the right set; equality counts.
 * The returned Effect answers Yes for a literal Empty on the left without consulting a model.
 * Other cases require a DecisionModel service and return a model judgment.
 *
 * @category relations
 * @since 0.1.0
 * @example
 * import { TaxonName, TaxonSet } from "robo-taxonomist";
 * export const subset = TaxonSet.isSubsetOf(TaxonSet.of(TaxonName.make("Quercus")), TaxonSet.of(TaxonName.make("Fagaceae")));
 */
export const isSubsetOf: SetRelationFn = Effect.fn("TaxonSet.isSubsetOf")(function* (
  left: TaxonSet,
  right: TaxonSet,
  options: JudgmentOptions = {},
) {
  if (taxonSetSchema.guards.Empty(left))
    return setRelationJudgmentSchema.cases.Yes.make({ relation: "subset" });
  const request = yield* makeRelationQuestion({ left, right });
  const { answers } = yield* DecisionModel.decide(request.definition, { input: request.input });
  return interpretRelation(
    "subset",
    answers.relation,
    request.names,
    options.policy ?? defaultPolicy,
  );
});

/**
 * Check whether every left-set organism belongs to the right set, but the sets are unequal.
 * The returned Effect answers No for a literal Empty on the right without consulting a model.
 * Other cases, including Empty on the left, require a DecisionModel service and return a model judgment.
 *
 * @category relations
 * @since 0.1.0
 * @example
 * import { TaxonName, TaxonSet } from "robo-taxonomist";
 * export const proper = TaxonSet.isProperSubsetOf(TaxonSet.empty(), TaxonSet.of(TaxonName.make("Quercus")));
 */
export const isProperSubsetOf: SetRelationFn = Effect.fn("TaxonSet.isProperSubsetOf")(function* (
  left: TaxonSet,
  right: TaxonSet,
  options: JudgmentOptions = {},
) {
  if (taxonSetSchema.guards.Empty(right))
    return setRelationJudgmentSchema.cases.No.make({ relation: "proper-subset" });
  const request = yield* makeRelationQuestion({ left, right });
  const { answers } = yield* DecisionModel.decide(request.definition, { input: request.input });
  return interpretRelation(
    "proper-subset",
    answers.relation,
    request.names,
    options.policy ?? defaultPolicy,
  );
});

/**
 * Check whether the two sets contain exactly the same organisms.
 * The returned Effect answers Yes for two literal Empty operands without consulting a model.
 * Other cases require a DecisionModel service and return a model judgment.
 *
 * @category relations
 * @since 0.1.0
 * @example
 * import { TaxonSet } from "robo-taxonomist";
 * export const equal = TaxonSet.equivalent(TaxonSet.empty(), TaxonSet.empty());
 */
export const equivalent: SetRelationFn = Effect.fn("TaxonSet.equivalent")(function* (
  left: TaxonSet,
  right: TaxonSet,
  options: JudgmentOptions = {},
) {
  if (taxonSetSchema.guards.Empty(left) && taxonSetSchema.guards.Empty(right))
    return setRelationJudgmentSchema.cases.Yes.make({ relation: "equivalent" });
  const request = yield* makeRelationQuestion({ left, right });
  const { answers } = yield* DecisionModel.decide(request.definition, { input: request.input });
  return interpretRelation(
    "equivalent",
    answers.relation,
    request.names,
    options.policy ?? defaultPolicy,
  );
});

/**
 * Check whether the complete sets share an organism.
 * The returned Effect answers No if either operand is a literal Empty without consulting a model.
 * Other cases require a DecisionModel service and return a model judgment.
 * Calls are judged independently, so answers across calls may differ.
 *
 * @category relations
 * @since 0.1.0
 * @example
 * import { TaxonName, TaxonSet } from "robo-taxonomist";
 * export const shared = TaxonSet.overlaps(TaxonSet.of(TaxonName.make("Quercus")), TaxonSet.of(TaxonName.make("Fagus")));
 */
export const overlaps: SetRelationFn = Effect.fn("TaxonSet.overlaps")(function* (
  left: TaxonSet,
  right: TaxonSet,
  options: JudgmentOptions = {},
) {
  if (taxonSetSchema.guards.Empty(left) || taxonSetSchema.guards.Empty(right))
    return setRelationJudgmentSchema.cases.No.make({ relation: "overlap" });
  const request = yield* makeRelationQuestion({ left, right });
  const { answers } = yield* DecisionModel.decide(request.definition, { input: request.input });
  return interpretRelation(
    "overlap",
    answers.relation,
    request.names,
    options.policy ?? defaultPolicy,
  );
});

/**
 * Check whether the complete sets have no organisms in common.
 * The returned Effect answers Yes if either operand is a literal Empty without consulting a model.
 * Other cases require a DecisionModel service and invert one overlap judgment,
 * retaining uncertainty and exact supplied-side and name diagnoses.
 *
 * @category relations
 * @since 0.1.0
 * @see {@link overlaps}
 * @example
 * import { TaxonName, TaxonSet } from "robo-taxonomist";
 * export const separate = TaxonSet.disjoint(TaxonSet.of(TaxonName.make("Quercus")), TaxonSet.of(TaxonName.make("Fagus")));
 */
export const disjoint: SetRelationFn = Effect.fn("TaxonSet.disjoint")(function* (
  left: TaxonSet,
  right: TaxonSet,
  options: JudgmentOptions = {},
) {
  return setRelationJudgmentSchema.match(yield* overlaps(left, right, options), {
    Yes: (): TaxonSetRelationJudgment =>
      setRelationJudgmentSchema.cases.No.make({ relation: "disjoint" }),
    No: (): TaxonSetRelationJudgment =>
      setRelationJudgmentSchema.cases.Yes.make({ relation: "disjoint" }),
    Undetermined: (): TaxonSetRelationJudgment =>
      setRelationJudgmentSchema.cases.Undetermined.make({ relation: "disjoint" }),
    MultipleTaxaInSetName: ({ side, taxonName }): TaxonSetRelationJudgment =>
      setRelationJudgmentSchema.cases.MultipleTaxaInSetName.make({
        relation: "disjoint",
        side,
        taxonName,
      }),
  });
});
