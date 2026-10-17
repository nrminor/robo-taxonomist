import { Array, Effect, Match, Number, Option, Record, Schema, Struct, pipe } from "effect";
import { AiError, Decision, DecisionModel } from "effect/ai";
import { JudgmentPolicy, TaxonName, taxonSetSchema } from "./schemas.ts";
import * as TaxonSetGraph from "./TaxonSetGraph.ts";

/**
 * TaxonSet constructors return this type to describe a set of organisms.
 * Each value records how the set was built from names and set operations.
 * You can use Match.tagsExhaustive to examine each expression.
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
 * @example
 * import { TaxonSet } from "robo-taxonomist";
 * export const none = TaxonSet.empty();
 */
export const empty = (): TaxonSet => taxonSetSchema.cases.Empty.make({});

/**
 * Build an expression for organisms belonging to the supplied taxon name.
 * To combine several taxa, build each expression separately and use TaxonSet.union.
 * @example
 * import { TaxonName, TaxonSet } from "robo-taxonomist";
 * export const oaks = TaxonSet.of(TaxonName.make("Quercus"));
 */
export const of = (name: TaxonName): TaxonSet => taxonSetSchema.cases.Taxon.make({ name });

/**
 * Build a fresh union parent, retaining the original children in supplied order.
 * @example
 * import { TaxonName, TaxonSet } from "robo-taxonomist";
 * export const trees = TaxonSet.union(TaxonSet.of(TaxonName.make("Quercus")), TaxonSet.empty());
 */
export const union = (left: TaxonSet, right: TaxonSet): TaxonSet =>
  taxonSetSchema.cases.Union.make({ operands: [left, right] });

/**
 * Build a fresh intersection parent, retaining the original children in supplied order.
 * @example
 * import { TaxonSet } from "robo-taxonomist";
 * export const shared = TaxonSet.intersection(TaxonSet.empty(), TaxonSet.empty());
 */
export const intersection = (left: TaxonSet, right: TaxonSet): TaxonSet =>
  taxonSetSchema.cases.Intersection.make({ operands: [left, right] });

/**
 * Build a fresh left-minus-right parent, retaining both original children.
 * @example
 * import { TaxonSet } from "robo-taxonomist";
 * export const remaining = TaxonSet.difference(TaxonSet.empty(), TaxonSet.empty());
 */
export const difference = (left: TaxonSet, right: TaxonSet): TaxonSet =>
  taxonSetSchema.cases.Difference.make({ left, right });

/**
 * Build a union of the two directed differences, retaining the original children in each.
 * @example
 * import { TaxonSet } from "robo-taxonomist";
 * export const exclusive = TaxonSet.symmetricDifference(TaxonSet.empty(), TaxonSet.empty());
 */
export const symmetricDifference = (left: TaxonSet, right: TaxonSet): TaxonSet =>
  union(difference(left, right), difference(right, left));

/**
 * Build universe minus set using the explicitly supplied universe.
 * @example
 * import { TaxonName, TaxonSet } from "robo-taxonomist";
 * export const others = TaxonSet.complement(TaxonSet.empty(), TaxonSet.of(TaxonName.make("Fagaceae")));
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
const setRelationResultSchema = Schema.TaggedUnion({
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
 * TaxonSet relation functions return this type to report their answer.
 * The relation field records which question they answered.
 * You can use Match.tagsExhaustive to handle the answer or locate a name requiring review.
 * For MultipleTaxaInSetName, replace the identified name on the indicated side
 * with a TaxonSet.union of separately constructed TaxonSet.of expressions, then retry.
 * @example
 * import { Match } from "effect";
 * import type { TaxonSetRelationResult } from "robo-taxonomist";
 * export const describe = (result: TaxonSetRelationResult) => Match.value(result).pipe(
 *   Match.tagsExhaustive({
 *     Yes: ({ relation }) => `Yes: ${relation}`, No: ({ relation }) => `No: ${relation}`,
 *     Undetermined: ({ relation }) => `Uncertain: ${relation}`,
 *     MultipleTaxaInSetName: ({ side, taxonName }) =>
 *       `The name ${taxonName} in the ${side} set describes several taxa. ` +
 *       "Replace it with separate TaxonSet.of expressions combined with TaxonSet.union, then retry.",
 *   }),
 * );
 */
