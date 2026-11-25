import * as DecisionModel from "effect/ai/DecisionModel";
import * as Array from "effect/Array";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Iterable from "effect/Iterable";
import * as Match from "effect/Match";
import * as Struct from "effect/Struct";
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
  TaxonMembershipJudgment,
  type MembershipTarget,
  prepareMembershipTarget,
  decideMembershipBatch,
  interpretMembership,
} from "./Membership.ts";

type Named = { readonly scientificName: TaxonName };

class MembershipPartition<
  A extends RecordInput,
  T extends TaxonomicRecord = TaxonomicRecord,
> extends Data.Class<{
  readonly Member: readonly A[];
  readonly NotMember: readonly A[];
  readonly MixedMembership: readonly A[];
  readonly Undetermined: readonly A[];
  readonly MultipleTaxaInTarget: readonly {
    readonly record: A;
    readonly target: Taxon<T>;
  }[];
}> {
  /**
   * Build ordered buckets from corresponding record and judgment batches.
   * Each judgment batch contains one judgment per record, in the same order.
   */
  static fromBatches<A extends RecordInput, T extends TaxonomicRecord = TaxonomicRecord>(
    batches: readonly (readonly A[])[],
    judgmentsByBatch: readonly (readonly TaxonMembershipJudgment<T>[])[],
  ): MembershipPartition<A, T> {
    const Member: A[] = [];
    const NotMember: A[] = [];
    const MixedMembership: A[] = [];
    const Undetermined: A[] = [];
    const MultipleTaxaInTarget: { readonly record: A; readonly target: Taxon<T> }[] = [];

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
            MultipleTaxaInTarget: ({ target }) => {
              MultipleTaxaInTarget.push({ record, target });
            },
          }),
        );
      }
    }

    return new MembershipPartition<A, T>({
      Member,
      NotMember,
      MixedMembership,
      Undetermined,
      MultipleTaxaInTarget,
    });
  }
}

