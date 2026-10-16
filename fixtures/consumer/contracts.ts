// Compile only, against package exports after build; never executed by Vitest.
import { Effect } from "effect";
import type { AiError, DecisionModel } from "effect/ai";
import {
  RecordLabel,
  TaxonName,
  Taxonomy,
  TaxonSet,
  type CollectionMembershipResult,
  type RecordMembershipPartition,
  type RecordsGroupedByTaxa,
  type TaxonMembershipResult,
  type TaxonSetRelationResult,
} from "robo-taxonomist";

type IsAny<T> = 0 extends 1 & T ? true : false;
type Equal<A, B> =
  IsAny<A> extends true
    ? false
    : IsAny<B> extends true
      ? false
      : (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
        ? true
        : false;
type Assert<T extends true> = T;
type Judgment<T, A> =
  Equal<Effect.Success<T>, A> extends true
    ? Equal<Effect.Error<T>, AiError.AiError> extends true
      ? Equal<Effect.Services<T>, DecisionModel.DecisionModel>
      : false
    : false;

const label = RecordLabel.make("Voucher A17 | Quercus robur");
const name = TaxonName.make("Quercus");
const oaks = TaxonSet.of(name);
if (oaks._tag === "Union") {
  // @ts-expect-error Inspectable expression tags remain readonly after narrowing.
  oaks._tag = "Union";
  // @ts-expect-error Nonempty expression operands remain readonly after narrowing.
  oaks.operands.push(oaks);
}
const specimen: { readonly label: RecordLabel; readonly voucher: "A17" } = {
  label,
  voucher: "A17",
};
const records: readonly (typeof specimen)[] = [specimen];

const relation = TaxonSet.isSubsetOf(oaks, TaxonSet.union(oaks, TaxonSet.empty()));
const membership = Taxonomy.recordBelongsTo(specimen, oaks);
const partition = Taxonomy.partitionRecordsByMembership(records, name);
const grouped = Taxonomy.groupRecordsByTaxa(records, [name, oaks]);
const all = Taxonomy.allRecordsBelongTo(records, oaks);
const some = Taxonomy.anyRecordBelongsTo(records, name);
const none = Taxonomy.noRecordBelongsTo(records, oaks);

// Both the outer Effect and the inner partition/group value must remain pipeable.
const members = partition.pipe(Effect.map((value) => value.pipe((p) => p.Member)));
const groupedMembers = grouped.pipe(
  Effect.map((value) =>
    value.pipe((g) => g.groups.map(({ partition: p }) => p.pipe((buckets) => buckets.Member))),
  ),
);

export type Contracts = [
  Assert<Judgment<typeof relation, TaxonSetRelationResult>>,
  Assert<Judgment<typeof membership, TaxonMembershipResult>>,
  Assert<Judgment<typeof partition, RecordMembershipPartition<typeof specimen>>>,
  Assert<Judgment<typeof grouped, RecordsGroupedByTaxa<typeof specimen>>>,
  Assert<Judgment<typeof all, CollectionMembershipResult>>,
  Assert<Judgment<typeof some, CollectionMembershipResult>>,
  Assert<Judgment<typeof none, CollectionMembershipResult>>,
  Assert<Judgment<typeof members, readonly (typeof specimen)[]>>,
  Assert<Judgment<typeof groupedMembers, (readonly (typeof specimen)[])[]>>,
  Assert<
    Equal<
      Omit<Effect.Success<typeof partition>, "pipe">,
      {
        readonly Member: readonly (typeof specimen)[];
        readonly NotMember: readonly (typeof specimen)[];
        readonly MixedMembership: readonly (typeof specimen)[];
        readonly Undetermined: readonly (typeof specimen)[];
        readonly MultipleTaxaInTargetName: readonly {
          readonly record: typeof specimen;
          readonly targetName: TaxonName;
        }[];
      }
    >
  >,
  Assert<
    Equal<
      Effect.Success<typeof grouped>["groups"],
      readonly {
        readonly target: TaxonName | TaxonSet.TaxonSet;
        readonly partition: RecordMembershipPartition<typeof specimen>;
      }[]
    >
  >,
];

// Keep every tag and child valid except the deeply nested numeric name.
// Otherwise a widened outer tag could mask the recursive-declaration regression.
const malformed: {
  readonly _tag: "Difference";
  readonly left: TaxonSet.TaxonSet;
  readonly right: {
    readonly _tag: "Difference";
    readonly left: TaxonSet.TaxonSet;
    readonly right: { readonly _tag: "Taxon"; readonly name: number };
  };
} = {
  _tag: "Difference",
  left: oaks,
  right: {
    _tag: "Difference",
    left: oaks,
    right: { _tag: "Taxon", name: 42 },
  },
};

// @ts-expect-error A numeric taxon name remains invalid through two recursive children.
export const rejectedMembership = Taxonomy.recordBelongsTo(label, malformed);
// @ts-expect-error Subset operands must retain recursive validation.
export const rejectedSubset = TaxonSet.isSubsetOf(malformed, oaks);
// @ts-expect-error Proper-subset operands must retain recursive validation.
export const rejectedProperSubset = TaxonSet.isProperSubsetOf(oaks, malformed);
// @ts-expect-error Equivalence operands must retain recursive validation.
export const rejectedEquivalent = TaxonSet.equivalent(malformed, oaks);
// @ts-expect-error Overlap operands must retain recursive validation.
export const rejectedOverlap = TaxonSet.overlaps(oaks, malformed);
// @ts-expect-error Disjointness operands must retain recursive validation.
export const rejectedDisjoint = TaxonSet.disjoint(malformed, oaks);
// @ts-expect-error Partition targets must retain recursive validation.
export const rejectedPartition = Taxonomy.partitionRecordsByMembership(records, malformed);
// @ts-expect-error Each grouping target must retain recursive validation.
export const rejectedGroup = Taxonomy.groupRecordsByTaxa(records, [oaks, malformed]);
// @ts-expect-error Universal targets must retain recursive validation.
export const rejectedAll = Taxonomy.allRecordsBelongTo(records, malformed);
// @ts-expect-error Existential targets must retain recursive validation.
export const rejectedSome = Taxonomy.anyRecordBelongsTo(records, malformed);
// @ts-expect-error Negative existential targets must retain recursive validation.
export const rejectedNone = Taxonomy.noRecordBelongsTo(records, malformed);

// Input roles are intentionally distinct even though both brands wrap strings.
// @ts-expect-error A record label is not a whole-taxon name.
export const rejectedTaxonName = TaxonSet.of(label);
// @ts-expect-error A whole-taxon name is not a record operand.
export const rejectedRecord = Taxonomy.recordBelongsTo(name, oaks);
// @ts-expect-error Raw text must not bypass validated record labels.
export const rejectedRawRecord = Taxonomy.recordBelongsTo("unvalidated", name);
