import { expect, it } from "@effect/vitest";
import { Data, Deferred, Effect, Fiber, Layer, Record, Result, Schema } from "effect";
import { AiError, DecisionModel } from "effect/ai";
import { panels, records } from "../src/lib/catalog.ts";
import { PanelResponse } from "../src/lib/contract.ts";
import { classifyPanel, PanelResults } from "../src/server/panel-results.ts";
import { FixtureModel } from "../src/server/fixture-model.ts";

it.effect(
  "classifies the authored nested fixture with overlapping targets and unresolved vague rows",
  () =>
    Effect.gen(function* () {
      const result = yield* classifyPanel("nested");
      expect(Schema.is(PanelResponse)(result)).toBe(true);
      const encoded = yield* Schema.encodeEffect(Schema.toCodecJson(PanelResponse))(result);
      const decoded = yield* Schema.decodeUnknownEffect(Schema.toCodecJson(PanelResponse))(
        JSON.parse(JSON.stringify(encoded)),
      );
      expect(decoded).toEqual(result);
      expect(result.rows).toHaveLength(24);
      expect(result.rows.map((row) => row.matches.length)).toEqual(Array(24).fill(10));
      expect(
        result.rows[0]?.matches
          .filter((match) => match.judgment._tag === "Matched")
          .map((match) => match.targetId),
      ).toEqual(["fungi", "saccharomycetaceae", "saccharomyces", "saccharomyces-cerevisiae"]);
      expect(
        result.rows[18]?.matches
          .filter((match) => match.judgment._tag === "Matched")
          .map((match) => match.targetId),
      ).toEqual(["fungi", "saccharomycetaceae", "saccharomyces"]);
      expect(
        result.rows
          .slice(22)
          .flatMap((row) => row.matches)
          .every((match) => match.judgment._tag === "Undetermined"),
      ).toBe(true);
      const abundanceFor = (targetId: string) =>
        result.rows.reduce((total, row) => {
          const accepted = row.matches.some(
            (match) => match.targetId === targetId && match.judgment._tag === "Matched",
          );
          return (
            total +
            (accepted ? (records.find((record) => record.id === row.recordId)?.abundance ?? 0) : 0)
          );
        }, 0);
      expect(abundanceFor("saccharomyces")).toBe(18);
      expect(abundanceFor("saccharomyces-cerevisiae")).toBe(14);
    }).pipe(Effect.provide(PanelResults.layer)),
);

it.effect("preserves the locked record weights and ordered broad and focused comparisons", () =>
  Effect.gen(function* () {
    expect(records.reduce((sum, record) => sum + record.abundance, 0)).toBe(100);
    for (const panelId of ["broad", "focused"] as const) {
      const result = yield* classifyPanel(panelId);
      expect(result.rows.map((row) => row.recordId)).toEqual(records.map((record) => record.id));
      expect(result.rows[0]?.matches.map((match) => match.targetId)).toEqual(
        panels.find((panel) => panel.id === panelId)?.targets.map((target) => target.id),
      );
      expect(result.rows.flatMap((row) => row.matches)).toHaveLength(
        panelId === "broad" ? 144 : 240,
      );
    }
    const broad = yield* classifyPanel("broad");
    expect(
      broad.rows
        .slice(0, 22)
        .every(
          (row) => row.matches.filter((match) => match.judgment._tag === "Matched").length === 1,
        ),
    ).toBe(true);
    const focused = yield* classifyPanel("focused");
    expect(focused.rows[2]?.matches.every((match) => match.judgment._tag === "NotMatched")).toBe(
      true,
    );
    expect(focused.rows[19]?.matches.every((match) => match.judgment._tag === "NotMatched")).toBe(
      true,
    );
  }).pipe(Effect.provide(PanelResults.layer)),
);

it.effect("rejects replies that omit, repeat, or change a record or target", () =>
  Effect.gen(function* () {
    const response = yield* classifyPanel("broad");
    const invalid = [
      { ...response, rows: response.rows.slice(1) },
      { ...response, rows: [...response.rows.slice(0, 1), ...response.rows.slice(0, -1)] },
      { ...response, rows: response.rows.map((row) => ({ ...row, recordId: "unknown-record" })) },
      {
        ...response,
        rows: response.rows.map((row) => ({ ...row, matches: row.matches.slice(1) })),
      },
      {
        ...response,
        rows: response.rows.map((row) => ({
          ...row,
          matches: row.matches.map((match) => ({ ...match, targetId: "unknown-target" })),
        })),
      },
    ];
    for (const reply of invalid)
      expect(Result.isFailure(Schema.decodeResult(PanelResponse)(reply))).toBe(true);
  }).pipe(Effect.provide(PanelResults.layer)),
);

