import { Array, BigDecimal, Iterable, Number, Option, Schema, pipe } from "effect";

const UnitInterval = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 }));

/**
 * Set the minimum model-reported support and margin needed to accept a judgment.
 * Support can combine probabilities for choices that imply the same broader answer.
 * Margin is the lead over the strongest competing answer, including uncertainty
 * and clarification choices. Every accepted answer must have a unique lead.
 * Uncertainty and clarification retain their reported probability mass.
 * Both thresholds are inclusive and must lie between zero and one.
 *
 * Pass this value in the policy option. The defaults are minimumSupport: 0.5 and
 * minimumMargin: 0. A broader judgment can be accepted while its finer details
 * remain uncertain. Model accuracy and probability calibration require separate evaluation.
 *
 * @category schemas
 * @since 0.1.0
 * @example
 * import { AcceptancePolicy, RecordLabel, Taxonomy } from "robo-taxonomist";
 * const policy = AcceptancePolicy.make({ minimumSupport: 0.8, minimumMargin: 0.1 });
 * export const comparison = Taxonomy.sameSpecies(
 *   RecordLabel.make("Quercus robur"), RecordLabel.make("Quercus petraea"), { policy },
 * );
 */
export const AcceptancePolicy = Schema.Struct({
  minimumSupport: UnitInterval,
  minimumMargin: UnitInterval,
}).pipe(Schema.brand("AcceptancePolicy"));

/**
 * Supply a validated acceptance policy in an operation's policy option.
 *
 * @category models
 * @since 0.1.0
 * @example
 * import { AcceptancePolicy } from "robo-taxonomist";
 * const policy = AcceptancePolicy.make({ minimumSupport: 0.8, minimumMargin: 0.1 });
 * export const options = { policy };
 */
export type AcceptancePolicy = typeof AcceptancePolicy.Type;

/**
 * The library uses these values when the caller omits the policy option.
 * An answer needs at least half the support and a unique lead.
 * @example
 * import { defaultPolicy } from "./AcceptancePolicy.ts";
 * export const options = { policy: defaultPolicy };
 */
export const defaultPolicy = AcceptancePolicy.make({ minimumSupport: 0.5, minimumMargin: 0 });

/**
 * Comparison functions use this type to keep an answer with its support.
 * @example
 * import type { Scored } from "./AcceptancePolicy.ts";
 * export const candidate: Scored<boolean> = { answer: true, support: 0.8 };
 */
export type Scored<A> = {
  readonly answer: A;
  readonly support: number;
};

/**
 * Check whether an answer has enough support and margin.
 * Pass its support, the supports of the other answers, and the acceptance policy.
 * @example
 * import { accepts, defaultPolicy } from "./AcceptancePolicy.ts";
 * export const accepted = accepts(0.6, [0.3, 0.1], defaultPolicy);
 */
export const accepts = (
  support: number,
  alternatives: Iterable<number>,
  policy: AcceptancePolicy,
) => {
  const strongestAlternative = Iterable.reduce(alternatives, 0, Number.max);
  const margin = support - strongestAlternative;
  return (
    margin > 0 &&
    support >= policy.minimumSupport &&
    (margin >= policy.minimumMargin || policy.minimumMargin - margin <= globalThis.Number.EPSILON)
  );
};

/**
 * Add probabilities for choices that support the same answer.
 * Decimal addition avoids rounding between terms. Pass finite probabilities
 * checked by DecisionModel.
 * @example
 * import { sumProbabilities } from "./AcceptancePolicy.ts";
 * export const support = sumProbabilities([0.1, 0.7]);
 */
export const sumProbabilities = (values: Iterable<number>): number =>
  pipe(
    values,
    Iterable.map(BigDecimal.fromNumberUnsafe),
    BigDecimal.sumAll,
    BigDecimal.toNumberUnsafe,
  );

/**
 * Choose the answer with the most support. Return Option.none if it fails the acceptance policy.
 * Include Undetermined and clarification judgments in the list so their support counts too.
 * @example
 * import { defaultPolicy, select } from "./AcceptancePolicy.ts";
 * export const answer = select([
 *   { answer: true, support: 0.8 }, { answer: false, support: 0.2 },
 * ], defaultPolicy);
 */
export const select = <A>(
  candidates: Array.NonEmptyReadonlyArray<Scored<A>>,
  policy: AcceptancePolicy,
): Option.Option<A> => {
  const leading = Array.reduce(
    candidates,
    { index: 0, candidate: Array.headNonEmpty(candidates) },
    (best, candidate, index) =>
      candidate.support > best.candidate.support ? { index, candidate } : best,
  );
  const alternatives = pipe(
    candidates,
    Iterable.filter((_candidate, index) => index !== leading.index),
    Iterable.map(({ support }) => support),
  );
  return accepts(leading.candidate.support, alternatives, policy)
    ? Option.some(leading.candidate.answer)
    : Option.none();
};
