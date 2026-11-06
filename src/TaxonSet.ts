import * as Decision from "effect/ai/Decision";
import * as DecisionModel from "effect/ai/DecisionModel";
import * as Array from "effect/Array";
import * as Effect from "effect/Effect";
import { pipe } from "effect/Function";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Record from "effect/Record";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import type * as Types from "effect/Types";
import * as AcceptancePolicy from "./AcceptancePolicy.ts";
import * as Errors from "./errors.ts";
import {
  Difference,
  Intersection,
  Taxon,
  TaxonName,
  TaxonomyHint,
  Union,
  taxonSetSchema,
  type Expression,
  type TaxonomicRecord,
  type JudgmentOptions,
} from "./schemas.ts";
import * as TaxonSetGraph from "./TaxonSetGraph.ts";
import * as TaxonRelations from "./TaxonRelations.ts";
import * as Hints from "./TaxonomyHintContext.ts";

/**
 * Inspect the supplied record on a taxon entry returned by TaxonSet.of.
 *
 * @category models
 * @since 0.3.0
 */
export type { Taxon } from "./schemas.ts";

/**
 * TaxonSet constructors return this type to describe a set of organisms.
 * Each value records how the set was built from taxonomic records and set operations.
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
 *     Taxon: ({ record }) => `The expression identifies ${record.scientificName ?? record.label ?? record.taxonId?.id}.`,
 *     Union: ({ operands }) => `The union combines ${operands.length} expressions.`,
 *     Intersection: ({ operands }) => `The intersection combines ${operands.length} expressions.`,
 *     Difference: () => "The expression subtracts the right set from the left.",
 *   }),
 * );
 */
export type TaxonSet<R extends TaxonomicRecord = TaxonomicRecord> = Expression<R>;

/**
 * Build a fresh literal empty set.
 *
 * @category constructors
 * @since 0.1.0
 * @example
 * import { TaxonSet } from "robo-taxonomist";
 * export const none = TaxonSet.empty();
 */
export const empty = (): TaxonSet<never> => taxonSetSchema.cases.Empty.make({});

/**
 * Build an expression for organisms belonging to the taxon identified by a name or record.
 * To combine several taxa, build each expression separately and use TaxonSet.unionAll.
 * Preserve the supplied record and its identifying fields without normalization.
 *
 * @category constructors
 * @since 0.1.0
 * @example
 * import { TaxonName, TaxonSet } from "robo-taxonomist";
 * export const oaks = TaxonSet.of(TaxonName.make("Quercus"));
 */
export function of(name: TaxonName): Taxon<{ readonly scientificName: TaxonName }>;
export function of<R extends TaxonomicRecord>(record: R): Taxon<R>;
export function of(input: TaxonName | TaxonomicRecord): Taxon {
  return new Taxon({ record: Predicate.isString(input) ? { scientificName: input } : input });
}

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
export const union = <A extends TaxonomicRecord, B extends TaxonomicRecord>(
  left: TaxonSet<A>,
  right: TaxonSet<B>,
): TaxonSet<A | B> => new Union<A | B>({ operands: [left, right] });

type RecordOfSet<S> = S extends TaxonSet<never> ? never : S extends TaxonSet<infer R> ? R : never;

/**
 * Build a union from a finite iterable of set expressions without nesting a binary union per item.
 * An empty iterable produces a fresh empty set; a singleton returns its original expression.
 * Otherwise, create one union with the supplied expressions as its direct children.
 * Consume the iterable eagerly once and copy its operand container, retaining child references,
 * supplied order, repeated occurrences, metadata and nesting without simplification.
 * Records and child expressions are shared, not cloned or frozen.
 *
 * @category constructors
 * @since 0.4.0
 * @example
 * import { TaxonName, TaxonSet } from "robo-taxonomist";
 * const targets = ["Quercus", "Fagus", "Betula"].map((name) =>
 *   TaxonSet.of(TaxonName.make(name)),
 * );
 * export const trees = TaxonSet.unionAll(targets);
 */
