import { expect, it } from "vitest";
import { Schema } from "effect";
import {
  RankComparisonJudgment,
  TaxonContainmentJudgment,
  TaxonName,
  TaxonomicRank,
  TaxonSet,
  TaxonSetRelation,
  CollectionMembershipJudgment,
  TaxonMembershipJudgment,
  TaxonSetRelationJudgment,
} from "../src/index.ts";

it("exposes fixed rank, containment and relation schemas", () => {
  expect(Schema.is(TaxonomicRank)("genus")).toBe(true);
  expect(Schema.is(TaxonomicRank)("variety")).toBe(false);
  expect(Schema.is(TaxonSetRelation)("proper-subset")).toBe(true);
  expect(
    RankComparisonJudgment.cases.MultipleTaxaAtRank.make({ rank: "species", side: "both" }),
  ).toEqual({
    _tag: "MultipleTaxaAtRank",
    rank: "species",
    side: "both",
  });
  expect(TaxonContainmentJudgment.cases.Contained.make({})).toEqual({ _tag: "Contained" });
});

it("preserves original nodes and records when constructing judgments", () => {
  const record = { scientificName: TaxonName.make("Quercus"), sample: 42 };
  const node = TaxonSet.of(record);
  const membership = TaxonMembershipJudgment.cases.MultipleTaxaInTarget.make({
    target: node,
  });
  const collection = CollectionMembershipJudgment.cases.MultipleTaxaInTarget.make({
    quantifier: "all",
    target: node,
  });
  const relation = TaxonSetRelationJudgment.cases.MultipleTaxaInSet.make({
    relation: "subset",
    side: "left",
    taxon: node,
  });
  expect(membership.target).toBe(node);
  expect(collection.target).toBe(node);
  expect(relation.taxon).toBe(node);
  expect(membership.target.record).toBe(record);
  expect(collection.target.record).toBe(record);
  expect(relation.taxon.record).toBe(record);
});

it("carries rank and relation documentation into nested judgment schemas", () => {
  expect(
    Schema.toJsonSchemaDocument(RankComparisonJudgment).definitions.TaxonomicRank,
  ).toMatchObject({
    description: "A level of taxonomic classification.",
  });
  expect(
    Schema.toJsonSchemaDocument(TaxonSetRelationJudgment).definitions.SetRelation,
  ).toMatchObject({
    description: "A relationship between two taxon sets.",
  });
});

it("encodes native taxon payloads without extra metadata", () => {
  const record = {
    scientificName: TaxonName.make("Quercus"),
    sample: 42,
    hidden: () => "not JSON",
  };
  const node = TaxonSet.of(record);
  const encodedNode = { _tag: "Taxon", record: { scientificName: "Quercus" } };
  expect(
    Schema.encodeSync(TaxonMembershipJudgment)({ _tag: "MultipleTaxaInTarget", target: node }),
  ).toEqual({ _tag: "MultipleTaxaInTarget", target: encodedNode });
  expect(
    Schema.encodeSync(CollectionMembershipJudgment)({
      _tag: "MultipleTaxaInTarget",
      quantifier: "any",
      target: node,
    }),
  ).toEqual({ _tag: "MultipleTaxaInTarget", quantifier: "any", target: encodedNode });
  expect(
    Schema.encodeSync(TaxonSetRelationJudgment)({
      _tag: "MultipleTaxaInSet",
      relation: "overlap",
      side: "right",
      taxon: node,
    }),
  ).toEqual({ _tag: "MultipleTaxaInSet", relation: "overlap", side: "right", taxon: encodedNode });
  expect(node.record).toBe(record);
  expect(node.record.sample).toBe(42);
  expect(node.record.hidden()).toBe("not JSON");
});
