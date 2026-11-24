// Compile only, against package exports after build; never executed by Vitest.
import { Array, Data, Effect, Predicate, Schema, type Types } from "effect";
import type { AiError, Decision, DecisionModel } from "effect/ai";
import * as RoboTaxonomist from "robo-taxonomist";
import {
  AcceptancePolicy,
  Errors,
  NcbiTaxonId,
  RecordLabel,
  TaxonId,
  TaxonLookup,
  TaxonName,
  Taxonomy,
  TaxonomyHint,
  TaxonomyHints,
  TaxonSet,
  type CollectionMembershipJudgment,
  type RecordMembershipPartition,
  type RecordsGroupedByTaxa,
  type RankComparisonJudgment,
  type TaxonomicRank,
  TaxonIdentityJudgment,
  type TaxonContainmentJudgment,
  type TaxonMembershipJudgment,
  type TaxonMatch,
  TaxonMatchJudgment,
  type TaxonSetRelationJudgment,
} from "robo-taxonomist";

type IsAny<T> = 0 extends 1 & T ? true : false;

type Equal<A, B> =
  IsAny<A> extends true ? false : IsAny<B> extends true ? false : Types.Equals<A, B>;

type Assert<T extends true> = T;

type UnionOperands = Types.ExtractTag<TaxonSet.TaxonSet, "Union">["operands"];

type IntersectionOperands = Types.ExtractTag<TaxonSet.TaxonSet, "Intersection">["operands"];

type Judgment<T, A, E = Errors.TaxonomyError> =
  Equal<Effect.Success<T>, A> extends true
    ? Equal<Effect.Error<T>, E> extends true
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

type ExpectedRankComparison = Data.TaggedEnum<
  { [Tag in RankRelationTag]: { readonly rank: TaxonomicRank } } & {
    MultipleTaxaAtRank: {
      readonly rank: TaxonomicRank;
      readonly side: "left" | "right" | "both";
    };
  }
>;

type ExpectedUndetermined = Data.TaggedEnum<{ Undetermined: {} }>;

const label = RecordLabel.make("Voucher A17 | Quercus robur");

const name = TaxonName.make("Quercus");

const oaks = TaxonSet.of(name);

const oakOperand = Schema.declare((value): value is typeof oaks => value === oaks);

const UnbrandedEmpty = Schema.TaggedStruct("Empty", {});

const UnbrandedTaxon = Schema.TaggedStruct("Taxon", {
  record: Schema.Struct({ scientificName: TaxonName }),
});

const UnbrandedUnion = Schema.TaggedStruct("Union", {
  operands: Schema.Tuple([oakOperand]),
});

const UnbrandedIntersection = Schema.TaggedStruct("Intersection", {
  operands: Schema.Tuple([oakOperand]),
});

const UnbrandedDifference = Schema.TaggedStruct("Difference", {
  left: oakOperand,
  right: oakOperand,
});

// @ts-expect-error Empty expressions require construction, not a matching object shape.
TaxonSet.union(oaks, UnbrandedEmpty.make({}));

// @ts-expect-error Taxon expressions require construction even with a valid record.
TaxonSet.union(oaks, UnbrandedTaxon.make({ record: { scientificName: name } }));

// @ts-expect-error Union expressions require construction even with valid operands.
TaxonSet.union(oaks, UnbrandedUnion.make({ operands: [oaks] }));

// @ts-expect-error Intersection expressions require construction even with valid operands.
TaxonSet.union(oaks, UnbrandedIntersection.make({ operands: [oaks] }));

// @ts-expect-error Difference expressions require construction even with valid sides.
TaxonSet.union(oaks, UnbrandedDifference.make({ left: oaks, right: oaks }));

type NamedTarget = { readonly scientificName: TaxonName };

// Membership APIs also account for the record created by name shorthand.
type ShorthandTarget = { readonly scientificName: TaxonName };

const trees = TaxonSet.union(oaks, TaxonSet.empty());

