import * as AiError from "effect/ai/AiError";
import * as HttpClientError from "effect/http/HttpClientError";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import { TaxonId, TaxonSource } from "./schemas.ts";

/**
 * Inspect the original schema issue when a supplied taxonomic input fails validation.
 * The cause is retained in process and can contain input values; choose public diagnostics separately.
 *
 * @category errors
 * @since 0.4.0
 * @example
 * import { Effect } from "effect";
 * import { TaxonName, Taxonomy } from "robo-taxonomist";
 * export const checked = Taxonomy.sameTaxon(
 *   { taxonId: { taxonomy: "ncbi", id: "" } }, TaxonName.make("Quercus"),
 * ).pipe(Effect.catchTag("InvalidInput", error => Effect.succeed(error.cause.issue)));
 */
export class InvalidInput extends Schema.TaggedError<
  InvalidInput,
  { readonly brand: unique symbol }
>()("InvalidInput", {
  cause: Schema.declare(Schema.isSchemaError),
}) {
  /**
   * Preserve a schema failure when converting it to a library input failure.
   *
   * @category constructors
   * @since 0.4.0
   */
  static from(this: void, cause: Schema.SchemaError): InvalidInput {
    return new InvalidInput({ cause });
  }
}

/**
 * Recognize library input failures and unchanged model-interface failures in process.
 * Use an application-owned schema to serialize allowlisted diagnostics for clients.
 *
 * @category errors
 * @since 0.4.0
 */
export const TaxonomyError = Schema.Union([InvalidInput, Schema.toType(AiError.AiError)]);

/**
 * Describe the typed failure channel of model-backed taxonomy operations.
 *
 * @category errors
 * @since 0.4.0
 */
export type TaxonomyError = typeof TaxonomyError.Type;

/** Report an ID that the configured taxonomy or release cannot serve. */
export class TaxonSourceMismatch extends Schema.TaggedError<
  TaxonSourceMismatch,
  { readonly brand: unique symbol }
>()("TaxonSourceMismatch", { requested: TaxonId, provided: TaxonSource }) {}

/** Provide a fixed taxonomy view to run a check that needs more than one query. */
export class TaxonSnapshotRequired extends Schema.TaggedError<
  TaxonSnapshotRequired,
  { readonly brand: unique symbol }
>()("TaxonSnapshotRequired", {
  source: TaxonSource.cases.Live,
}) {}

/** Inspect the native HTTP failure from a taxonomy query. */
export class TaxonRequestError extends Schema.TaggedError<
  TaxonRequestError,
  { readonly brand: unique symbol }
>()("TaxonRequestError", {
  source: TaxonSource,
  cause: Schema.declare(HttpClientError.isHttpClientError),
}) {}

/** Inspect the schema issue in a provider's response. */
export class InvalidTaxonResponse extends Schema.TaggedError<
  InvalidTaxonResponse,
  { readonly brand: unique symbol }
>()("InvalidTaxonResponse", { source: TaxonSource, cause: Schema.declare(Schema.isSchemaError) }) {}

/** Match the typed failures common to the lookup query methods. */
export const TaxonQueryError = Schema.Union([
  InvalidInput,
  TaxonRequestError,
  InvalidTaxonResponse,
]);
/** The typed errors common to lookup queries. */
export type TaxonQueryError = typeof TaxonQueryError.Type;

/** Match query failures, including an ID outside the configured taxonomy view. */
export const TaxonIdQueryError = Schema.Union([TaxonQueryError, TaxonSourceMismatch]);
/** The typed errors of an ID lookup. */
export type TaxonIdQueryError = typeof TaxonIdQueryError.Type;

/** Inspect the native failure while reading a taxonomy snapshot file. */
export class TaxonSnapshotReadError extends Schema.TaggedError<
  TaxonSnapshotReadError,
  { readonly brand: unique symbol }
>()("TaxonSnapshotReadError", {
  path: Schema.String,
  cause: Schema.declare(PlatformError.isPlatformError),
}) {}

/** Locate a malformed snapshot row and inspect its original schema issue. */
export class InvalidTaxonSnapshot extends Schema.TaggedError<
  InvalidTaxonSnapshot,
  { readonly brand: unique symbol }
>()("InvalidTaxonSnapshot", {
  path: Schema.String,
  line: Schema.optionalKey(Schema.Int),
  cause: Schema.declare(Schema.isSchemaError),
}) {}

const ncbiTaxonStatus = Schema.Literals(["current", "merged", "deleted"]);

/** Match NCBI dump consistency issues and inspect their offending identifiers. */
export const NcbiDumpIssue = Schema.TaggedUnion({
  DuplicateTaxonNode: { id: Schema.String, path: Schema.String, line: Schema.Int },
  NameWithoutTaxon: { id: Schema.String, path: Schema.String, line: Schema.Int },
  InvalidRoot: { parentId: Schema.optionalKey(Schema.String) },
  MissingTaxonParent: { id: Schema.String, parentId: Schema.String },
  ParentCycle: { id: Schema.String },
  MissingMergeTarget: { id: Schema.String, targetId: Schema.String },
  ConflictingMergeTargets: {
    id: Schema.String,
    first: Schema.String,
    second: Schema.String,
    path: Schema.String,
    line: Schema.Int,
  },
  ConflictingTaxonStatus: {
    id: Schema.String,
    existing: ncbiTaxonStatus,
    incoming: ncbiTaxonStatus,
  },
  ScientificNameCount: {
    id: Schema.String,
    count: Schema.Int,
    path: Schema.String,
    line: Schema.optionalKey(Schema.Int),
  },
});

/** Inspect a cross-row inconsistency that prevents using an NCBI snapshot. */
export class InconsistentNcbiDump extends Schema.TaggedError<
  InconsistentNcbiDump,
  { readonly brand: unique symbol }
>()("InconsistentNcbiDump", {
  directory: Schema.String,
  release: TaxonId.fields.release,
  reason: NcbiDumpIssue,
}) {}
