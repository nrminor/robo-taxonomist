import { expect } from "@effect/vitest";
import { Effect, Layer, Ref } from "effect";
import { type AiError, DecisionModel } from "effect/ai";
import { FixtureModel } from "../src/server/fixture-model.ts";

type BeforeDecision = Effect.Effect<void, AiError.AiError>;

const buildObservedFixture = (before: BeforeDecision, onInterrupt: Effect.Effect<void>) =>
  Effect.gen(function* () {
    const fixture = yield* DecisionModel.DecisionModel;

    return DecisionModel.DecisionModel.of({
      ...fixture,
      decide: (definition, options) =>
        before.pipe(
          Effect.andThen(fixture.decide(definition, options)),
          Effect.onInterrupt(() => onInterrupt),
        ),
    });
  });

/** Run test effects around decisions without replacing the fixture's answers. */
export const observedFixture = (before: BeforeDecision, onInterrupt = Effect.void) =>
  Layer.effect(DecisionModel.DecisionModel, buildObservedFixture(before, onInterrupt)).pipe(
    Layer.provide(FixtureModel),
  );

export const expectCount = (count: Ref.Ref<number>, expected: number) =>
  Ref.get(count).pipe(
    Effect.map((actual) => {
      expect(actual).toBe(expected);
    }),
  );
