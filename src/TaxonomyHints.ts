import * as Array from "effect/Array";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Errors from "./errors.ts";

/**
 * Supply scoped taxonomic context to model-backed questions. Defaults to no hints.
 * A call's `hints` option replaces the scoped collection; [] disables hints for that call.
 * Omit the option or use undefined to inherit the current scope.
 *
 * @category models
 * @since 0.6.0
 * @example
 * import { Array, Effect } from "effect";
 * import { TaxonomyHints } from "robo-taxonomist";
 * export const focused = Effect.updateService(
 *   TaxonomyHints, Array.append("Quercus belongs to Fagaceae."),
 * );
 */
export const TaxonomyHints = Context.Reference<ReadonlyArray<string>>(
  "robo-taxonomist/TaxonomyHints",
  { defaultValue: () => [] },
);

/**
 * Supply a copied collection of hints to an Effect workflow. Model-backed operations
 * snapshot the selected hints when they run. Hints are contextual priors; judgments
 * still follow the existing acceptance policy.
 *
 * @category constructors
 * @since 0.6.0
 * @example
 * import { Effect } from "effect";
 * import { RecordLabel, TaxonName, Taxonomy, taxonomyHintsLayer } from "robo-taxonomist";
 * const hints = taxonomyHintsLayer(["Quercus belongs to Fagaceae."]);
 * export const question = Taxonomy.recordBelongsTo(
 *   RecordLabel.make("oak specimen"), TaxonName.make("Fagaceae"),
 * ).pipe(Effect.provide(hints));
 */
export const taxonomyHintsLayer = (hints: ReadonlyArray<string>) =>
  Layer.succeed(TaxonomyHints, Array.copy(hints));

/**
 * Select explicit hints or the current scope, then validate a private snapshot.
 * An explicit empty collection overrides the scope. Text is preserved unchanged.
 *
 * @internal
 */
export const resolve = Effect.fnUntraced(function* (explicit?: ReadonlyArray<string>) {
  const inherited = yield* TaxonomyHints;
  const selected = explicit === undefined ? inherited : explicit;
  const snapshot = Array.isArray(selected) ? Array.copy(selected) : selected;
  return yield* Schema.encodeUnknownEffect(Schema.Array(Schema.String))(snapshot).pipe(
    Effect.mapError(Errors.InvalidInput.from),
  );
});

/**
 * Format hints for scalar decision instructions, or return no additional text.
 *
 * @internal
 */
export const instruction = (hints: ReadonlyArray<string>) =>
  hints.length === 0 ? "" : `\nUse these taxonomic hints as background: ${JSON.stringify(hints)}`;
