import * as Array from "effect/Array";
import * as Predicate from "effect/Predicate";
import {
  Difference,
  Intersection,
  Taxon,
  TaxonName,
  Union,
  taxonSetSchema,
  type Expression,
  type TaxonomicRecord,
} from "./schemas.ts";

/**
 * Inspect the supplied record on a taxon entry returned by TaxonSet.of.
 *
 * @category models
 * @since 0.3.0
 */
export type { Taxon } from "./schemas.ts";

/**
 * TaxonSet constructors return this type to describe a set of organisms.
 * Each value records how the set was built from taxonomic records and set operations.
 * Syntax is preserved without automatic normalization or simplification.
 * You can use Match.tagsExhaustive to examine each expression.
 *
 * @category models
 * @since 0.1.0
 * @example
 * import { Match } from "effect";
 * import { TaxonSet } from "robo-taxonomist";
 * export const describe = (set: TaxonSet.TaxonSet) => Match.value(set).pipe(
 *   Match.tagsExhaustive({
 *     Empty: () => "The set is empty.",
 *     Taxon: ({ record }) => `The expression identifies ${record.scientificName ?? record.label ?? record.taxonId?.id}.`,
 *     Union: ({ operands }) => `The union combines ${operands.length} expressions.`,
 *     Intersection: ({ operands }) => `The intersection combines ${operands.length} expressions.`,
 *     Difference: () => "The expression subtracts the right set from the left.",
 *   }),
 * );
 */
export type TaxonSet<R extends TaxonomicRecord = TaxonomicRecord> = Expression<R>;

/**
 * Build a fresh literal empty set.
 *
 * @category constructors
 * @since 0.1.0
 * @example
 * import { TaxonSet } from "robo-taxonomist";
 * export const none = TaxonSet.empty();
 */
export const empty = (): TaxonSet<never> => taxonSetSchema.cases.Empty.make({});

/**
 * Build an expression for organisms belonging to the taxon identified by a name or record.
 * To combine several taxa, build each expression separately and use TaxonSet.unionAll.
 * Preserve the supplied record and its identifying fields without normalization.
 *
 * @category constructors
 * @since 0.1.0
 * @example
 * import { TaxonName, TaxonSet } from "robo-taxonomist";
 * export const oaks = TaxonSet.of(TaxonName.make("Quercus"));
 */
export function of(name: TaxonName): Taxon<{ readonly scientificName: TaxonName }>;
export function of<R extends TaxonomicRecord>(record: R): Taxon<R>;
export function of(input: TaxonName | TaxonomicRecord): Taxon {
  return new Taxon({ record: Predicate.isString(input) ? { scientificName: input } : input });
}

/**
 * Build a union expression for organisms in either input set.
 * Retain the original children in supplied order.
 * Child references and repeated occurrences are preserved, without simplification.
 *
 * @category constructors
 * @since 0.1.0
 * @example
 * import { TaxonName, TaxonSet } from "robo-taxonomist";
 * const oaks = TaxonSet.of(TaxonName.make("Quercus"));
 * const beeches = TaxonSet.of(TaxonName.make("Fagus"));
 * export const trees = TaxonSet.union(oaks, beeches);
 */
export const union = <A extends TaxonomicRecord, B extends TaxonomicRecord>(
  left: TaxonSet<A>,
  right: TaxonSet<B>,
): TaxonSet<A | B> => new Union<A | B>({ operands: [left, right] });

type RecordOfSet<S> = S extends TaxonSet<never> ? never : S extends TaxonSet<infer R> ? R : never;

/**
 * Build a union from a finite iterable of set expressions without nesting a binary union per item.
 * An empty iterable produces a fresh empty set; a singleton returns its original expression.
 * Otherwise, create one union with the supplied expressions as its direct children.
 * Consume the iterable eagerly once and copy its operand container, retaining child references,
 * supplied order, repeated occurrences, metadata and nesting without simplification.
 * Records and child expressions are shared, not cloned or frozen.
 *
 * @category constructors
 * @since 0.4.0
 * @example
 * import { TaxonName, TaxonSet } from "robo-taxonomist";
 * const targets = ["Quercus", "Fagus", "Betula"].map((name) =>
 *   TaxonSet.of(TaxonName.make(name)),
 * );
 * export const trees = TaxonSet.unionAll(targets);
 */
export function unionAll<S extends TaxonSet>(sets: Iterable<S>): TaxonSet<RecordOfSet<S>>;
export function unionAll(sets: Iterable<TaxonSet>): TaxonSet {
  const operands = [...sets];

  if (!Array.isArrayNonEmpty(operands)) return empty();

  if (operands.length === 1) return operands[0];

  return new Union({ operands });
}

/**
 * Build an intersection expression for organisms in both input sets.
 * Retain the original children in supplied order.
 * Child references and repeated occurrences are preserved, without simplification.
 *
 * @category constructors
 * @since 0.1.0
 * @example
 * import { TaxonName, TaxonSet } from "robo-taxonomist";
 * const oaks = TaxonSet.of(TaxonName.make("Quercus"));
 * const family = TaxonSet.of(TaxonName.make("Fagaceae"));
 * export const shared = TaxonSet.intersection(oaks, family);
 */
export const intersection = <A extends TaxonomicRecord, B extends TaxonomicRecord>(
  left: TaxonSet<A>,
  right: TaxonSet<B>,
): TaxonSet<A | B> => new Intersection<A | B>({ operands: [left, right] });