if (Predicate.isTagged(trees, "Union")) {
  // @ts-expect-error Inspectable expression tags remain readonly after narrowing.
  trees._tag = "Union";
}

const specimen = {
  label,
  voucher: "A17",
} as const;

const records: readonly (typeof specimen)[] = [specimen];

const policy = AcceptancePolicy.make({ minimumSupport: 0.8, minimumMargin: 0.1 });

const rank = Taxonomy.sameSpecies(specimen, specimen, { policy });

const ncbiId = NcbiTaxonId.make({ id: "58334" });

const ncbiRecord = { taxonId: ncbiId, voucher: "A17" } as const;

const ncbiTarget = TaxonSet.of(ncbiRecord);

const ncbiPanelMatch = Taxonomy.classifyRecords([specimen], ncbiTarget);

const ncbiComparison = Taxonomy.sameGenus(ncbiRecord, specimen);

const ncbiMembership = Taxonomy.recordBelongsTo(ncbiRecord, ncbiTarget);

const lookup = Effect.gen(function* () {
  const taxonomy = yield* TaxonLookup;

  return yield* taxonomy.byId(ncbiId);
});

const identity = Taxonomy.sameTaxon(name, name, { policy });

const containment = Taxonomy.taxonWithin(name, name, { policy });

const contextHint = TaxonomyHint.make("context");

const readonlyHints: readonly TaxonomyHint[] = [contextHint];

const hintSnapshot = TaxonomyHints.snapshot(readonlyHints);

const inheritedHintSnapshot: typeof hintSnapshot = TaxonomyHints.snapshot(undefined);

void inheritedHintSnapshot;

const hinted = Taxonomy.classifyRecords(records, oaks, { hints: readonlyHints });

const hintedWithLayer = hinted.pipe(Effect.provide(TaxonomyHints.layer(readonlyHints)));

const hintedRequiresOnlyModel: Effect.Effect<
  Effect.Success<typeof hinted>,
  Errors.TaxonomyError,
  DecisionModel.DecisionModel
> = hintedWithLayer;

void hintedRequiresOnlyModel;

const inheritedHints: typeof hintedRequiresOnlyModel = Taxonomy.classifyRecords(records, oaks, {
  hints: undefined,
});

void inheritedHints;

const hintedScalar = Taxonomy.sameTaxon(name, name, { hints: readonlyHints });

const hintedRelation = TaxonSet.isSubsetOf(oaks, oaks, { hints: readonlyHints });

const inheritedScalar = Taxonomy.sameTaxon(name, name, { hints: undefined });

const inheritedRelation = TaxonSet.isSubsetOf(oaks, oaks, { hints: undefined });

const hintedWithHelpers: typeof hintedRequiresOnlyModel = hinted.pipe(
  TaxonomyHints.withAddedHints(readonlyHints),
  TaxonomyHints.withHints(readonlyHints),
  Effect.updateService(TaxonomyHints.Current, Array.append(contextHint)),
);

void hintedWithHelpers;

void inheritedScalar;

void inheritedRelation;

// @ts-expect-error Scalar hints require validated branded text.
Taxonomy.sameTaxon(name, name, { hints: ["raw"] });

// @ts-expect-error Set-relation hints require validated branded text too.
TaxonSet.isSubsetOf(oaks, oaks, { hints: ["raw"] });

// @ts-expect-error Collection hints cannot bypass the public constructor.
Taxonomy.classifyRecords(records, oaks, { hints: ["raw"] });

// @ts-expect-error Scoped layer inputs also require branded hints.
TaxonomyHints.layer(["raw"]);

// @ts-expect-error Replacement inputs require branded hints.
TaxonomyHints.withHints(["raw"]);

// @ts-expect-error Appended inputs require branded hints.
TaxonomyHints.withAddedHints(["raw"]);

// @ts-expect-error Snapshot inputs require branded hints.
TaxonomyHints.snapshot(["raw"]);

const relation = TaxonSet.isSubsetOf(oaks, TaxonSet.union(oaks, TaxonSet.empty()));

