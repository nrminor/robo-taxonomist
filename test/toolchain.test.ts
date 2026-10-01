import { expect, it } from "@effect/vitest";
import { Clock, Effect } from "effect";
import { TestClock } from "effect/testing";

it.effect("provides the Effect test clock", () =>
  Effect.gen(function* () {
    yield* TestClock.adjust("1 second");
    const now = yield* Clock.currentTimeMillis;
    expect(now).toBe(1000);
  }),
);