/**
 * Build an expression for organisms in the left set that are outside the right set.
 * Child references and operand order are preserved, without simplification.
 *
 * @category constructors
 * @since 0.1.0
 * @example
 * import { TaxonName, TaxonSet } from "robo-taxonomist";
 * const family = TaxonSet.of(TaxonName.make("Fagaceae"));
 * const oaks = TaxonSet.of(TaxonName.make("Quercus"));
 * export const remaining = TaxonSet.difference(family, oaks);
 */
export const difference = <A extends TaxonomicRecord, B extends TaxonomicRecord>(
  left: TaxonSet<A>,
  right: TaxonSet<B>,
): TaxonSet<A | B> => new Difference<A | B>({ left, right });

/**
 * Build an expression for organisms in exactly one input set using the two directed differences.
 * Each operand reference occurs in both differences; neither difference is simplified.
 *
 * @category constructors
 * @since 0.1.0
 * @example
 * import { TaxonName, TaxonSet } from "robo-taxonomist";
 * const oaks = TaxonSet.of(TaxonName.make("Quercus"));
 * const beeches = TaxonSet.of(TaxonName.make("Fagus"));
 * export const exclusive = TaxonSet.symmetricDifference(oaks, beeches);
 */
export const symmetricDifference = <A extends TaxonomicRecord, B extends TaxonomicRecord>(
  left: TaxonSet<A>,
  right: TaxonSet<B>,
): TaxonSet<A | B> => union(difference(left, right), difference(right, left));

/**
 * Build universe minus set using the explicitly supplied universe.
 * Both original child references are retained, without simplification.
 *
 * @category constructors
 * @since 0.1.0
 * @example
 * import { TaxonName, TaxonSet } from "robo-taxonomist";
 * const oaks = TaxonSet.of(TaxonName.make("Quercus"));
 * const family = TaxonSet.of(TaxonName.make("Fagaceae"));
 * export const otherFamilyMembers = TaxonSet.complement(oaks, family);
 */
export const complement = <A extends TaxonomicRecord, B extends TaxonomicRecord>(
  set: TaxonSet<A>,
  universe: TaxonSet<B>,
): TaxonSet<A | B> => difference(universe, set);

/** The set relation requested by a predicate question.
 * @category schemas
 */
export { TaxonSetRelation } from "./TaxonSetRelations.ts";

/** Describe a set relation judgment and any taxon requiring clarification.
 * @category schemas
 */
export { TaxonSetRelationJudgment } from "./TaxonSetRelations.ts";

/**
 * Check whether every left-set organism belongs to the right set; equality counts.
 * The returned Effect answers Yes for a literal Empty on the left without consulting a model.
 * Other cases require a DecisionModel service and return a model judgment.
 *
 * @category relations
 * @since 0.1.0
 * @example
 * import { TaxonName, TaxonSet } from "robo-taxonomist";
 * export const subset = TaxonSet.isSubsetOf(TaxonSet.of(TaxonName.make("Quercus")), TaxonSet.of(TaxonName.make("Fagaceae")));
 */
export { isSubsetOf } from "./TaxonSetRelations.ts";

/**
 * Check whether every left-set organism belongs to the right set, but the sets are unequal.
 * The returned Effect answers No for a literal Empty on the right without consulting a model.
 * Other cases, including Empty on the left, require a DecisionModel service and return a model judgment.
 *
 * @category relations
 * @since 0.1.0
 * @example
 * import { TaxonName, TaxonSet } from "robo-taxonomist";
 * export const proper = TaxonSet.isProperSubsetOf(TaxonSet.empty(), TaxonSet.of(TaxonName.make("Quercus")));
 */
export { isProperSubsetOf } from "./TaxonSetRelations.ts";

/**
 * Check whether the two sets contain exactly the same organisms.
 * The returned Effect answers Yes for two literal Empty operands without consulting a model.
 * Other cases require a DecisionModel service and return a model judgment.
 *
 * @category relations
 * @since 0.1.0
 * @example
 * import { TaxonSet } from "robo-taxonomist";
 * export const equal = TaxonSet.equivalent(TaxonSet.empty(), TaxonSet.empty());
 */
export { equivalent } from "./TaxonSetRelations.ts";

/**
 * Check whether the complete sets share an organism.
 * The returned Effect answers No if either operand is a literal Empty without consulting a model.
 * Other cases require a DecisionModel service and return a model judgment.
 * Calls are judged independently, so answers across calls may differ.
 *
 * @category relations
 * @since 0.1.0
 * @example
 * import { TaxonName, TaxonSet } from "robo-taxonomist";
 * export const shared = TaxonSet.overlaps(TaxonSet.of(TaxonName.make("Quercus")), TaxonSet.of(TaxonName.make("Fagus")));
 */
export { overlaps } from "./TaxonSetRelations.ts";

/**
 * Check whether the complete sets have no organisms in common.
 * The returned Effect answers Yes if either operand is a literal Empty without consulting a model.
 * Other cases require a DecisionModel service and invert one overlap judgment,
 * retaining uncertainty and the original supplied-side and taxon diagnoses.
 *
 * @category relations
 * @since 0.1.0
 * @see {@link overlaps}
 * @example
 * import { TaxonName, TaxonSet } from "robo-taxonomist";
 * export const separate = TaxonSet.disjoint(TaxonSet.of(TaxonName.make("Quercus")), TaxonSet.of(TaxonName.make("Fagus")));
 */
export { disjoint } from "./TaxonSetRelations.ts";