const membership = Taxonomy.recordBelongsTo(specimen, oaks);

const partition = Taxonomy.partitionRecordsByMembership(records, name);

const grouped = Taxonomy.groupRecordsByTaxa(records, [name, oaks]);

const classified = Taxonomy.classifyRecords(records, oaks, { policy });

type Classified = Effect.Success<typeof classified>;

type ClassifiedRow = Classified["records"][number];

type ClassifiedMatch = ClassifiedRow["ranking"][number];

const StoredRecord = Schema.Struct({
  scientificName: TaxonName,
  abundance: Schema.NumberFromString,
});

const StoredTarget = Schema.Struct({
  scientificName: TaxonName,
  assignmentId: Schema.String,
});

const StoredMatch = Taxonomy.TaxonMatch(StoredRecord, StoredTarget);

const storedRecord = Schema.Struct({ abundance: Schema.NumberFromString });

// @ts-expect-error Metadata alone is not a record input.
Taxonomy.TaxonMatch(storedRecord, StoredTarget);

// @ts-expect-error A record label is not a structured target record.
Taxonomy.TaxonMatch(StoredRecord, RecordLabel);

const all = Taxonomy.allRecordsBelongTo(records, oaks);

const some = Taxonomy.anyRecordBelongsTo(records, name);

const none = Taxonomy.noRecordBelongsTo(records, oaks);

// A named assignment retains caller metadata in every returned target record.
const assignment = { scientificName: name, assignmentId: "oak-genus", rank: "genus" } as const;

const assignedOaks = TaxonSet.of(assignment);

const identifiedTarget = {
  taxonId: TaxonId.make({ taxonomy: "ncbi", id: "58334" }),
  source: "reference-panel",
} as const;

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
    if (!Predicate.isTagged(judgment, "MultipleTaxaInTarget")) return undefined;
    const { scientificName, assignmentId, rank } = judgment.target.record;

    return { scientificName, assignmentId, rank };
  }),
);

const assignedSetDiagnostic = assignedSetMembership.pipe(
  Effect.map((judgment) => {
    if (!Predicate.isTagged(judgment, "MultipleTaxaInTarget")) return undefined;
    const { scientificName, assignmentId, rank } = judgment.target.record;

    return { scientificName, assignmentId, rank };
  }),
);

