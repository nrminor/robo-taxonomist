import * as Array from "effect/Array";
import * as Match from "effect/Match";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import {
  CollectionExecution,
  RecordLabel,
  TaxonomicRecord,
  type TaxonName,
  type TaxonomyHint,
} from "../schemas.ts";

/** Validate the record inputs accepted by taxonomy comparisons and classifications. */
export const recordInputSchema = Schema.Union([RecordLabel, TaxonomicRecord]);

/** Record input shared by taxonomy comparisons, membership, and classification. */
export type RecordInput = typeof recordInputSchema.Type;

/** Default batching used by taxonomy collection operations. */
export const defaultCollectionExecution = CollectionExecution.make({
  batchSize: 16,
  concurrency: 1,
});

/** Treat a supplied taxon name as a scientific-name record. */
export const asTaxonomicRecord = (input: TaxonName | TaxonomicRecord): TaxonomicRecord =>
  Predicate.isString(input) ? { scientificName: input } : input;

const encodeHints = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));

/** Format a prompt suffix for nonempty hints, preserving their supplied order. */
export const hintsInstruction = (hints: ReadonlyArray<TaxonomyHint>) =>
  Array.match(hints, {
    onEmpty: () => "",
    onNonEmpty: (nonempty) => `\nUse these taxonomic hints as background: ${encodeHints(nonempty)}`,
  });

const quoteText = Schema.encodeSync(Schema.fromJsonString(Schema.String));

const describeField = (name: string, value: string | undefined) =>
  Match.value(value).pipe(
    Match.when(Match.string, (text) => [`${name}: ${quoteText(text)}`]),
    Match.orElse(() => []),
  );

/** Format encoded records for the taxonomy comparison and classification prompts. */
export const describeRecord = (record: typeof recordInputSchema.Encoded): string => {
  if (Predicate.isString(record)) {
    return `Record label: ${quoteText(record)}`;
  }

  return [
    ...describeField("Record label", record.label),
    ...describeField("Scientific name", record.scientificName),
    ...describeField("Taxonomy", record.taxonId?.taxonomy),
    ...describeField("Taxon ID", record.taxonId?.id),
    ...describeField("Taxonomy release", record.taxonId?.release),
  ].join("\n");
};
