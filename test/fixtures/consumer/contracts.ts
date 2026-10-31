// Compile only, against package exports after build; never executed by Vitest.
import { Effect, type Array, type Types } from "effect";
import type { AiError, Decision, DecisionModel } from "effect/ai";
import * as RoboTaxonomist from "robo-taxonomist";
import {
  AcceptancePolicy,
  RecordLabel,
  TaxonId,
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
  type TaxonMatch,
  type TaxonMatchJudgment,
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
type NamedTarget = { readonly scientificName: TaxonName };
// Membership APIs also account for the record created by name shorthand.
type ShorthandTarget = { readonly scientificName: TaxonName };
const trees = TaxonSet.union(oaks, TaxonSet.empty());
if (trees._tag === "Union") {
  // @ts-expect-error Inspectable expression tags remain readonly after narrowing.
  trees._tag = "Union";
  // @ts-expect-error Nonempty expression operands remain readonly after narrowing.
  trees.operands.push(oaks);
}
const shared = TaxonSet.intersection(oaks, oaks);
if (shared._tag === "Intersection") {
  // @ts-expect-error Intersection operands remain readonly after narrowing too.
  shared.operands.push(oaks);
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
const classified = Taxonomy.classifyRecords(records, oaks, { policy });
type Classified = Effect.Success<typeof classified>;
type ClassifiedRow = Classified["records"][number];
type ClassifiedMatch = ClassifiedRow["ranking"][number];
const all = Taxonomy.allRecordsBelongTo(records, oaks);
const some = Taxonomy.anyRecordBelongsTo(records, name);
const none = Taxonomy.noRecordBelongsTo(records, oaks);

// A named assignment retains caller metadata in every returned target record.
const assignment: {
  readonly scientificName: TaxonName;
  readonly assignmentId: "oak-genus";
  readonly rank: "genus";
} = { scientificName: name, assignmentId: "oak-genus", rank: "genus" };
const assignedOaks = TaxonSet.of(assignment);
const identifiedTarget: {
  readonly taxonId: TaxonId;
  readonly source: "reference-panel";
} = {
  taxonId: TaxonId.make({ taxonomy: "ncbi", id: "58334" }),
  source: "reference-panel",
};
const mixedPanel = TaxonSet.union(assignedOaks, TaxonSet.of(identifiedTarget));
const assignedClassification = Taxonomy.classifyRecords(records, assignedOaks);
const mixedClassification = Taxonomy.classifyRecords(records, mixedPanel);
const assignedIdentity = Taxonomy.sameTaxon(assignment, identifiedTarget);
const assignedContainment = Taxonomy.taxonWithin(identifiedTarget, assignment);
const assignedMembership = Taxonomy.recordBelongsTo(specimen, assignment);
const assignedSetMembership = Taxonomy.recordBelongsTo(specimen, assignedOaks);
const namedMembership = Taxonomy.recordBelongsTo(specimen, name);
const assignedPartition = Taxonomy.partitionRecordsByMembership(records, assignment);
const assignedSetPartition = Taxonomy.partitionRecordsByMembership(records, assignedOaks);
const assignedGroups = Taxonomy.groupRecordsByTaxa(records, [assignment, assignedOaks]);
const assignedCollection = Taxonomy.allRecordsBelongTo(records, assignment);
const assignedSetCollection = Taxonomy.allRecordsBelongTo(records, assignedOaks);

// Narrowing a diagnostic exposes the original record, with no name-only fallback.
const assignedDiagnostic = assignedMembership.pipe(
  Effect.map((judgment) => {
    if (judgment._tag !== "MultipleTaxaInTarget") return undefined;
    const { scientificName, assignmentId, rank } = judgment.target.record;
    return { scientificName, assignmentId, rank };
  }),
);
const assignedSetDiagnostic = assignedSetMembership.pipe(
  Effect.map((judgment) => {
    if (judgment._tag !== "MultipleTaxaInTarget") return undefined;
    const { scientificName, assignmentId, rank } = judgment.target.record;
    return { scientificName, assignmentId, rank };
  }),
);
const namedDiagnostic = namedMembership.pipe(
  Effect.map((judgment) => {
    if (judgment._tag !== "MultipleTaxaInTarget") return undefined;
    return judgment.target.record.scientificName;
  }),
);
type AssignmentDiagnostic =
  | {
      scientificName: TaxonName;
      assignmentId: "oak-genus";
      rank: "genus";
    }
  | undefined;
type MixedTarget = typeof assignment | typeof identifiedTarget;
type AssignedClassification = Effect.Success<typeof assignedClassification>;
type MixedClassification = Effect.Success<typeof mixedClassification>;
type MixedMatch = MixedClassification["records"][number]["ranking"][number];
const mixedTargetLabels = mixedClassification.pipe(
  Effect.map((result) =>
    result.records.flatMap((row) =>
      row.ranking.map(({ taxon }) =>
        "scientificName" in taxon.record ? taxon.record.scientificName : taxon.record.taxonId.id,
      ),
    ),
  ),
);

// Both the outer Effect and the inner partition/group value must remain pipeable.
const members = partition.pipe(Effect.map((value) => value.pipe((p) => p.Member)));
const groupedMembers = grouped.pipe(
  Effect.map((value) =>
    value.pipe((g) => g.groups.map(({ partition: p }) => p.pipe((buckets) => buckets.Member))),
  ),
);
const classifiedVouchers = classified.pipe(
  Effect.map((value) =>
    value.records.flatMap((row) => row.ranking.map((match) => match.pipe((m) => m.record.voucher))),
  ),
);

export type Contracts = [
  Assert<Judgment<typeof assignedMembership, TaxonMembershipJudgment<typeof assignment>>>,
  Assert<Judgment<typeof assignedSetMembership, TaxonMembershipJudgment<typeof assignment>>>,
  Assert<Judgment<typeof namedMembership, TaxonMembershipJudgment<ShorthandTarget>>>,
  Assert<Judgment<typeof assignedDiagnostic, AssignmentDiagnostic>>,
  Assert<Judgment<typeof assignedSetDiagnostic, AssignmentDiagnostic>>,
  Assert<Judgment<typeof namedDiagnostic, TaxonName | undefined>>,
  Assert<
    Judgment<
      typeof assignedPartition,
      RecordMembershipPartition<typeof specimen, typeof assignment>
    >
  >,
  Assert<
    Judgment<
      typeof assignedSetPartition,
      RecordMembershipPartition<typeof specimen, typeof assignment>
    >
  >,
  Assert<Judgment<typeof assignedGroups, RecordsGroupedByTaxa<typeof specimen, typeof assignment>>>,
  Assert<Judgment<typeof assignedCollection, CollectionMembershipJudgment<typeof assignment>>>,
  Assert<Judgment<typeof assignedSetCollection, CollectionMembershipJudgment<typeof assignment>>>,
  Assert<
    Equal<
      Effect.Success<
        typeof assignedGroups
      >["groups"][number]["partition"]["MultipleTaxaInTarget"][number]["target"]["record"],
      typeof assignment
    >
  >,
  Assert<Judgment<typeof assignedIdentity, TaxonIdentityJudgment>>,
  Assert<Judgment<typeof assignedContainment, TaxonContainmentJudgment>>,
  Assert<Equal<typeof oaks.record, NamedTarget>>,
  Assert<Equal<typeof assignedOaks.record, typeof assignment>>,
  Assert<
    Equal<
      AssignedClassification["records"][number]["ranking"][number]["taxon"]["record"],
      typeof assignment
    >
  >,
  Assert<Equal<typeof mixedPanel, TaxonSet.TaxonSet<MixedTarget>>>,
  Assert<Equal<MixedClassification["panel"], TaxonSet.TaxonSet<MixedTarget>>>,
  Assert<Equal<MixedMatch, TaxonMatch<typeof specimen, MixedTarget>>>,
  Assert<Equal<MixedMatch["taxon"]["record"], MixedTarget>>,
  Assert<Equal<MixedClassification["records"][number]["taxa"][number], MixedMatch>>,
  Assert<Judgment<typeof mixedTargetLabels, string[]>>,
  Assert<Equal<ClassifiedRow["record"], typeof specimen>>,
  Assert<Equal<ClassifiedMatch["record"], typeof specimen>>,
  Assert<Equal<ClassifiedMatch, TaxonMatch<typeof specimen, NamedTarget>>>,
  Assert<Equal<ClassifiedRow["taxa"][number], TaxonMatch<typeof specimen, NamedTarget>>>,
  Assert<Equal<ClassifiedMatch["taxon"], typeof oaks>>,
  Assert<Equal<Classified["panel"], TaxonSet.TaxonSet<NamedTarget>>>,
  Assert<Equal<TaxonMatch<typeof specimen>["record"], typeof specimen>>,
  Assert<Equal<TaxonMatch<typeof specimen>["taxon"], Types.ExtractTag<TaxonSet.TaxonSet, "Taxon">>>,
  Assert<Equal<ClassifiedMatch["judgment"], TaxonMatchJudgment>>,
  Assert<Equal<TaxonMatchJudgment["_tag"], "Matched" | "NotMatched" | "Undetermined">>,
  Assert<
    Equal<
      ClassifiedMatch["answer"],
      Decision.ClassifyAnswer<"sameTaxon" | "withinTaxon" | "noMatch" | "undetermined">
    >
  >,
  Assert<Equal<Classified["usage"], readonly DecisionModel.DecisionUsage[]>>,
  Assert<Equal<Effect.Error<typeof classified>, AiError.AiError>>,
  Assert<Equal<Effect.Services<typeof classified>, DecisionModel.DecisionModel>>,
  Assert<Equal<ClassifiedMatch["support"] extends number ? true : false, true>>,
  Assert<Equal<number extends ClassifiedMatch["support"] ? true : false, false>>,
  Assert<Equal<IsAny<ClassifiedMatch["support"]>, false>>,
  Assert<Judgment<typeof classifiedVouchers, "A17"[]>>,
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
  Assert<Judgment<typeof relation, TaxonSetRelationJudgment<NamedTarget>>>,
  Assert<Judgment<typeof membership, TaxonMembershipJudgment<NamedTarget>>>,
  Assert<Judgment<typeof partition, RecordMembershipPartition<typeof specimen, ShorthandTarget>>>,
  Assert<
    Judgment<typeof grouped, RecordsGroupedByTaxa<typeof specimen, NamedTarget | ShorthandTarget>>
  >,
  Assert<Judgment<typeof all, CollectionMembershipJudgment<NamedTarget>>>,
  Assert<Judgment<typeof some, CollectionMembershipJudgment<ShorthandTarget>>>,
  Assert<Judgment<typeof none, CollectionMembershipJudgment<NamedTarget>>>,
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
        readonly MultipleTaxaInTarget: readonly {
          readonly record: typeof specimen;
          readonly target: Types.ExtractTag<TaxonSet.TaxonSet<ShorthandTarget>, "Taxon">;
        }[];
      }
    >
  >,
  Assert<
    Equal<
      Effect.Success<typeof grouped>["groups"],
      readonly {
        readonly target:
          | TaxonName
          | NamedTarget
          | ShorthandTarget
          | TaxonSet.TaxonSet<NamedTarget | ShorthandTarget>;
        readonly partition: RecordMembershipPartition<
          typeof specimen,
          NamedTarget | ShorthandTarget
        >;
      }[]
    >
  >,
];

// Keep every tag and child valid except the deeply nested numeric scientific name.
// Otherwise a widened outer tag could mask the recursive-declaration regression.
const malformed: {
  readonly _tag: "Difference";
  readonly left: TaxonSet.TaxonSet;
  readonly right: {
    readonly _tag: "Difference";
    readonly left: TaxonSet.TaxonSet;
    readonly right: {
      readonly _tag: "Taxon";
      readonly record: { readonly scientificName: number };
    };
  };
} = {
  _tag: "Difference",
  left: oaks,
  right: {
    _tag: "Difference",
    left: oaks,
    right: { _tag: "Taxon", record: { scientificName: 42 } },
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

// @ts-expect-error Classification panels retain recursive expression validation.
export const rejectedClassificationPanel = Taxonomy.classifyRecords(records, malformed);
// @ts-expect-error Raw text cannot bypass the record-label schema.
export const rejectedClassificationRecord = Taxonomy.classifyRecords(["unvalidated"], oaks);
// @ts-expect-error Caller metadata alone is not an identifying description.
export const rejectedClassificationMetadata = Taxonomy.classifyRecords([{ abundance: 8 }], oaks);
// @ts-expect-error TaxonMatch is exported only as a type, not a runtime constructor.
void RoboTaxonomist.TaxonMatch;
// @ts-expect-error The support constructor is not part of the root API.
void RoboTaxonomist.Support;
// @ts-expect-error The shared internal bound is not part of the root API.
void RoboTaxonomist.UnitInterval;