const namedDiagnostic = namedMembership.pipe(
  Effect.map((judgment) => {
    if (!Predicate.isTagged(judgment, "MultipleTaxaInTarget")) return undefined;

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

const unionInputs = [assignedOaks, TaxonSet.of(identifiedTarget)] as const;

const collectedPanel = TaxonSet.unionAll(unionInputs);

const unionIterable: Iterable<TaxonSet.TaxonSet<MixedTarget>> = unionInputs;

const iterablePanel = TaxonSet.unionAll(unionIterable);

const collectedClassification = Taxonomy.classifyRecords(records, collectedPanel);

const emptyCollection = TaxonSet.unionAll([]);

const emptyIterable: Iterable<TaxonSet.TaxonSet<never>> = [TaxonSet.empty()];

const emptyIterableUnion = TaxonSet.unionAll(emptyIterable);

const collectedWithEmpty = TaxonSet.unionAll([TaxonSet.empty(), assignedOaks]);

declare const narrowedDifference: Types.ExtractTag<
  TaxonSet.TaxonSet<typeof assignment>,
  "Difference"
>;

const collectedDifference = TaxonSet.unionAll([narrowedDifference]);

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
  Assert<Equal<Effect.Success<typeof TaxonomyHints.Current>, readonly TaxonomyHint[]>>,
  Assert<Equal<Effect.Success<typeof hintSnapshot>, readonly TaxonomyHint[]>>,
  Assert<Equal<Effect.Error<typeof hintSnapshot>, Errors.InvalidInput>>,
  Assert<Equal<Effect.Services<typeof hintSnapshot>, never>>,
  Assert<Judgment<typeof hintedScalar, Effect.Success<typeof identity>>>,
  Assert<Judgment<typeof hintedRelation, Effect.Success<typeof relation>>>,
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
  Assert<Equal<typeof collectedPanel, TaxonSet.TaxonSet<MixedTarget>>>,
  Assert<Equal<typeof iterablePanel, TaxonSet.TaxonSet<MixedTarget>>>,
  Assert<Equal<typeof emptyCollection, TaxonSet.TaxonSet<never>>>,
  Assert<Equal<typeof emptyIterableUnion, TaxonSet.TaxonSet<never>>>,
  Assert<Equal<typeof collectedWithEmpty, TaxonSet.TaxonSet<typeof assignment>>>,
  Assert<Equal<typeof collectedDifference, TaxonSet.TaxonSet<typeof assignment>>>,
  Assert<
    Equal<
      Effect.Success<
        typeof collectedClassification
      >["records"][number]["taxa"][number]["taxon"]["record"],
      MixedTarget
    >
  >,
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
  Assert<Equal<typeof StoredMatch.fields.record.Type, typeof StoredRecord.Type>>,
  Assert<Equal<typeof StoredMatch.fields.record.Encoded, typeof StoredRecord.Encoded>>,
  Assert<Equal<typeof StoredMatch.fields.taxon.fields.record.Type, typeof StoredTarget.Type>>,
  Assert<Equal<typeof StoredMatch.fields.judgment.Type, TaxonMatchJudgment>>,
  Assert<
    Equal<TaxonMatchJudgment["_tag"], "SameTaxon" | "WithinTaxon" | "NotMatched" | "Undetermined">
  >,
  Assert<Equal<typeof TaxonMatchJudgment.Type, TaxonMatchJudgment>>,
  Assert<
    Equal<
      ClassifiedMatch["answer"],
      Decision.ClassifyAnswer<"sameTaxon" | "withinTaxon" | "noMatch" | "undetermined">
    >
  >,
  Assert<Equal<Classified["usage"], readonly DecisionModel.DecisionUsage[]>>,
  Assert<Equal<Effect.Error<typeof classified>, Errors.TaxonomyError>>,
  Assert<Equal<Effect.Services<typeof classified>, DecisionModel.DecisionModel>>,
  Assert<Equal<Extract<keyof ClassifiedMatch, "support">, never>>,
  Assert<Equal<Types.ExtractTag<TaxonMatchJudgment, "SameTaxon">["support"], number>>,
  Assert<Equal<Types.ExtractTag<TaxonMatchJudgment, "WithinTaxon">["support"], number>>,
  Assert<Equal<Types.ExtractTag<TaxonMatchJudgment, "NotMatched">["support"], number>>,
  Assert<Equal<Types.ExtractTag<TaxonMatchJudgment, "Undetermined">, ExpectedUndetermined>>,
  Assert<Judgment<typeof classifiedVouchers, "A17"[]>>,
  Assert<
    Judgment<typeof rank, RankComparisonJudgment, Errors.TaxonomyError | Errors.TaxonIdQueryError>
  >,
  Assert<
    Judgment<
      typeof ncbiComparison,
      RankComparisonJudgment,
      Errors.TaxonomyError | Errors.TaxonIdQueryError
    >
  >,
  Assert<Judgment<typeof ncbiMembership, TaxonMembershipJudgment<typeof ncbiRecord>>>,
  Assert<Equal<(typeof ncbiTarget)["record"], typeof ncbiRecord>>,
  Assert<Equal<Effect.Services<typeof ncbiPanelMatch>, DecisionModel.DecisionModel>>,
  Assert<Equal<Effect.Services<typeof lookup>, TaxonLookup>>,
  Assert<Equal<Effect.Error<typeof lookup>, Errors.TaxonIdQueryError>>,
  Assert<Equal<RankComparisonJudgment, ExpectedRankComparison>>,
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

export const identityFixture = TaxonIdentityJudgment.cases.SameTaxon.make({});

export const decodeIdentity = Schema.decodeUnknownEffect(TaxonIdentityJudgment);

export const inputHandled = identity.pipe(Effect.catchTag("InvalidInput", (error) => error.cause));

declare const unbrandedInputError: Omit<Errors.InvalidInput, "brand">;

// @ts-expect-error Matching error members without the nominal brand are insufficient.
const nominalInputError: Errors.InvalidInput = unbrandedInputError;

void nominalInputError;

export type ErrorContractChecks = [
  Assert<Equal<Effect.Error<typeof inputHandled>, Schema.SchemaError | AiError.AiError>>,
  Assert<Equal<Errors.InvalidInput["cause"], Schema.SchemaError>>,
  Assert<Equal<Effect.Success<ReturnType<typeof decodeIdentity>>, TaxonIdentityJudgment>>,
];

// @ts-expect-error The schema retains the existing side literals.
export const rejectedIdentity = TaxonIdentityJudgment.cases.MultipleTaxa.make({ side: "neither" });

type OuterDifference = Types.ExtractTag<TaxonSet.TaxonSet, "Difference">;

type InnerDifference = Types.ExtractTag<OuterDifference["right"], "Difference">;

type NestedTaxon = Types.ExtractTag<InnerDifference["right"], "Taxon">;

export type RecursiveNameContract = Assert<
  Equal<NestedTaxon["record"]["scientificName"], TaxonName | undefined>
>;

const unbrandedTarget = UnbrandedDifference.make({ left: oaks, right: oaks });

// @ts-expect-error Membership targets must be constructed expressions.
export const rejectedMembership = Taxonomy.recordBelongsTo(label, unbrandedTarget);

// @ts-expect-error Subset operands must be constructed expressions.
export const rejectedSubset = TaxonSet.isSubsetOf(unbrandedTarget, oaks);

// @ts-expect-error Proper-subset operands must be constructed expressions.
export const rejectedProperSubset = TaxonSet.isProperSubsetOf(oaks, unbrandedTarget);

// @ts-expect-error Equivalence operands must be constructed expressions.
export const rejectedEquivalent = TaxonSet.equivalent(unbrandedTarget, oaks);

// @ts-expect-error Overlap operands must be constructed expressions.
export const rejectedOverlap = TaxonSet.overlaps(oaks, unbrandedTarget);

// @ts-expect-error Disjointness operands must be constructed expressions.
export const rejectedDisjoint = TaxonSet.disjoint(unbrandedTarget, oaks);

// @ts-expect-error Partition targets must be constructed expressions.
export const rejectedPartition = Taxonomy.partitionRecordsByMembership(records, unbrandedTarget);

// @ts-expect-error Each grouping target must be a constructed expression.
export const rejectedGroup = Taxonomy.groupRecordsByTaxa(records, [oaks, unbrandedTarget]);

// @ts-expect-error Universal targets must be constructed expressions.
export const rejectedAll = Taxonomy.allRecordsBelongTo(records, unbrandedTarget);

// @ts-expect-error Existential targets must be constructed expressions.
export const rejectedSome = Taxonomy.anyRecordBelongsTo(records, unbrandedTarget);

// @ts-expect-error Negative existential targets must be constructed expressions.
export const rejectedNone = Taxonomy.noRecordBelongsTo(records, unbrandedTarget);

// Input roles are intentionally distinct even though both brands wrap strings.
// @ts-expect-error A record label is not a whole-taxon name.
export const rejectedTaxonName = TaxonSet.of(label);

// @ts-expect-error A whole-taxon name is not a record operand.
export const rejectedRecord = Taxonomy.recordBelongsTo(name, oaks);

// @ts-expect-error Raw text must not bypass validated record labels.
export const rejectedRawRecord = Taxonomy.recordBelongsTo("unvalidated", name);

// @ts-expect-error Classification panels must be constructed expressions.
export const rejectedClassificationPanel = Taxonomy.classifyRecords(records, unbrandedTarget);

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