/**
 * Taxonomy.partitionRecordsByMembership returns this type.
 * Its five buckets retain original record references, caller-supplied fields,
 * repeated occurrences, and input order within each bucket.
 * You can use .pipe() to transform the partition.
 * Entries in MultipleTaxaInTarget retain both the record and original target node for review.
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
export type RecordMembershipPartition<
  A extends RecordInput,
  T extends TaxonomicRecord = TaxonomicRecord,
> = MembershipPartition<A, T>;

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
export function partitionRecordsByMembership<A extends RecordInput, T extends TaxonomicRecord>(
  records: readonly A[],
  target: T | TaxonSet<T>,
  options?: CollectionOptions,
): Effect.Effect<
  RecordMembershipPartition<A, T>,
  Errors.TaxonomyError,
  DecisionModel.DecisionModel
>;

export function partitionRecordsByMembership<A extends RecordInput>(
  records: readonly A[],
  target: TaxonName,
  options?: CollectionOptions,
): Effect.Effect<
  RecordMembershipPartition<A, Named>,
  Errors.TaxonomyError,
  DecisionModel.DecisionModel
>;

export function partitionRecordsByMembership<
  A extends RecordInput,
  T extends TaxonomicRecord = TaxonomicRecord,
>(
  records: readonly A[],
  target: MembershipTarget<T>,
  options?: CollectionOptions,
): Effect.Effect<
  RecordMembershipPartition<A, T | Named>,
  Errors.TaxonomyError,
  DecisionModel.DecisionModel
>;

export function partitionRecordsByMembership<A extends RecordInput>(
  records: readonly A[],
  target: MembershipTarget,
  options?: CollectionOptions,
): Effect.Effect<RecordMembershipPartition<A>, Errors.TaxonomyError, DecisionModel.DecisionModel> {
  return partitionRecordsByMembershipEffect(records, target, options);
}

const partitionRecordsByMembershipEffect = Effect.fn("Taxonomy.partitionRecordsByMembership")(
  function* <A extends RecordInput, T extends TaxonomicRecord>(
    records: readonly A[],
    target: MembershipTarget<T>,
    options: CollectionOptions = {},
  ) {
    if (taxonSetSchema.guards.Empty(target)) {
      return new MembershipPartition<A, T>({
        Member: [],
        NotMember: Array.copy(records),
        MixedMembership: [],
        Undetermined: [],
        MultipleTaxaInTarget: [],
      });
    }

    if (!Array.isReadonlyArrayNonEmpty(records))
      return MembershipPartition.fromBatches<A, T>([], []);

    const hints = yield* TaxonomyHints.snapshot(options.hints);
    const execution = options.execution ?? defaultCollectionExecution;

    const batches = Array.fromIterable(
      Iterable.filter(Iterable.chunksOf(records, execution.batchSize), Array.isArrayNonEmpty),
    );

    const prepared = yield* prepareMembershipTarget(target);
    const policy = options.policy ?? AcceptancePolicy.defaultPolicy;

    const judgmentsByBatch = yield* Effect.forEach(
      batches,
      (batch) =>
        decideMembershipBatch(batch, prepared, hints).pipe(
          Effect.map((answers) =>
            Array.map(answers, (answer) =>
              interpretMembership(answer, prepared.targetTaxa, policy),
            ),
          ),
        ),
      { concurrency: execution.concurrency },
    );

    return MembershipPartition.fromBatches(batches, judgmentsByBatch);
  },
);

class MembershipPartitionsByTarget<
  A extends RecordInput,
  T extends TaxonomicRecord = TaxonomicRecord,
> extends Data.Class<{
  readonly groups: readonly {
    readonly target: MembershipTarget<T>;
    readonly partition: RecordMembershipPartition<A, T>;
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
export type RecordsGroupedByTaxa<
  A extends RecordInput,
  T extends TaxonomicRecord = TaxonomicRecord,
> = MembershipPartitionsByTarget<A, T>;

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
export function groupRecordsByTaxa<A extends RecordInput, T extends TaxonomicRecord>(
  records: readonly A[],
  targets: readonly (T | TaxonSet<T>)[],
  options?: CollectionOptions,
): Effect.Effect<RecordsGroupedByTaxa<A, T>, Errors.TaxonomyError, DecisionModel.DecisionModel>;

export function groupRecordsByTaxa<A extends RecordInput>(
  records: readonly A[],
  targets: readonly TaxonName[],
  options?: CollectionOptions,
): Effect.Effect<RecordsGroupedByTaxa<A, Named>, Errors.TaxonomyError, DecisionModel.DecisionModel>;

export function groupRecordsByTaxa<
  A extends RecordInput,
  T extends TaxonomicRecord = TaxonomicRecord,
>(
  records: readonly A[],
  targets: readonly MembershipTarget<T>[],
  options?: CollectionOptions,
): Effect.Effect<
  RecordsGroupedByTaxa<A, T | Named>,
  Errors.TaxonomyError,
  DecisionModel.DecisionModel
>;

export function groupRecordsByTaxa<A extends RecordInput>(
  records: readonly A[],
  targets: readonly MembershipTarget[],
  options?: CollectionOptions,
): Effect.Effect<RecordsGroupedByTaxa<A>, Errors.TaxonomyError, DecisionModel.DecisionModel> {
  return groupRecordsByTaxaEffect(records, targets, options);
}

const groupRecordsByTaxaEffect = Effect.fn("Taxonomy.groupRecordsByTaxa")(function* <
  A extends RecordInput,
  T extends TaxonomicRecord,
>(records: readonly A[], targets: readonly MembershipTarget<T>[], options: CollectionOptions = {}) {
  let scopedOptions = options;

  if (records.length > 0 && targets.some((target) => !taxonSetSchema.guards.Empty(target))) {
    const hints = yield* TaxonomyHints.snapshot(options.hints);
    scopedOptions = Struct.assign(options, { hints });
  }

  const groups = yield* Effect.forEach(
    targets,
    (target) =>
      partitionRecordsByMembership(records, target, scopedOptions).pipe(
        Effect.map((partition) => ({ target, partition })),
      ),
    { concurrency: 1 },
  );

  return new MembershipPartitionsByTarget<A, T | Named>({ groups });
});
