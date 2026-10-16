import { describe, expect, it } from "@effect/vitest";
import { Effect, SchemaIssue } from "effect";
import { RecordLabel, TaxonName, Taxonomy } from "../src/index.ts";

describe.each([
  { name: "RecordLabel", schema: RecordLabel, expected: "a nonblank record label" },
  { name: "TaxonName", schema: TaxonName, expected: "a nonblank taxon name" },
])("$name", ({ schema, expected }) => {
  it.each(["", " ", "\t", "\n\r", " \t\n ", "\u00a0", "\u2003", "\u3000"])(
    "rejects blank text %j",
    (text) => {
      expect(() => schema.make(text)).toThrow();
    },
  );

  it.each([
    "Quercus robur",
    "  Quercus robur\t",
    "Voucher A17 | Quercus robur\n",
    "unresolved description",
    "é",
    "e\u0301",
  ])("preserves accepted text %j", (text) => {
    expect(schema.make(text)).toBe(text);
  });

  it.effect("retains a domain-specific validation issue", () =>
    Effect.gen(function* () {
      const issue = yield* Effect.flip<RecordLabel | TaxonName, SchemaIssue.Issue, never>(
        schema.makeEffect(" \t"),
      );
      expect(SchemaIssue.makeFormatterDefault()(issue)).toContain(expected);
    }),
  );
});

describe("Taxonomy.sameLabel", () => {
  it.each([
    ["Voucher A17 | Quercus robur", "Voucher A17 | Quercus robur", true],
    ["Voucher A17 | Quercus robur", "Voucher B42 | Quercus robur", false],
    ["Quercus robur", "quercus robur", false],
    ["Quercus robur", " Quercus robur", false],
    ["Quercus robur", "Quercus robur\n", false],
    ["é", "e\u0301", false],
  ])("compares %j and %j literally", (left, right, expected) => {
    expect(Taxonomy.sameLabel(RecordLabel.make(left), RecordLabel.make(right))).toBe(expected);
  });
});