export function unionAll<S extends TaxonSet>(sets: Iterable<S>): TaxonSet<RecordOfSet<S>>;
export function unionAll(sets: Iterable<TaxonSet>): TaxonSet {
  const operands = [...sets];
  if (!Array.isArrayNonEmpty(operands)) return empty();
  if (operands.length === 1) return operands[0];
  return new Union({ operands });
}

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
export const intersection = <A extends TaxonomicRecord, B extends TaxonomicRecord>(
  left: TaxonSet<A>,
  right: TaxonSet<B>,
): TaxonSet<A | B> => new Intersection<A | B>({ operands: [left, right] });

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
export const difference = <A extends TaxonomicRecord, B extends TaxonomicRecord>(
  left: TaxonSet<A>,
  right: TaxonSet<B>,
): TaxonSet<A | B> => new Difference<A | B>({ left, right });

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
export const symmetricDifference = <A extends TaxonomicRecord, B extends TaxonomicRecord>(
  left: TaxonSet<A>,
  right: TaxonSet<B>,
): TaxonSet<A | B> => union(difference(left, right), difference(right, left));

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
export const complement = <A extends TaxonomicRecord, B extends TaxonomicRecord>(
  set: TaxonSet<A>,
  universe: TaxonSet<B>,
): TaxonSet<A | B> => difference(universe, set);

/** The set relation requested by a predicate question.
 * @category schemas
 */
export const TaxonSetRelation = TaxonRelations.Relation;

/** Describe a set relation judgment and any taxon requiring clarification.
 * @category schemas
 */
export const TaxonSetRelationJudgment = Schema.TaggedUnion({
  Yes: { relation: TaxonRelations.Relation },
  No: { relation: TaxonRelations.Relation },
  Undetermined: { relation: TaxonRelations.Relation },
  MultipleTaxaInSet: {
    relation: TaxonRelations.Relation,
    side: Schema.Literals(["left", "right"]),
    taxon: Taxon,
  },
});

/**
 * TaxonSet relation functions return this type to record a model judgment or literal-empty answer.
 * The relation field records which question they answered.
 * You can use Match.tagsExhaustive to handle the answer or locate an entry requiring review.
 * Treat MultipleTaxaInSet as the model's request to review a supplied taxon entry.
 * Its side and taxon identify the original supplied side and entry.
 * Review that entry; if it combines taxa, replace it with a TaxonSet.union of separate
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
 *     MultipleTaxaInSet: ({ side }) =>
 *       `The model flagged an entry in the ${side} set as combining taxa. ` +
 *       "Review it before replacing it with separate TaxonSet.of expressions combined with TaxonSet.union.",
 *   }),
 * );
 */
export type TaxonSetRelationJudgment<R extends TaxonomicRecord = TaxonomicRecord> =
  | Types.ExcludeTag<typeof TaxonSetRelationJudgment.Type, "MultipleTaxaInSet">
  | (Types.ExtractTag<typeof TaxonSetRelationJudgment.Type, "MultipleTaxaInSet"> & {
      readonly taxon: Taxon<R>;
    });

// Fn aliases keep public calling contracts separate from traced implementations.
type SetRelationFn = <A extends TaxonomicRecord, B extends TaxonomicRecord>(
  left: TaxonSet<A>,
  right: TaxonSet<B>,
  options?: JudgmentOptions,
) => Effect.Effect<
  TaxonSetRelationJudgment<A | B>,
  Errors.TaxonomyError,
  DecisionModel.DecisionModel
>;

