import * as DecisionModel from "effect/ai/DecisionModel";
import * as Array from "effect/Array";
import * as Effect from "effect/Effect";
import * as Iterable from "effect/Iterable";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Record from "effect/Record";
import * as Schema from "effect/Schema";
import * as AcceptancePolicy from "../AcceptancePolicy.ts";
import type { TaxonSet } from "../TaxonSet.ts";
import * as Errors from "../errors.ts";
import {
  TaxonomicRecord,
  TaxonName,
  Taxon,
  taxonSetSchema,
  type CollectionOptions,
} from "../schemas.ts";
import * as TaxonomyHints from "../TaxonomyHints.ts";
import { defaultCollectionExecution, type RecordInput } from "./RecordInput.ts";
import {
  type WithTarget,
  type MembershipAnswer,
  type MembershipTarget,
  prepareMembershipTarget,
  decideMembershipBatch,
} from "./Membership.ts";

type Named = { readonly scientificName: TaxonName };

const quantifierSchema = Schema.Literals(["all", "any", "none"]);

type RecordQuantifier = typeof quantifierSchema.Type;

/** Describe a collection membership judgment and any target requiring clarification.
 * @category schemas
 */
export const CollectionMembershipJudgment = Schema.TaggedUnion({
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
  typeof CollectionMembershipJudgment.Type,
  T
>;

const yes = (quantifier: RecordQuantifier) =>
  CollectionMembershipJudgment.cases.Yes.make({ quantifier });

const no = (quantifier: RecordQuantifier) =>
  CollectionMembershipJudgment.cases.No.make({ quantifier });

const completedScanJudgment = (quantifier: RecordQuantifier) =>
  Match.value(quantifier).pipe(
    Match.when("all", () => yes(quantifier)),
    Match.when("any", () => no(quantifier)),
    Match.when("none", () => yes(quantifier)),
    Match.exhaustive,
  );

const interpretQuantifierAnswer = <T extends TaxonomicRecord>(
  quantifier: RecordQuantifier,
  answer: MembershipAnswer,
  targetTaxa: readonly Taxon<T>[],
  policy: AcceptancePolicy.AcceptancePolicy,
): Option.Option<CollectionMembershipJudgment<T>> => {
  const p = answer.probabilities;
  const notWhollyMemberSupport = AcceptancePolicy.sumProbabilities([p.notMember, p.mixed]);
  let clarificationTarget: Taxon<T> | undefined;
  let clarificationSupport = 0;
  let clarificationCompetitorSupport = Math.max(p.member, notWhollyMemberSupport, p.undetermined);

  for (let index = 0; index < targetTaxa.length; index++) {
    const label = `multipleTarget${index}` as const;
    const support = Record.get(p, label).pipe(Option.getOrThrow);

    if (support > clarificationSupport) {
      clarificationCompetitorSupport = Math.max(
        clarificationCompetitorSupport,
        clarificationSupport,
      );
      clarificationSupport = support;
      clarificationTarget = Array.getUnsafe(targetTaxa, index);
    } else {
      clarificationCompetitorSupport = Math.max(clarificationCompetitorSupport, support);
    }
  }

  const memberCompetitorSupport = Math.max(
    notWhollyMemberSupport,
    p.undetermined,
    clarificationSupport,
  );

  const memberAccepted = AcceptancePolicy.accepts(p.member, memberCompetitorSupport, policy);

  if (memberAccepted) {
    return Match.value(quantifier).pipe(
      Match.when("all", () => Option.none()),
      Match.when("any", () => Option.some(yes(quantifier))),
      Match.when("none", () => Option.some(no(quantifier))),
      Match.exhaustive,
    );
  }

  const notWhollyMemberCompetitorSupport = Math.max(p.member, p.undetermined, clarificationSupport);

  const notWhollyMemberAccepted = AcceptancePolicy.accepts(
    notWhollyMemberSupport,
    notWhollyMemberCompetitorSupport,
    policy,
  );

  if (notWhollyMemberAccepted) {
    return Match.value(quantifier).pipe(
      Match.when("all", () => Option.some(no(quantifier))),
      Match.when("any", () => Option.none()),
      Match.when("none", () => Option.none()),
      Match.exhaustive,
    );
  }

  const clarificationAccepted = AcceptancePolicy.accepts(
    clarificationSupport,
    clarificationCompetitorSupport,
    policy,
  );

  if (clarificationAccepted && clarificationTarget !== undefined) {
    const judgment = CollectionMembershipJudgment.cases.MultipleTaxaInTarget.make({
      quantifier,
      target: clarificationTarget,
    });

    return Option.some({ ...judgment, target: clarificationTarget });
  }

  const judgment = CollectionMembershipJudgment.cases.Undetermined.make({ quantifier });

  return Option.some(judgment);
};

const quantifyRecords = Effect.fnUntraced(function* <T extends TaxonomicRecord>(
  quantifier: RecordQuantifier,
  records: readonly RecordInput[],
  target: MembershipTarget<T>,
  options: CollectionOptions = {},
): Effect.fn.Return<
  CollectionMembershipJudgment<T | Named>,
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

  const hints = yield* TaxonomyHints.snapshot(options.hints);
  const execution = options.execution ?? defaultCollectionExecution;
  const input = Array.copy(records);
  const prepared = yield* prepareMembershipTarget(target);
  const policy = options.policy ?? AcceptancePolicy.defaultPolicy;

  const batches = Iterable.filter(
    Iterable.chunksOf(input, execution.batchSize),
    Array.isArrayNonEmpty,
  );

  const windows = Iterable.chunksOf(batches, execution.concurrency);
  let encounteredUncertainty = false;

  for (const window of windows) {
    const resultsByBatch = yield* Effect.forEach(
      window,
      (batch) => decideMembershipBatch(batch, prepared, hints),
      { concurrency: execution.concurrency },
    );

    for (const results of resultsByBatch) {
      for (const answer of results) {
        const step = interpretQuantifierAnswer(quantifier, answer, prepared.targetTaxa, policy);

        if (Option.isNone(step)) continue;

        const judgment = step.value;

        const decisive = Match.value(judgment).pipe(
          Match.tagsExhaustive({
            Yes: () => true,
            No: () => true,
            Undetermined: () => false,
            MultipleTaxaInTarget: () => true,
          }),
        );

        if (decisive) return judgment;
        encounteredUncertainty = true;
      }
    }
  }

  if (encounteredUncertainty)
    return CollectionMembershipJudgment.cases.Undetermined.make({ quantifier });

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
