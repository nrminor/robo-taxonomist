import * as Decision from "effect/ai/Decision";
import * as DecisionModel from "effect/ai/DecisionModel";
import * as Array from "effect/Array";
import * as Effect from "effect/Effect";
import * as Function from "effect/Function";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Record from "effect/Record";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import * as AcceptancePolicy from "../AcceptancePolicy.ts";
import type { TaxonSet } from "../TaxonSet.ts";
import * as Errors from "../errors.ts";
import {
  TaxonomicRecord,
  TaxonName,
  Taxon,
  TaxonomyHint,
  taxonSetSchema,
  type JudgmentOptions,
} from "../schemas.ts";
import * as TaxonSetGraph from "../TaxonSetGraph.ts";
import * as TaxonomyHints from "../TaxonomyHints.ts";
import { describeRecord, recordInputSchema, type RecordInput } from "./RecordInput.ts";

/** Describe a membership judgment and any target requiring clarification.
 * @category schemas
 */
export const TaxonMembershipJudgment = Schema.TaggedUnion({
  Member: {},
  NotMember: {},
  MixedMembership: {},
  MultipleTaxaInTarget: { target: Taxon },
  Undetermined: {},
});

/** Retain the concrete target record type on judgments that carry a taxon. */
export type WithTarget<J, T extends TaxonomicRecord> = J extends { readonly target: Taxon }
  ? { readonly [K in keyof J]: K extends "target" ? Taxon<T> : J[K] }
  : J;

export type TaxonMembershipJudgment<T extends TaxonomicRecord = TaxonomicRecord> = WithTarget<
  typeof TaxonMembershipJudgment.Type,
  T
>;

/** Target accepted by record and collection membership operations. */
export type MembershipTarget<T extends TaxonomicRecord = TaxonomicRecord> =
  | TaxonName
  | T
  | TaxonSet<T>;

type Named = { readonly scientificName: TaxonName };

const batchRecordsSchema = Schema.NonEmptyArray(recordInputSchema);

const isTaxonSet = <T extends TaxonomicRecord>(target: T | TaxonSet<T>): target is TaxonSet<T> =>
  Schema.is(taxonSetSchema)(target);

/** Prepare a membership target and preserve its original taxon references. */
export const prepareMembershipTarget = Effect.fnUntraced(function* <T extends TaxonomicRecord>(
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
    criteria: Function.pipe(membershipChoices, Struct.assign(targetChoices)),
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

/** Model answer for one record in a membership batch. */
export type MembershipAnswer = Decision.Answer<
  Effect.Success<ReturnType<typeof makeMembershipBatchQuestion>>["decisions"][`record${number}`]
>;

const isTargetClarificationLabel = Schema.is(
  Schema.TemplateLiteral(["multipleTarget", Schema.Finite]),
);

/** Interpret a membership answer under the selected acceptance policy. */
export const interpretMembership = <T extends TaxonomicRecord>(
  answer: MembershipAnswer,
  targetTaxa: readonly Taxon<T>[],
  policy: AcceptancePolicy.AcceptancePolicy,
): TaxonMembershipJudgment<T> => {
  let clarificationCompetitorSupport = 0;

  for (let index = 0; index < targetTaxa.length; index++) {
    const label = `multipleTarget${index}` as const;

    if (label === answer.label) continue;
    const support = Record.get(answer.probabilities, label).pipe(Option.getOrThrow);
    clarificationCompetitorSupport = Math.max(clarificationCompetitorSupport, support);
  }

  return Match.value(answer).pipe(
    Match.when({ label: "member" }, ({ probabilities: p }) => {
      const support = p.member;

      const competitorSupport = Math.max(
        p.notMember,
        p.mixed,
        p.undetermined,
        clarificationCompetitorSupport,
      );

      const accepted = AcceptancePolicy.accepts(support, competitorSupport, policy);

      return accepted
        ? TaxonMembershipJudgment.cases.Member.make({})
        : TaxonMembershipJudgment.cases.Undetermined.make({});
    }),
    Match.when({ label: "notMember" }, ({ probabilities: p }) => {
      const support = p.notMember;

      const competitorSupport = Math.max(
        p.member,
        p.mixed,
        p.undetermined,
        clarificationCompetitorSupport,
      );

      const accepted = AcceptancePolicy.accepts(support, competitorSupport, policy);

      return accepted
        ? TaxonMembershipJudgment.cases.NotMember.make({})
        : TaxonMembershipJudgment.cases.Undetermined.make({});
    }),
    Match.when({ label: "mixed" }, ({ probabilities: p }) => {
      const support = p.mixed;

      const competitorSupport = Math.max(
        p.member,
        p.notMember,
        p.undetermined,
        clarificationCompetitorSupport,
      );

      const accepted = AcceptancePolicy.accepts(support, competitorSupport, policy);

      return accepted
        ? TaxonMembershipJudgment.cases.MixedMembership.make({})
        : TaxonMembershipJudgment.cases.Undetermined.make({});
    }),
    Match.when({ label: "undetermined" }, () =>
      TaxonMembershipJudgment.cases.Undetermined.make({}),
    ),
    Match.when({ label: isTargetClarificationLabel }, ({ label, probabilities: p }) => {
      const support = Record.get(p, label).pipe(Option.getOrThrow);

      const competitorSupport = Math.max(
        p.member,
        p.notMember,
        p.mixed,
        p.undetermined,
        clarificationCompetitorSupport,
      );

      const accepted = AcceptancePolicy.accepts(support, competitorSupport, policy);

      if (!accepted) return TaxonMembershipJudgment.cases.Undetermined.make({});

      const target = Array.findFirst(
        targetTaxa,
        (_taxon, index) => label === `multipleTarget${index}`,
      ).pipe(Option.getOrThrow);

      const judgment = TaxonMembershipJudgment.cases.MultipleTaxaInTarget.make({ target });

      return { ...judgment, target };
    }),
    Match.exhaustive,
  );
};

/** Send one membership batch and interpret its answers in record order. */
export const decideMembershipBatch = Effect.fnUntraced(function* (
  records: typeof batchRecordsSchema.Type,
  prepared: Effect.Success<ReturnType<typeof prepareMembershipTarget>>,
  hints: ReadonlyArray<TaxonomyHint>,
) {
  const definition = yield* makeMembershipBatchQuestion(records, prepared);

  const input = Array.match(hints, {
    onEmpty: () => prepared.input,
    onNonEmpty: (nonempty) =>
      Struct.assign(prepared.input, {
        hints: nonempty,
        instructions: "Use the supplied taxonomic hints as background.",
      }),
  });

  const { answers } = yield* DecisionModel.decide(definition, { input });

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
  if (taxonSetSchema.guards.Empty(target)) return TaxonMembershipJudgment.cases.NotMember.make({});
  const hints = yield* TaxonomyHints.snapshot(options.hints);
  const prepared = yield* prepareMembershipTarget(target);
  const answers = yield* decideMembershipBatch([record], prepared, hints);

  return interpretMembership(
    Array.headNonEmpty(answers),
    prepared.targetTaxa,
    options.policy ?? AcceptancePolicy.defaultPolicy,
  );
});
