import { Schema, type Data } from "effect";
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
