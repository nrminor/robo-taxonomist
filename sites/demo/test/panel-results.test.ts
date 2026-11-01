import { expect, it } from "@effect/vitest";
import {
  Array,
  Data,
  Deferred,
  Effect,
  Fiber,
  Layer,
  Option,
  Record,
  Result,
  Schema,
} from "effect";
import { AiError, DecisionModel } from "effect/ai";
import { panels, records } from "../src/lib/catalog.ts";
import {
  ClassificationFailure,
  MatchJudgment,
  PanelResponse,
  PublicModelReason,
} from "../src/lib/contract.ts";
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
      expect(result.rows.map((row) => row.matches.length)).toEqual(Array.replicate(10, 24));
      const species = Array.findFirst(result.rows, (row) => row.recordId === "r01").pipe(
        Option.getOrThrow,
      );
      const genus = Array.findFirst(result.rows, (row) => row.recordId === "r19").pipe(
        Option.getOrThrow,
      );
      expect(
        species.matches
          .filter((match) => MatchJudgment.guards.Matched(match.judgment))
          .map((match) => match.targetId),
      ).toEqual(["fungi", "saccharomycetaceae", "saccharomyces", "saccharomyces-cerevisiae"]);
      expect(
        genus.matches
          .filter((match) => MatchJudgment.guards.Matched(match.judgment))
          .map((match) => match.targetId),
      ).toEqual(["fungi", "saccharomycetaceae", "saccharomyces"]);
      const vagueIds = records
        .filter((record) => record.kind === "vague")
        .map((record) => record.id);
      expect(vagueIds).toEqual(["r23", "r24"]);
      const vagueRows = result.rows.filter((row) => vagueIds.some((id) => id === row.recordId));
      expect(vagueRows.map((row) => row.recordId)).toEqual(vagueIds);
      expect(
        vagueRows
          .flatMap((row) => row.matches)
          .every((match) => MatchJudgment.guards.Undetermined(match.judgment)),
      ).toBe(true);
      const abundanceFor = (targetId: string) =>
        result.rows.reduce((total, row) => {
          const accepted = row.matches.some(
            (match) => match.targetId === targetId && MatchJudgment.guards.Matched(match.judgment),
          );
          const record = Array.findFirst(records, (record) => record.id === row.recordId).pipe(
            Option.getOrThrowWith(() => new Error(`Missing record ${row.recordId}`)),
          );
          return total + (accepted ? record.abundance : 0);
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
      const firstRow = Array.head(result.rows).pipe(Option.getOrThrow);
      const panel = Array.findFirst(panels, (panel) => panel.id === panelId).pipe(
        Option.getOrThrow,
      );
      expect(firstRow.matches.map((match) => match.targetId)).toEqual(
        panel.targets.map((target) => target.id),
      );
      expect(result.rows.flatMap((row) => row.matches)).toHaveLength(
        panelId === "broad" ? 144 : 240,
      );
    }
    const broad = yield* classifyPanel("broad");
    const namedIds = records.filter((record) => record.kind !== "vague").map((record) => record.id);
    expect(namedIds).toHaveLength(22);
    const namedRows = broad.rows.filter((row) => namedIds.some((id) => id === row.recordId));
    expect(namedRows.map((row) => row.recordId)).toEqual(namedIds);
    expect(
      namedRows.every(
        (row) =>
          row.matches.filter((match) => MatchJudgment.guards.Matched(match.judgment)).length === 1,
      ),
    ).toBe(true);
    const focused = yield* classifyPanel("focused");
    const outsideSpecies = Array.findFirst(focused.rows, (row) => row.recordId === "r03").pipe(
      Option.getOrThrow,
    );
    const outsideGenus = Array.findFirst(focused.rows, (row) => row.recordId === "r20").pipe(
      Option.getOrThrow,
    );
    expect(outsideSpecies.matches).toHaveLength(10);
    expect(outsideGenus.matches).toHaveLength(10);
    expect(
      outsideSpecies.matches.every((match) => MatchJudgment.guards.NotMatched(match.judgment)),
    ).toBe(true);
    expect(
      outsideGenus.matches.every((match) => MatchJudgment.guards.NotMatched(match.judgment)),
    ).toBe(true);
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
      const row = Array.findFirst(response.rows, (row) => row.recordId === "r01").pipe(
        Option.getOrThrow,
      );
      const match = Array.findFirst(row.matches, (match) => match.targetId === "fungi").pipe(
        Option.getOrThrow,
      );
      expect(match.answer).toMatchObject({ confidence: 0.8 });
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
      const secondResult = yield* Fiber.join(second);
      expect(secondResult).toBe(firstResult);
      const cached = yield* classifyPanel("broad");
      expect(cached).toBe(firstResult);
      // Four six-record batches stay within Clef's question limit for either panel size.
      expect(calls).toBe(4);
      yield* classifyPanel("focused");
      expect(calls).toBe(8);
    }).pipe(Effect.provide(PanelResults.layerNoDeps.pipe(Layer.provide(model))));
  }),
);

