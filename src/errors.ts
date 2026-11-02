import * as AiError from "effect/ai/AiError";
import * as Schema from "effect/Schema";

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
export class InvalidInput extends Schema.TaggedError<InvalidInput>()("InvalidInput", {
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