const makeRelationQuestion = Effect.fnUntraced(function* <R extends TaxonomicRecord>(
  input: {
    readonly left: TaxonSet<R>;
    readonly right: TaxonSet<R>;
  },
  hints: ReadonlyArray<TaxonomyHint>,
) {
  const compiled = yield* TaxonSetGraph.compile(input);
  const taxa = {
    leftTaxa: compiled.taxa.left,
    rightTaxa: compiled.taxa.right,
  };
  const graphInput = {
    nodes: compiled.nodes,
    ...compiled.roots,
  };
  const inputWithHints = Array.match(hints, {
    onEmpty: () => graphInput,
    onNonEmpty: (nonempty) =>
      Struct.assign(graphInput, {
        hints: nonempty,
        instructions: "Use the supplied taxonomic hints as background.",
      }),
  });
  const encoded = yield* Schema.encodeEffect(TaxonSetGraph.relationInputSchema)(
    inputWithHints,
  ).pipe(Effect.mapError(Errors.InvalidInput.from));
  const leftTaxonChoices = Record.fromEntries(
    Array.map(
      taxa.leftTaxa,
      (taxon, index) =>
        [
          `multipleLeft${index}`,
          `Left taxon node ${Option.getOrThrow(Option.fromUndefinedOr(compiled.nodeIds.get(taxon)))} identifies multiple entities and needs clarification.`,
        ] as const,
    ),
  );
  const rightTaxonChoices = Record.fromEntries(
    Array.map(
      taxa.rightTaxa,
      (taxon, index) =>
        [
          `multipleRight${index}`,
          `Right taxon node ${Option.getOrThrow(Option.fromUndefinedOr(compiled.nodeIds.get(taxon)))} identifies multiple entities and needs clarification.`,
        ] as const,
    ),
  );
  const criteria = pipe(
    TaxonRelations.criteria,
    Struct.assign(leftTaxonChoices),
    Struct.assign(rightTaxonChoices),
  );
  return {
    input: encoded,
    taxa,
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

const interpretRelation = <R extends TaxonomicRecord>(
  requestedRelation: TaxonRelations.Relation,
  answer: RelationAnswer,
  input: { readonly leftTaxa: readonly Taxon<R>[]; readonly rightTaxa: readonly Taxon<R>[] },
  policy: AcceptancePolicy.AcceptancePolicy,
): TaxonSetRelationJudgment<R> => {
  const p = answer.probabilities;
  const support = TaxonRelations.predicateSupports(requestedRelation, p);
  const undetermined = TaxonSetRelationJudgment.cases.Undetermined.make({
    relation: requestedRelation,
  });
  const candidates = Array.make(
    {
      answer: TaxonSetRelationJudgment.cases.Yes.make({ relation: requestedRelation }),
      support: support.yes,
    },
    {
      answer: TaxonSetRelationJudgment.cases.No.make({ relation: requestedRelation }),
      support: support.no,
    },
    { answer: undetermined, support: p.undetermined },
  );
  const leftClarifications = Array.map(input.leftTaxa, (taxon, index) => {
    const judgment = TaxonSetRelationJudgment.cases.MultipleTaxaInSet.make({
      relation: requestedRelation,
      side: "left",
      taxon,
    });
    const answer = Struct.assign(judgment, { taxon });
    const support = Record.get(p, `multipleLeft${index}`).pipe(Option.getOrThrow);
    return { answer, support };
  });
  const rightClarifications = Array.map(input.rightTaxa, (taxon, index) => {
    const judgment = TaxonSetRelationJudgment.cases.MultipleTaxaInSet.make({
      relation: requestedRelation,
      side: "right",
      taxon,
    });
    const answer = Struct.assign(judgment, { taxon });
    const support = Record.get(p, `multipleRight${index}`).pipe(Option.getOrThrow);
    return { answer, support };
  });
  const candidatesWithClarifications = pipe(
    candidates,
    Array.appendAll(leftClarifications),
    Array.appendAll(rightClarifications),
  );
  return AcceptancePolicy.select<TaxonSetRelationJudgment<R>>(
    candidatesWithClarifications,
    policy,
  ).pipe(Option.getOrElse(() => undetermined));
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
export const isSubsetOf: SetRelationFn = Effect.fn("TaxonSet.isSubsetOf")(function* <
  A extends TaxonomicRecord,
  B extends TaxonomicRecord,
>(left: TaxonSet<A>, right: TaxonSet<B>, options: JudgmentOptions = {}) {
  if (taxonSetSchema.guards.Empty(left))
    return TaxonSetRelationJudgment.cases.Yes.make({ relation: "subset" });
  const hints = yield* Hints.snapshot(options.hints);
  const request = yield* makeRelationQuestion<A | B>({ left, right }, hints);
  const { answers } = yield* DecisionModel.decide(request.definition, { input: request.input });
  return interpretRelation(
    "subset",
    answers.relation,
    request.taxa,
    options.policy ?? AcceptancePolicy.defaultPolicy,
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
export const isProperSubsetOf: SetRelationFn = Effect.fn("TaxonSet.isProperSubsetOf")(function* <
  A extends TaxonomicRecord,
  B extends TaxonomicRecord,
>(left: TaxonSet<A>, right: TaxonSet<B>, options: JudgmentOptions = {}) {
  if (taxonSetSchema.guards.Empty(right))
    return TaxonSetRelationJudgment.cases.No.make({ relation: "proper-subset" });
  const hints = yield* Hints.snapshot(options.hints);
  const request = yield* makeRelationQuestion<A | B>({ left, right }, hints);
  const { answers } = yield* DecisionModel.decide(request.definition, { input: request.input });
  return interpretRelation(
    "proper-subset",
    answers.relation,
    request.taxa,
    options.policy ?? AcceptancePolicy.defaultPolicy,
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
export const equivalent: SetRelationFn = Effect.fn("TaxonSet.equivalent")(function* <
  A extends TaxonomicRecord,
  B extends TaxonomicRecord,
>(left: TaxonSet<A>, right: TaxonSet<B>, options: JudgmentOptions = {}) {
  if (taxonSetSchema.guards.Empty(left) && taxonSetSchema.guards.Empty(right))
    return TaxonSetRelationJudgment.cases.Yes.make({ relation: "equivalent" });
  const hints = yield* Hints.snapshot(options.hints);
  const request = yield* makeRelationQuestion<A | B>({ left, right }, hints);
  const { answers } = yield* DecisionModel.decide(request.definition, { input: request.input });
  return interpretRelation(
    "equivalent",
    answers.relation,
    request.taxa,
    options.policy ?? AcceptancePolicy.defaultPolicy,
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
export const overlaps: SetRelationFn = Effect.fn("TaxonSet.overlaps")(function* <
  A extends TaxonomicRecord,
  B extends TaxonomicRecord,
>(left: TaxonSet<A>, right: TaxonSet<B>, options: JudgmentOptions = {}) {
  if (taxonSetSchema.guards.Empty(left) || taxonSetSchema.guards.Empty(right))
    return TaxonSetRelationJudgment.cases.No.make({ relation: "overlap" });
  const hints = yield* Hints.snapshot(options.hints);
  const request = yield* makeRelationQuestion<A | B>({ left, right }, hints);
  const { answers } = yield* DecisionModel.decide(request.definition, { input: request.input });
  return interpretRelation(
    "overlap",
    answers.relation,
    request.taxa,
    options.policy ?? AcceptancePolicy.defaultPolicy,
  );
});

/**
 * Check whether the complete sets have no organisms in common.
 * The returned Effect answers Yes if either operand is a literal Empty without consulting a model.
 * Other cases require a DecisionModel service and invert one overlap judgment,
 * retaining uncertainty and the original supplied-side and taxon diagnoses.
 *
 * @category relations
 * @since 0.1.0
 * @see {@link overlaps}
 * @example
 * import { TaxonName, TaxonSet } from "robo-taxonomist";
 * export const separate = TaxonSet.disjoint(TaxonSet.of(TaxonName.make("Quercus")), TaxonSet.of(TaxonName.make("Fagus")));
 */
export const disjoint: SetRelationFn = Effect.fn("TaxonSet.disjoint")(function* <
  A extends TaxonomicRecord,
  B extends TaxonomicRecord,
>(left: TaxonSet<A>, right: TaxonSet<B>, options: JudgmentOptions = {}) {
  const result = yield* overlaps(left, right, options);
  return Match.value(result).pipe(
    Match.tagsExhaustive({
      Yes: () => TaxonSetRelationJudgment.cases.No.make({ relation: "disjoint" }),
      No: () => TaxonSetRelationJudgment.cases.Yes.make({ relation: "disjoint" }),
      Undetermined: () =>
        TaxonSetRelationJudgment.cases.Undetermined.make({ relation: "disjoint" }),
      MultipleTaxaInSet: ({ side, taxon }) =>
        Struct.assign(
          TaxonSetRelationJudgment.cases.MultipleTaxaInSet.make({
            relation: "disjoint",
            side,
            taxon,
          }),
          { taxon },
        ),
    }),
  );
});