it.effect(
  "preserves the provider's optional confidence through projection and JSON encoding",
  () => {
    const { Classify } = Data.taggedEnum<DecisionModel.ProviderClassifyAnswer>();
    const model = Layer.effect(
      DecisionModel.DecisionModel,
      DecisionModel.make({
        decide: ({ decisions }) =>
          Effect.succeed({
            answers: Record.map(decisions, () =>
              Classify({
                label: "noMatch",
                probabilities: {
                  sameTaxon: 0.01,
                  withinTaxon: 0.01,
                  noMatch: 0.95,
                  undetermined: 0.03,
                },
                confidence: 0.8,
              }),
            ),
            usage: { inputTokens: undefined, outputTokens: undefined },
          }),
      }),
    );
    return Effect.gen(function* () {
      const response = yield* classifyPanel("broad");
      expect(response.rows[0]?.matches[0]?.answer).toMatchObject({ confidence: 0.8 });
      const wire = yield* Schema.encodeEffect(Schema.toCodecJson(PanelResponse))(response);
      expect(JSON.stringify(wire)).toContain('"confidence":0.8');
      const decoded = yield* Schema.decodeUnknownEffect(Schema.toCodecJson(PanelResponse))(
        JSON.parse(JSON.stringify(wire)),
      );
      expect(decoded).toEqual(response);
    }).pipe(Effect.provide(PanelResults.layerNoDeps.pipe(Layer.provide(model))));
  },
);

it.effect("loads only requested panels, coalesces pending requests and reuses successes", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    let calls = 0;
    const model = Layer.effect(
      DecisionModel.DecisionModel,
      Effect.gen(function* () {
        const fixture = yield* DecisionModel.DecisionModel;
        return DecisionModel.DecisionModel.of({
          ...fixture,
          decide: (definition, options) =>
            Effect.gen(function* () {
              calls++;
              yield* Deferred.succeed(started, undefined);
              yield* Deferred.await(release);
              return yield* fixture.decide(definition, options);
            }),
        });
      }),
    ).pipe(Layer.provide(FixtureModel));
    yield* Effect.gen(function* () {
      expect(calls).toBe(0);
      const first = yield* classifyPanel("broad").pipe(Effect.forkChild);
      yield* Deferred.await(started);
      const second = yield* classifyPanel("broad").pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      expect(calls).toBe(1);
      yield* Deferred.succeed(release, undefined);
      const firstResult = yield* Fiber.join(first);
      expect(yield* Fiber.join(second)).toBe(firstResult);
      expect(yield* classifyPanel("broad")).toBe(firstResult);
      // Four six-record batches stay within Clef's question limit for either panel size.
      expect(calls).toBe(4);
      yield* classifyPanel("focused");
      expect(calls).toBe(8);
    }).pipe(Effect.provide(PanelResults.layerNoDeps.pipe(Layer.provide(model))));
  }),
);

it.effect("does not retain failures and permits an explicit same-panel retry", () =>
  Effect.gen(function* () {
    let calls = 0;
    const model = Layer.effect(
      DecisionModel.DecisionModel,
      Effect.gen(function* () {
        const fixture = yield* DecisionModel.DecisionModel;
        return DecisionModel.DecisionModel.of({
          ...fixture,
          decide: (definition, options) =>
            Effect.suspend(() => {
              calls++;
              return calls === 1
                ? Effect.fail(
                    new AiError.AiError({
                      module: "fixture",
                      method: "decide",
                      reason: new AiError.RateLimitError({}),
                    }),
                  )
                : fixture.decide(definition, options);
            }),
        });
      }),
    ).pipe(Layer.provide(FixtureModel));
    yield* Effect.gen(function* () {
      const failed = yield* classifyPanel("broad").pipe(Effect.result);
      expect(Result.isFailure(failed)).toBe(true);
      expect(calls).toBe(1);
      const retried = yield* classifyPanel("broad");
      expect(retried.rows).toHaveLength(24);
      expect(calls).toBe(5);
      expect(yield* classifyPanel("broad")).toBe(retried);
      expect(calls).toBe(5);
    }).pipe(Effect.provide(PanelResults.layerNoDeps.pipe(Layer.provide(model))));
  }),
);

it.effect(
  "interrupts a lookup when all waiters cancel and permits a fresh same-panel request",
  () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const interrupted = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let calls = 0;
      let interruptions = 0;
      const model = Layer.effect(
        DecisionModel.DecisionModel,
        Effect.gen(function* () {
          const fixture = yield* DecisionModel.DecisionModel;
          return DecisionModel.DecisionModel.of({
            ...fixture,
            decide: (definition, options) =>
              Effect.gen(function* () {
                calls++;
                yield* Deferred.succeed(started, undefined);
                yield* Deferred.await(release);
                return yield* fixture.decide(definition, options);
              }).pipe(
                Effect.onInterrupt(() =>
                  Effect.gen(function* () {
                    interruptions++;
                    yield* Deferred.succeed(interrupted, undefined);
                  }),
                ),
              ),
          });
        }),
      ).pipe(Layer.provide(FixtureModel));
      yield* Effect.gen(function* () {
        const first = yield* classifyPanel("broad").pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Deferred.await(started);
        const second = yield* classifyPanel("broad").pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Fiber.interrupt(first);
        expect(interruptions).toBe(0);
        yield* Fiber.interrupt(second);
        yield* Deferred.await(interrupted);
        expect(interruptions).toBe(1);
        expect(calls).toBe(1);
        yield* Deferred.succeed(release, undefined);
        const retried = yield* classifyPanel("broad");
        expect(retried.rows).toHaveLength(24);
        expect(calls).toBe(5);
        expect(yield* classifyPanel("broad")).toBe(retried);
        expect(calls).toBe(5);
        expect(interruptions).toBe(1);
      }).pipe(Effect.provide(PanelResults.layerNoDeps.pipe(Layer.provide(model))));
    }),
);
