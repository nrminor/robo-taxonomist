import { expect, it } from "@effect/vitest";
import { Schema } from "effect";
import {
  RankComparisonPolicy,
  RecordLabel,
  TaxonId,
  TaxonomicRecord,
  TaxonName,
} from "../src/index.ts";

it("constructs a scientific-name-only record without inventing a label", () => {
  const scientificName = TaxonName.make("  Quercus robur\t");
  const record = TaxonomicRecord.make({ scientificName });

  expect(record).toEqual({ scientificName });
});

it("constructs an identifier-only record without a label or invented release", () => {
  const record = TaxonomicRecord.make({
    taxonId: TaxonId.make({ taxonomy: "ncbi", id: "9606" }),
  });

  expect(record).toEqual({ taxonId: { taxonomy: "ncbi", id: "9606" } });
});

it("constructs a label-only record without inventing a taxonomic assignment", () => {
  const record = TaxonomicRecord.make({ label: RecordLabel.make("Voucher A17") });

  expect(record).toEqual({ label: "Voucher A17" });
});

it("retains supplied names, labels, and release-scoped assignments together", () => {
  const record = TaxonomicRecord.make({
    label: RecordLabel.make("Voucher A17 | Quercus robur"),
    scientificName: TaxonName.make("Quercus petraea"),
    taxonId: TaxonId.make({ taxonomy: "example-taxonomy", id: "oak-17", release: "2026-01" }),
  });

  expect(record).toEqual({
    label: "Voucher A17 | Quercus robur",
    scientificName: "Quercus petraea",
    taxonId: { taxonomy: "example-taxonomy", id: "oak-17", release: "2026-01" },
  });
});

it("rejects unknown metadata with no description or assignment", () => {
  expect(() => Schema.decodeUnknownSync(TaxonomicRecord)({})).toThrow();
});

it.each([
  { taxonomy: " ", id: "9606" },
  { taxonomy: "ncbi", id: "" },
  { taxonomy: "ncbi", id: "9606", release: "\t" },
])("rejects blank identifier scope, value, or supplied release %j", (assignment) => {
  expect(() => TaxonId.make(assignment)).toThrow();
});

it.each([
  { minimumSupport: -0.1, minimumMargin: 0 },
  { minimumSupport: 1.1, minimumMargin: 0 },
  { minimumSupport: Number.NaN, minimumMargin: 0 },
  { minimumSupport: 0.5, minimumMargin: -0.1 },
  { minimumSupport: 0.5, minimumMargin: 1.1 },
  { minimumSupport: 0.5, minimumMargin: Number.POSITIVE_INFINITY },
])("rejects invalid acceptance thresholds %j", (policy) => {
  expect(() => RankComparisonPolicy.make(policy)).toThrow();
});