it.effect("refreshes only the selected panel while retaining its success until replacement", () =>
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
              if (calls === 9) {
                yield* Deferred.succeed(started, undefined);
                yield* Deferred.await(release);
              }
              return yield* fixture.decide(definition, options);
            }),
        });
      }),
    ).pipe(Layer.provide(FixtureModel));
    yield* Effect.gen(function* () {
      const broad = yield* classifyPanel("broad");
      expect(calls).toBe(4);
      const unchanged = yield* classifyPanel("broad", false);
      expect(unchanged).toBe(broad);
      expect(calls).toBe(4);
      const focused = yield* classifyPanel("focused");
      expect(calls).toBe(8);
      const pending = yield* classifyPanel("broad", true).pipe(Effect.forkChild);
      yield* Deferred.await(started);
      const pendingBroad = yield* classifyPanel("broad");
      expect(pendingBroad).toBe(broad);
      const pendingFocused = yield* classifyPanel("focused");
      expect(pendingFocused).toBe(focused);
      expect(calls).toBe(9);
      yield* Deferred.succeed(release, undefined);
      const refreshed = yield* Fiber.join(pending);
      expect(refreshed).not.toBe(broad);
      expect(refreshed).toEqual(broad);
      expect(calls).toBe(12);
      const cachedBroad = yield* classifyPanel("broad");
      expect(cachedBroad).toBe(refreshed);
      const cachedFocused = yield* classifyPanel("focused");
      expect(cachedFocused).toBe(focused);
      expect(calls).toBe(12);
    }).pipe(Effect.provide(PanelResults.layerNoDeps.pipe(Layer.provide(model))));
  }),
);

it.effect(
  "evicts a failed refresh without evicting another panel and retries with fresh work",
  () =>
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
                return calls === 9
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
        const broad = yield* classifyPanel("broad");
        const focused = yield* classifyPanel("focused");
        const failure = yield* classifyPanel("broad", true).pipe(Effect.flip);
        expect(failure).toEqual(
          ClassificationFailure.cases.ModelFailure.make({
            reason: PublicModelReason.cases.RateLimitError.make({}),
            retryable: true,
          }),
        );
        expect(calls).toBe(9);
        const cachedFocused = yield* classifyPanel("focused");
        expect(cachedFocused).toBe(focused);
        expect(calls).toBe(9);
        // A failed native refresh expires the selected cache entry, not just the error.
        const retried = yield* classifyPanel("broad");
        expect(retried).not.toBe(broad);
        expect(retried).toEqual(broad);
        expect(calls).toBe(13);
        const cachedBroad = yield* classifyPanel("broad");
        expect(cachedBroad).toBe(retried);
        expect(calls).toBe(13);
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
      const cached = yield* classifyPanel("broad");
      expect(cached).toBe(retried);
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
        const cached = yield* classifyPanel("broad");
        expect(cached).toBe(retried);
        expect(calls).toBe(5);
        expect(interruptions).toBe(1);
      }).pipe(Effect.provide(PanelResults.layerNoDeps.pipe(Layer.provide(model))));
    }),
);
