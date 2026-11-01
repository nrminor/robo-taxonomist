import { Schema, type Data } from "effect";
import { DecisionModel } from "effect/ai";
import { RecordLabel, TaxonId, TaxonName, TaxonSet } from "robo-taxonomist";

const jsonFields = Schema.Record(Schema.String, Schema.Json);
const identifier = Schema.StructWithRest(TaxonId, [jsonFields]);
const identifyingFields = {
  label: Schema.optionalKey(RecordLabel),
  scientificName: Schema.optionalKey(TaxonName),
  taxonId: Schema.optionalKey(identifier),
};

export const RecordDocument = Schema.Union([
  Schema.StructWithRest(Schema.Struct({ ...identifyingFields, label: RecordLabel }), [jsonFields]),
  Schema.StructWithRest(Schema.Struct({ ...identifyingFields, scientificName: TaxonName }), [
    jsonFields,
  ]),
  Schema.StructWithRest(Schema.Struct({ ...identifyingFields, taxonId: identifier }), [jsonFields]),
]);
export type RecordDocument = typeof RecordDocument.Type;

export const RecordInput = Schema.Union([RecordLabel, RecordDocument]);

type SetNode<R> = Data.TaggedEnum<{
  Empty: {};
  Taxon: { readonly record: R };
  Union: { readonly operands: readonly [SetNode<R>, SetNode<R>, ...SetNode<R>[]] };
  Intersection: { readonly operands: readonly [SetNode<R>, SetNode<R>] };
  Difference: { readonly left: SetNode<R>; readonly right: SetNode<R> };
}>;

const setNode: Schema.Codec<
  SetNode<RecordDocument>,
  SetNode<typeof RecordDocument.Encoded>
> = Schema.suspend(() => SetDocument);

export const SetDocument = Schema.TaggedUnion({
  Empty: {},
  Taxon: { record: RecordDocument },
  Union: { operands: Schema.TupleWithRest(Schema.Tuple([setNode, setNode]), [setNode]) },
  Intersection: { operands: Schema.Tuple([setNode, setNode]) },
  Difference: { left: setNode, right: setNode },
});

export const restoreSet = (document: typeof SetDocument.Type): TaxonSet.TaxonSet<RecordDocument> =>
  SetDocument.match(document, {
    Empty: () => TaxonSet.empty(),
    Taxon: ({ record }) => TaxonSet.of(record),
    Union: ({ operands }) => TaxonSet.unionAll(operands.map(restoreSet)),
    Intersection: ({ operands: [left, right] }) =>
      TaxonSet.intersection(restoreSet(left), restoreSet(right)),
    Difference: ({ left, right }) => TaxonSet.difference(restoreSet(left), restoreSet(right)),
  });

const side = Schema.Literals(["left", "right", "both"]);
export const TaxonomicRank = Schema.Literals([
  "domain",
  "kingdom",
  "phylum",
  "class",
  "order",
  "family",
  "genus",
  "species",
]);
export const SetRelation = Schema.Literals([
  "subset",
  "proper-subset",
  "equivalent",
  "overlap",
  "disjoint",
]);
const quantifier = Schema.Literals(["all", "any", "none"]);
const taxonDocument = SetDocument.cases.Taxon;

export const IdentityJudgment = Schema.TaggedUnion({
  SameTaxon: {},
  DifferentTaxa: {},
  Undetermined: {},
  MultipleTaxa: { side },
});

export const ContainmentJudgment = Schema.TaggedUnion({
  Contained: {},
  PartlyContained: {},
  Disjoint: {},
  NotContained: {},
  Undetermined: {},
  MultipleTaxa: { side },
});

export const RankJudgment = Schema.TaggedUnion({
  SameTaxonAtRank: { rank: TaxonomicRank },
  SameMultipleTaxaAtRank: { rank: TaxonomicRank },
  SameTaxaAtRank: { rank: TaxonomicRank },
  LeftTaxaWithinRightAtRank: { rank: TaxonomicRank },
  RightTaxaWithinLeftAtRank: { rank: TaxonomicRank },
  PartlySharedTaxaAtRank: { rank: TaxonomicRank },
  NoSharedTaxaAtRank: { rank: TaxonomicRank },
  DifferentTaxaAtRank: { rank: TaxonomicRank },
  Undetermined: { rank: TaxonomicRank },
  MultipleTaxaAtRank: { rank: TaxonomicRank, side },
});

export const SetRelationJudgment = Schema.TaggedUnion({
  Yes: { relation: SetRelation },
  No: { relation: SetRelation },
  Undetermined: { relation: SetRelation },
  MultipleTaxaInSet: {
    relation: SetRelation,
    side: Schema.Literals(["left", "right"]),
    taxon: taxonDocument,
  },
});

export const QuantifierJudgment = Schema.TaggedUnion({
  Yes: { quantifier },
  No: { quantifier },
  Undetermined: { quantifier },
  MultipleTaxaInTarget: { quantifier, target: taxonDocument },
});

export const MembershipJudgment = Schema.TaggedUnion({
  Member: {},
  NotMember: {},
  MixedMembership: {},
  Undetermined: {},
  MultipleTaxaInTarget: { target: taxonDocument },
});

export const MembershipPartition = Schema.Struct({
  Member: Schema.Array(RecordInput),
  NotMember: Schema.Array(RecordInput),
  MixedMembership: Schema.Array(RecordInput),
  Undetermined: Schema.Array(RecordInput),
  MultipleTaxaInTarget: Schema.Array(Schema.Struct({ record: RecordInput, target: taxonDocument })),
});

const probability = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 }));
const classificationAnswer = Schema.Struct({
  label: Schema.Literals(["sameTaxon", "withinTaxon", "noMatch", "undetermined"]),
  probabilities: Schema.Struct({
    sameTaxon: probability,
    withinTaxon: probability,
    noMatch: probability,
    undetermined: probability,
  }),
  confidence: Schema.optionalKey(probability),
});
const taxonMatch = Schema.Struct({
  record: RecordInput,
  taxon: taxonDocument,
  support: probability,
  judgment: Schema.TaggedUnion({ Matched: {}, NotMatched: {}, Undetermined: {} }),
  answer: classificationAnswer,
});
export const Classification = Schema.Struct({
  panel: SetDocument,
  records: Schema.Array(
    Schema.Struct({
      record: RecordInput,
      taxa: Schema.Array(taxonMatch),
      ranking: Schema.Array(taxonMatch),
    }),
  ),
  usage: Schema.Array(Schema.Struct(DecisionModel.DecisionUsage.fields)),
});