export type TaxonSetRelationResult = typeof setRelationResultSchema.Type;

type JudgmentOptions = { readonly policy?: JudgmentPolicy };
// Fn aliases keep public calling contracts separate from traced implementations.
type SetRelationFn = (
  left: TaxonSet,
  right: TaxonSet,
  options?: JudgmentOptions,
) => Effect.Effect<TaxonSetRelationResult, AiError.AiError, DecisionModel.DecisionModel>;
const defaultJudgmentPolicy = JudgmentPolicy.make({ minimumSupport: 0.5, minimumMargin: 0 });
const quoteText = Schema.encodeSync(Schema.fromJsonString(Schema.String));
const relationQuestions = {
  subset: {
    instructions: "Is the complete left organism set a subset of the complete right organism set?",
    yes: "Every organism in the left set also belongs to the right set; equality counts.",
    no: "At least one organism in the left set does not belong to the right set.",
  },
  "proper-subset": {
    instructions:
      "Is the complete left organism set a proper subset of the complete right organism set?",
    yes: "Every organism in the left set belongs to the right set, and at least one organism in the right set is outside the left set.",
    no: "An organism in the left set is outside the right set, or the two sets contain exactly the same organisms.",
  },
  equivalent: {
    instructions: "Do the two complete sets contain exactly the same organisms?",
    yes: "The two sets contain exactly the same organisms.",
    no: "At least one organism belongs to one set but not the other.",
  },
  overlap: {
    instructions: "Do the two complete sets share any organisms?",
    yes: "At least one organism belongs to both sets.",
    no: "No organism belongs to both sets.",
  },
};

const makeRelationQuestion = Effect.fnUntraced(function* (
  relation: keyof typeof relationQuestions,
  input: { readonly left: TaxonSet; readonly right: TaxonSet },
) {
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
    leftNames: TaxonSetGraph.collectTaxonNames(compiled.nodes, compiled.roots.left),
    rightNames: TaxonSetGraph.collectTaxonNames(compiled.nodes, compiled.roots.right),
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
  const question = relationQuestions[relation];
  const relationshipChoices = {
    yes: question.yes,
    no: question.no,
    undetermined: "The available information is insufficient.",
  };
  const leftNameChoices = Record.fromEntries(
    Array.map(
      names.leftNames,
      (name, index) =>
        [
          `multipleLeft${index}`,
          `The left-set name ${quoteText(name)} jointly names distinct taxa, rather than one taxon. The caller needs to supply these taxa separately in an explicit union.`,
        ] as const,
    ),
  );
  const rightNameChoices = Record.fromEntries(
    Array.map(
      names.rightNames,
      (name, index) =>
        [
          `multipleRight${index}`,
          `The right-set name ${quoteText(name)} jointly names distinct taxa, rather than one taxon. The caller needs to supply these taxa separately in an explicit union.`,
        ] as const,
    ),
  );
  const criteria = pipe(
    relationshipChoices,
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
          instructions: `${question.instructions}\n${TaxonSetGraph.instructions} Roots are left and right.`,
          criteria,
        }),
      },
    }),
  };
});

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

const interpretRelation = (
  requestedRelation: typeof setRelationSchema.Type,
  answer: Decision.ClassifyAnswer<string>,
  input: Effect.Success<ReturnType<typeof makeRelationQuestion>>["names"],
  policy: JudgmentPolicy,
) => {
  if (!accepts(answer, policy))
    return setRelationResultSchema.cases.Undetermined.make({ relation: requestedRelation });
  return Match.value(answer.label).pipe(
    Match.when("yes", () =>
      setRelationResultSchema.cases.Yes.make({ relation: requestedRelation }),
    ),
    Match.when("no", () => setRelationResultSchema.cases.No.make({ relation: requestedRelation })),
    Match.orElse(() =>
      Array.findFirst(
        input.leftNames,
        (_name, index) => answer.label === `multipleLeft${index}`,
      ).pipe(
        Option.map((taxonName) =>
          setRelationResultSchema.cases.MultipleTaxaInSetName.make({
            relation: requestedRelation,
            side: "left",
            taxonName,
          }),
        ),
        Option.orElse(() =>
          Array.findFirst(
            input.rightNames,
            (_name, index) => answer.label === `multipleRight${index}`,
          ).pipe(
            Option.map((taxonName) =>
              setRelationResultSchema.cases.MultipleTaxaInSetName.make({
                relation: requestedRelation,
                side: "right",
                taxonName,
              }),
            ),
          ),
        ),
        Option.getOrThrow,
      ),
    ),
  );
};

