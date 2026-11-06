/**
 * Inspect and configure scoped taxonomic hints using the public context operations.
 *
 * @category modules
 * @since 0.6.0
 */
import * as Array from "effect/Array";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Errors from "./errors.ts";
import * as Inputs from "./schemas.ts";

/**
 * Inspect the hints in the current Effect scope. Defaults to no hints.
 * A call's `hints` option replaces the scoped collection; [] disables hints for that call.
 * Omit the option or use undefined to inherit the current scope. Direct call options
 * leave Current unchanged.
 *
 * @category models
 * @since 0.6.0
 * @example
 * import { Array, Effect } from "effect";
 * import { TaxonomyHint, TaxonomyHints } from "robo-taxonomist";
 * const placement = TaxonomyHint.make("Quercus belongs to Fagaceae.");
 * export const focused = Effect.updateService(
 *   TaxonomyHints.Current, Array.append(placement),
 * );
 */
export const Current = Context.Reference<ReadonlyArray<Inputs.TaxonomyHint>>(
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
 * import { RecordLabel, TaxonName, Taxonomy, TaxonomyHint, TaxonomyHints } from "robo-taxonomist";
 * const placement = TaxonomyHint.make("Quercus belongs to Fagaceae.");
 * const hints = TaxonomyHints.layer([placement]);
 * export const question = Taxonomy.recordBelongsTo(
 *   RecordLabel.make("oak specimen"), TaxonName.make("Fagaceae"),
 * ).pipe(Effect.provide(hints));
 */
export const layer = (hints: ReadonlyArray<Inputs.TaxonomyHint>) =>
  Layer.succeed(Current, Array.copy(hints));

/**
 * Replace hints for a wrapped Effect. Pass [] to disable inherited hints in that scope.
 * Copies the supplied collection when this combinator is constructed. Direct call
 * options still take precedence, and the surrounding scope is unchanged.
 *
 * @category providing services
 * @since 0.6.0
 * @example
 * import { RecordLabel, TaxonName, Taxonomy, TaxonomyHint, TaxonomyHints } from "robo-taxonomist";
 * const placement = TaxonomyHint.make("Quercus belongs to Fagaceae.");
 * export const question = Taxonomy.recordBelongsTo(
 *   RecordLabel.make("oak specimen"), TaxonName.make("Fagaceae"),
 * ).pipe(TaxonomyHints.withHints([placement]));
 */
export const withHints = (hints: ReadonlyArray<Inputs.TaxonomyHint>) =>
  Effect.provideService(Current, Array.copy(hints));

/**
 * Append hints to the inherited collection for a wrapped Effect, preserving order and repeats.
 * Copies the additions when this combinator is constructed and reads inherited hints
 * when the Effect runs. Direct call options still take precedence; outer hints are unchanged.
 *
 * @category providing services
 * @since 0.6.0
 * @example
 * import { RecordLabel, TaxonName, Taxonomy, TaxonomyHint, TaxonomyHints } from "robo-taxonomist";
 * const placement = TaxonomyHint.make("Quercus belongs to Fagaceae.");
 * export const question = Taxonomy.recordBelongsTo(
 *   RecordLabel.make("oak specimen"), TaxonName.make("Fagaceae"),
 * ).pipe(TaxonomyHints.withAddedHints([placement]));
 */
export const withAddedHints = (hints: ReadonlyArray<Inputs.TaxonomyHint>) => {
  const additions = Array.copy(hints);
  return Effect.updateService(Current, Array.appendAll(additions));
};

/**
 * Select explicit hints or the current scope, then copy and validate them when the Effect runs.
 * Omit the argument or use undefined to inherit; an explicit [] disables inheritance.
 * The independent collection preserves text, order and repeats. Invalid hints fail with InvalidInput.
 *
 * @category constructors
 * @since 0.6.0
 * @example
 * import { TaxonomyHint, TaxonomyHints } from "robo-taxonomist";
 * const placement = TaxonomyHint.make("Quercus belongs to Fagaceae.");
 * export const captured = TaxonomyHints.snapshot().pipe(TaxonomyHints.withHints([placement]));
 */
export const snapshot = Effect.fnUntraced(function* (
  explicit?: ReadonlyArray<Inputs.TaxonomyHint>,
) {
  const inherited = yield* Current;
  const selected = explicit === undefined ? inherited : explicit;
  const copied = Array.isArray(selected) ? Array.copy(selected) : selected;
  return yield* Schema.decodeUnknownEffect(Schema.Array(Inputs.TaxonomyHint))(copied).pipe(
    Effect.mapError(Errors.InvalidInput.from),
  );
});
