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

/** Validate identifying record fields while preserving caller JSON metadata. */
export const RecordDocument = Schema.Union([
  Schema.StructWithRest(Schema.Struct({ ...identifyingFields, label: RecordLabel }), [jsonFields]),
  Schema.StructWithRest(Schema.Struct({ ...identifyingFields, scientificName: TaxonName }), [
    jsonFields,
  ]),
  Schema.StructWithRest(Schema.Struct({ ...identifyingFields, taxonId: identifier }), [jsonFields]),
]).annotate({
  identifier: "RecordDocument",
  description: "A taxonomic record with identifying fields and JSON metadata.",
});
/** Describe a decoded identifying record with its caller metadata. */
export type RecordDocument = typeof RecordDocument.Type;

/** Accept an original record label or an identifying record document. */
export const RecordInput = Schema.Union([RecordLabel, RecordDocument]).annotate({
  identifier: "RecordInput",
  description: "A record label or structured taxonomic record.",
});

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

/** Preserve set topology and repeated operands in a JSON-compatible document. */
export const SetDocument = Schema.TaggedUnion({
  Empty: {},
  Taxon: { record: RecordDocument },
  Union: { operands: Schema.TupleWithRest(Schema.Tuple([setNode, setNode]), [setNode]) },
  Intersection: { operands: Schema.Tuple([setNode, setNode]) },
  Difference: { left: setNode, right: setNode },
}).annotate({
  identifier: "SetDocument",
  description: "A taxon set expressed as a tree of set operations.",
});

/** Restore a taxon set from its document tree. */
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
/** Select a supported level of taxonomic classification. */
export const TaxonomicRank = Schema.Literals([
  "domain",
  "kingdom",
  "phylum",
  "class",
  "order",
  "family",
  "genus",
  "species",
]).annotate({ identifier: "TaxonomicRank", description: "A level of taxonomic classification." });
/** Select the relationship to test between two taxon sets. */
export const SetRelation = Schema.Literals([
  "subset",
  "proper-subset",
  "equivalent",
  "overlap",
  "disjoint",
]).annotate({ identifier: "SetRelation", description: "A relationship between two taxon sets." });
const quantifier = Schema.Literals(["all", "any", "none"]);
const taxonDocument = SetDocument.cases.Taxon;

/** Describe whether two taxonomic assignments identify the same taxon. */
export const IdentityJudgment = Schema.TaggedUnion({
  SameTaxon: {},
  DifferentTaxa: {},
  Undetermined: {},
  MultipleTaxa: { side },
}).annotate({ identifier: "IdentityJudgment", description: "A judgment about taxon identity." });

/** Describe whether one taxon's organisms belong to another taxon. */
export const ContainmentJudgment = Schema.TaggedUnion({
  Contained: {},
  PartlyContained: {},
  Disjoint: {},
  NotContained: {},
  Undetermined: {},
  MultipleTaxa: { side },
}).annotate({
  identifier: "ContainmentJudgment",
  description: "A judgment about taxon containment.",
});

/** Describe a comparison at a selected taxonomic rank. */
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
}).annotate({
  identifier: "RankJudgment",
  description: "A judgment about taxa at a selected rank.",
});

/** Describe the answer and any clarification taxon for a set relation. */
export const SetRelationJudgment = Schema.TaggedUnion({
  Yes: { relation: SetRelation },
  No: { relation: SetRelation },
  Undetermined: { relation: SetRelation },
  MultipleTaxaInSet: {
    relation: SetRelation,
    side: Schema.Literals(["left", "right"]),
    taxon: taxonDocument,
  },
}).annotate({
  identifier: "SetRelationJudgment",
  description: "A judgment about a taxon set relationship.",
});

/** Describe the answer to an all, any or none membership question. */
export const QuantifierJudgment = Schema.TaggedUnion({
  Yes: { quantifier },
  No: { quantifier },
  Undetermined: { quantifier },
  MultipleTaxaInTarget: { quantifier, target: taxonDocument },
}).annotate({
  identifier: "QuantifierJudgment",
  description: "An all, any or none membership judgment.",
});

/** Describe a record's membership judgment and any clarification target. */
export const MembershipJudgment = Schema.TaggedUnion({
  Member: {},
  NotMember: {},
  MixedMembership: {},
  Undetermined: {},
  MultipleTaxaInTarget: { target: taxonDocument },
}).annotate({
  identifier: "MembershipJudgment",
  description: "A judgment about taxon set membership.",
});

/** Preserve membership buckets, record occurrences and clarification targets. */
export const MembershipPartition = Schema.Struct({
  Member: Schema.Array(RecordInput),
  NotMember: Schema.Array(RecordInput),
  MixedMembership: Schema.Array(RecordInput),
  Undetermined: Schema.Array(RecordInput),
  MultipleTaxaInTarget: Schema.Array(Schema.Struct({ record: RecordInput, target: taxonDocument })),
}).annotate({
  identifier: "MembershipPartition",
  description: "Records grouped by taxon set membership judgment.",
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
/** Preserve the panel, record outcomes, accepted rankings, model answers and usage. */
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
}).annotate({
  identifier: "Classification",
  description: "Panel classification results, rankings, and decision usage.",
});