/**
 * Check whether every left-set organism belongs to the right set; equality counts.
 * Return Yes immediately for a literal Empty on the left.
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
    return setRelationResultSchema.cases.Yes.make({ relation: "subset" });
  const request = yield* makeRelationQuestion("subset", { left, right });
  const { answers } = yield* DecisionModel.decide(request.definition, { input: request.input });
  return interpretRelation(
    "subset",
    answers.relation,
    request.names,
    options.policy ?? defaultJudgmentPolicy,
  );
});

/**
 * Check inclusion and unequal organism sets in one judgment.
 * Return No for a literal Empty on the right; judge other cases, including Empty on the left.
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
    return setRelationResultSchema.cases.No.make({ relation: "proper-subset" });
  const request = yield* makeRelationQuestion("proper-subset", { left, right });
  const { answers } = yield* DecisionModel.decide(request.definition, { input: request.input });
  return interpretRelation(
    "proper-subset",
    answers.relation,
    request.names,
    options.policy ?? defaultJudgmentPolicy,
  );
});

/**
 * Check whether the two sets contain exactly the same organisms.
 * Return Yes immediately for two literal Empty operands; judge all other cases.
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
    return setRelationResultSchema.cases.Yes.make({ relation: "equivalent" });
  const request = yield* makeRelationQuestion("equivalent", { left, right });
  const { answers } = yield* DecisionModel.decide(request.definition, { input: request.input });
  return interpretRelation(
    "equivalent",
    answers.relation,
    request.names,
    options.policy ?? defaultJudgmentPolicy,
  );
});

/**
 * Check whether the complete sets share an organism; either literal Empty answers No.
 * Judge each call independently, so answers across calls may differ.
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
    return setRelationResultSchema.cases.No.make({ relation: "overlap" });
  const request = yield* makeRelationQuestion("overlap", { left, right });
  const { answers } = yield* DecisionModel.decide(request.definition, { input: request.input });
  return interpretRelation(
    "overlap",
    answers.relation,
    request.names,
    options.policy ?? defaultJudgmentPolicy,
  );
});

/**
 * Map one overlap judgment to disjointness, retaining uncertainty and original-name diagnoses.
 * Return Yes immediately when either operand is a literal Empty.
 * @example
 * import { TaxonName, TaxonSet } from "robo-taxonomist";
 * export const separate = TaxonSet.disjoint(TaxonSet.of(TaxonName.make("Quercus")), TaxonSet.of(TaxonName.make("Fagus")));
 */
export const disjoint: SetRelationFn = Effect.fn("TaxonSet.disjoint")(function* (
  left: TaxonSet,
  right: TaxonSet,
  options: JudgmentOptions = {},
) {
  return setRelationResultSchema.match(yield* overlaps(left, right, options), {
    Yes: (): TaxonSetRelationResult =>
      setRelationResultSchema.cases.No.make({ relation: "disjoint" }),
    No: (): TaxonSetRelationResult =>
      setRelationResultSchema.cases.Yes.make({ relation: "disjoint" }),
    Undetermined: (): TaxonSetRelationResult =>
      setRelationResultSchema.cases.Undetermined.make({ relation: "disjoint" }),
    MultipleTaxaInSetName: ({ side, taxonName }): TaxonSetRelationResult =>
      setRelationResultSchema.cases.MultipleTaxaInSetName.make({
        relation: "disjoint",
        side,
        taxonName,
      }),
  });
});
