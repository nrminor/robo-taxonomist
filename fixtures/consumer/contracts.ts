// Compile only, against package exports after build; never executed by Vitest.
import { Effect, type Array, type Types } from "effect";
import type { AiError, DecisionModel } from "effect/ai";
import {
  AcceptancePolicy,
  RecordLabel,
  TaxonName,
  Taxonomy,
  TaxonSet,
  type CollectionMembershipJudgment,
  type RecordMembershipPartition,
  type RecordsGroupedByTaxa,
  type RankComparisonJudgment,
  type TaxonomicRank,
  type TaxonIdentityJudgment,
  type TaxonContainmentJudgment,
  type TaxonMembershipJudgment,
  type TaxonSetRelationJudgment,
} from "robo-taxonomist";

type IsAny<T> = 0 extends 1 & T ? true : false;
type Equal<A, B> =
  IsAny<A> extends true ? false : IsAny<B> extends true ? false : Types.Equals<A, B>;
type Assert<T extends true> = T;
type UnionOperands = Types.ExtractTag<TaxonSet.TaxonSet, "Union">["operands"];
type IntersectionOperands = Types.ExtractTag<TaxonSet.TaxonSet, "Intersection">["operands"];
type Judgment<T, A> =
  Equal<Effect.Success<T>, A> extends true
    ? Equal<Effect.Error<T>, AiError.AiError> extends true
      ? Equal<Effect.Services<T>, DecisionModel.DecisionModel>
      : false
    : false;

type RankRelationTag =
  | "SameTaxonAtRank"
  | "SameMultipleTaxaAtRank"
  | "SameTaxaAtRank"
  | "LeftTaxaWithinRightAtRank"
  | "RightTaxaWithinLeftAtRank"
  | "PartlySharedTaxaAtRank"
  | "NoSharedTaxaAtRank"
  | "DifferentTaxaAtRank"
  | "Undetermined";
type ExpectedRankComparison =
  | {
      [Tag in RankRelationTag]: { readonly _tag: Tag; readonly rank: TaxonomicRank };
    }[RankRelationTag]
  | {
      readonly _tag: "MultipleTaxaAtRank";
      readonly rank: TaxonomicRank;
      readonly side: "left" | "right" | "both";
    };

const label = RecordLabel.make("Voucher A17 | Quercus robur");
const name = TaxonName.make("Quercus");
const oaks = TaxonSet.of(name);
if (oaks._tag === "Union") {
  // @ts-expect-error Inspectable expression tags remain readonly after narrowing.
  oaks._tag = "Union";
  // @ts-expect-error Nonempty expression operands remain readonly after narrowing.
  oaks.operands.push(oaks);
}
if (oaks._tag === "Intersection") {
  // @ts-expect-error Intersection operands remain readonly after narrowing too.
  oaks.operands.push(oaks);
}
const specimen: { readonly label: RecordLabel; readonly voucher: "A17" } = {
  label,
  voucher: "A17",
};
const records: readonly (typeof specimen)[] = [specimen];
const policy = AcceptancePolicy.make({ minimumSupport: 0.8, minimumMargin: 0.1 });
const rank = Taxonomy.sameSpecies(specimen, specimen, { policy });
const identity = Taxonomy.sameTaxon(name, name, { policy });
const containment = Taxonomy.taxonWithin(name, name, { policy });

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
  Assert<Judgment<typeof rank, RankComparisonJudgment>>,
  Assert<Equal<RankComparisonJudgment, ExpectedRankComparison>>,
  Assert<Equal<IsAny<RankComparisonJudgment>, false>>,
  Assert<
    Equal<
      TaxonomicRank,
      "domain" | "kingdom" | "phylum" | "class" | "order" | "family" | "genus" | "species"
    >
  >,
  Assert<Judgment<typeof identity, TaxonIdentityJudgment>>,
  Assert<Judgment<typeof containment, TaxonContainmentJudgment>>,
  Assert<Equal<UnionOperands, Array.NonEmptyReadonlyArray<TaxonSet.TaxonSet>>>,
  Assert<Equal<IntersectionOperands, Array.NonEmptyReadonlyArray<TaxonSet.TaxonSet>>>,
  Assert<Equal<IsAny<UnionOperands[number]>, false>>,
  Assert<Equal<IsAny<IntersectionOperands[number]>, false>>,
  Assert<Judgment<typeof relation, TaxonSetRelationJudgment>>,
  Assert<Judgment<typeof membership, TaxonMembershipJudgment>>,
  Assert<Judgment<typeof partition, RecordMembershipPartition<typeof specimen>>>,
  Assert<Judgment<typeof grouped, RecordsGroupedByTaxa<typeof specimen>>>,
  Assert<Judgment<typeof all, CollectionMembershipJudgment>>,
  Assert<Judgment<typeof some, CollectionMembershipJudgment>>,
  Assert<Judgment<typeof none, CollectionMembershipJudgment>>,
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
