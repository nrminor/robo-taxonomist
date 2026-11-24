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
  Ref,
  Result,
  Schema,
} from "effect";
import { AiError, DecisionModel } from "effect/ai";
import { TaxonMatchJudgment, TaxonomyHint } from "robo-taxonomist";
import { panels, records } from "../src/lib/catalog.ts";
import { PanelResponse } from "../src/lib/contract.ts";
import * as Display from "../src/lib/display.ts";
import { classifyPanel, PanelResults } from "../src/server/panel-results.ts";
import { expectCount, observedFixture } from "./fixture-decision.ts";
import * as TestJson from "./Json.ts";

it.effect(
  "classifies the authored nested fixture with overlapping targets and unresolved vague rows",
  () =>
    Effect.gen(function* () {
      const result = yield* classifyPanel("nested");
      expect(Schema.is(PanelResponse)(result)).toBe(true);
      const encoded = yield* Schema.encodeEffect(Schema.toCodecJson(PanelResponse))(result);
      const text = yield* TestJson.encode(encoded);
      const parsed = yield* TestJson.decode(text);
      const decoded = yield* Schema.decodeUnknownEffect(Schema.toCodecJson(PanelResponse))(parsed);
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
          .filter(
            (match) =>
              TaxonMatchJudgment.guards.SameTaxon(match.judgment) ||
              TaxonMatchJudgment.guards.WithinTaxon(match.judgment),
          )
          .map((match) => match.targetId),
      ).toEqual(["fungi", "saccharomycetaceae", "saccharomyces", "saccharomyces-cerevisiae"]);
      expect(
        genus.matches
          .filter(
            (match) =>
              TaxonMatchJudgment.guards.SameTaxon(match.judgment) ||
              TaxonMatchJudgment.guards.WithinTaxon(match.judgment),
          )
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
          .every((match) => TaxonMatchJudgment.guards.Undetermined(match.judgment)),
      ).toBe(true);

      const abundanceFor = (targetId: string) =>
        result.rows.reduce((total, row) => {
          const accepted = row.matches.some(
            (match) =>
              match.targetId === targetId &&
              (TaxonMatchJudgment.guards.SameTaxon(match.judgment) ||
                TaxonMatchJudgment.guards.WithinTaxon(match.judgment)),
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
          row.matches.filter(
            (match) =>
              TaxonMatchJudgment.guards.SameTaxon(match.judgment) ||
              TaxonMatchJudgment.guards.WithinTaxon(match.judgment),
          ).length === 1,
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
      outsideSpecies.matches.every((match) => TaxonMatchJudgment.guards.NotMatched(match.judgment)),
    ).toBe(true);
    expect(
      outsideGenus.matches.every((match) => TaxonMatchJudgment.guards.NotMatched(match.judgment)),
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
      const text = yield* TestJson.encode(wire);
      expect(text).toContain('"confidence":0.8');
      const parsed = yield* TestJson.decode(text);
      const decoded = yield* Schema.decodeUnknownEffect(Schema.toCodecJson(PanelResponse))(parsed);
      expect(decoded).toEqual(response);
    }).pipe(Effect.provide(PanelResults.layerNoDeps.pipe(Layer.provide(model))));
  },
);

it.effect("excludes split support from abundance while retaining an accepted relationship", () => {
  const { Classify } = Data.taggedEnum<DecisionModel.ProviderClassifyAnswer>();
  let batch = 0;
  const split = { sameTaxon: 0.49, withinTaxon: 0.49, noMatch: 0.01, undetermined: 0.01 };
  const strong = { sameTaxon: 0.01, withinTaxon: 0.96, noMatch: 0.02, undetermined: 0.01 };
  const negative = { sameTaxon: 0.01, withinTaxon: 0.01, noMatch: 0.95, undetermined: 0.03 };

  const model = Layer.effect(
    DecisionModel.DecisionModel,
    DecisionModel.make({
      decide: ({ decisions }) => {
        const first = batch++ === 0;

        return Effect.succeed({
          answers: Record.map(decisions, (_, key) =>
            Classify(
              first && key === "r0t0"
                ? { label: "sameTaxon", probabilities: split, confidence: 0.7 }
                : first && key === "r0t1"
                  ? { label: "withinTaxon", probabilities: strong, confidence: 0.8 }
                  : { label: "noMatch", probabilities: negative },
            ),
          ),
          usage: { inputTokens: undefined, outputTokens: undefined },
        });
      },
    }),
  );

  return Effect.gen(function* () {
    const response = yield* classifyPanel("broad");
    expect(response.rows.map((row) => row.recordId)).toEqual(records.map((record) => record.id));
    const row = Array.head(response.rows).pipe(Option.getOrThrow);
    const panel = Array.findFirst(panels, (panel) => panel.id === "broad").pipe(Option.getOrThrow);

    const splitMatch = Array.findFirst(row.matches, (match) => match.targetId === "fungi").pipe(
      Option.getOrThrow,
    );

    const strongMatch = Array.findFirst(
      row.matches,
      (match) => match.targetId === "lactobacillaceae",
    ).pipe(Option.getOrThrow);

    expect(row.matches.map((match) => match.targetId)).toEqual(
      panel.targets.map((target) => target.id),
    );
    expect(splitMatch.judgment).toSatisfy(TaxonMatchJudgment.guards.Undetermined);
    expect(splitMatch).toMatchObject({
      answer: { label: "sameTaxon", probabilities: split, confidence: 0.7 },
    });
    expect(strongMatch.judgment).toSatisfy(TaxonMatchJudgment.guards.WithinTaxon);
    expect(strongMatch).toMatchObject({
      judgment: { support: 0.96 },
      answer: { label: "withinTaxon", probabilities: strong, confidence: 0.8 },
    });
    const findings = Display.replaceDisplayed(undefined, response).findings;
    const finding = Array.head(findings.records).pipe(Option.getOrThrow);

    const fungi = Array.findFirst(findings.compositions, (target) => target.id === "fungi").pipe(
      Option.getOrThrow,
    );

    const lactobacillaceae = Array.findFirst(
      findings.compositions,
      (target) => target.id === "lactobacillaceae",
    ).pipe(Option.getOrThrow);

    expect(finding.acceptedTargets).toEqual(new Set([strongMatch.targetId]));
    expect(fungi.abundance).toBe(0);
    expect(lactobacillaceae.abundance).toBeCloseTo(14);
  }).pipe(Effect.provide(PanelResults.layerNoDeps.pipe(Layer.provide(model))));
});

it.effect("loads only requested panels, coalesces pending requests and reuses successes", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const calls = yield* Ref.make(0);

    const model = observedFixture(
      Ref.update(calls, (count) => count + 1).pipe(
        Effect.andThen(Deferred.succeed(started, undefined)),
        Effect.andThen(Deferred.await(release)),
      ),
    );

    yield* Effect.gen(function* () {
      yield* expectCount(calls, 0);
      const first = yield* classifyPanel("broad").pipe(Effect.forkChild);
      yield* Deferred.await(started);
      const second = yield* classifyPanel("broad").pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* expectCount(calls, 1);
      yield* Deferred.succeed(release, undefined);
      const firstResult = yield* Fiber.join(first);
      const secondResult = yield* Fiber.join(second);
      expect(secondResult).toBe(firstResult);
      const cached = yield* classifyPanel("broad");
      expect(cached).toBe(firstResult);
      // Four six-record batches stay within Clef's question limit for either panel size.
      yield* expectCount(calls, 4);
      yield* classifyPanel("focused");
      yield* expectCount(calls, 8);
    }).pipe(Effect.provide(PanelResults.layerNoDeps.pipe(Layer.provide(model))));
  }),
);

it.effect("keys cached and concurrent results by ordered hints and panel", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const calls = yield* Ref.make(0);

    const model = observedFixture(
      Ref.update(calls, (count) => count + 1).pipe(
        Effect.andThen(Deferred.succeed(started, undefined)),
        Effect.andThen(Deferred.await(release)),
      ),
    );

    yield* Effect.gen(function* () {
      const a = TaxonomyHint.make("first");
      const b = TaxonomyHint.make("second");
      const first = yield* classifyPanel("broad", false, [a, b]).pipe(Effect.forkChild);
      yield* Deferred.await(started);
      const second = yield* classifyPanel("broad", false, [a, b]).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* expectCount(calls, 1);
      yield* Deferred.succeed(release, undefined);
      const result = yield* Fiber.join(first);
      const coalesced = yield* Fiber.join(second);
      expect(coalesced).toBe(result);
      const cached = yield* classifyPanel("broad", false, [a, b]);
      expect(cached).toBe(result);
      yield* expectCount(calls, 4);
      yield* classifyPanel("broad", false, [b, a]);
      yield* expectCount(calls, 8);
      const baseline = yield* classifyPanel("broad");
      const empty = yield* classifyPanel("broad", false, []);
      expect(empty).toBe(baseline);
      yield* expectCount(calls, 12);
      yield* classifyPanel("broad", true, [a, b]);
      yield* expectCount(calls, 16);
      const retainedBaseline = yield* classifyPanel("broad");
      expect(retainedBaseline).toBe(baseline);
      yield* classifyPanel("focused", false, [a, b]);
      yield* expectCount(calls, 20);
    }).pipe(Effect.provide(PanelResults.layerNoDeps.pipe(Layer.provide(model))));
  }),
);

it.effect("refreshes only the selected panel while retaining its success until replacement", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const calls = yield* Ref.make(0);
    const holdRefresh = yield* Ref.make(false);

    const model = observedFixture(
      Ref.update(calls, (count) => count + 1).pipe(
        Effect.andThen(Ref.getAndSet(holdRefresh, false)),
        Effect.flatMap((hold) =>
          hold
            ? Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release)))
            : Effect.void,
        ),
      ),
    );

    yield* Effect.gen(function* () {
      const broad = yield* classifyPanel("broad");
      yield* expectCount(calls, 4);
      const unchanged = yield* classifyPanel("broad", false);
      expect(unchanged).toBe(broad);
      yield* expectCount(calls, 4);
      const focused = yield* classifyPanel("focused");
      yield* expectCount(calls, 8);
      yield* Ref.set(holdRefresh, true);
      const pending = yield* classifyPanel("broad", true).pipe(Effect.forkChild);
      yield* Deferred.await(started);
      const pendingBroad = yield* classifyPanel("broad");
      expect(pendingBroad).toBe(broad);
      const pendingFocused = yield* classifyPanel("focused");
      expect(pendingFocused).toBe(focused);
      yield* expectCount(calls, 9);
      yield* Deferred.succeed(release, undefined);
      const refreshed = yield* Fiber.join(pending);
      expect(refreshed).not.toBe(broad);
      expect(refreshed).toEqual(broad);
      yield* expectCount(calls, 12);
      const cachedBroad = yield* classifyPanel("broad");
      expect(cachedBroad).toBe(refreshed);
      const cachedFocused = yield* classifyPanel("focused");
      expect(cachedFocused).toBe(focused);
      yield* expectCount(calls, 12);
    }).pipe(Effect.provide(PanelResults.layerNoDeps.pipe(Layer.provide(model))));
  }),
);

it.effect(
  "evicts a failed refresh without evicting another panel and retries with fresh work",
  () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make(0);
      const failNext = yield* Ref.make(false);

      const original = new AiError.AiError({
        module: "fixture",
        method: "decide",
        reason: new AiError.RateLimitError({}),
      });

      const model = observedFixture(
        Ref.update(calls, (count) => count + 1).pipe(
          Effect.andThen(Ref.getAndSet(failNext, false)),
          Effect.flatMap((armed) => (armed ? Effect.fail(original) : Effect.void)),
        ),
      );

      yield* Effect.gen(function* () {
        const broad = yield* classifyPanel("broad");
        const focused = yield* classifyPanel("focused");
        yield* Ref.set(failNext, true);
        const failure = yield* classifyPanel("broad", true).pipe(Effect.flip);
        expect(failure).toBe(original);
        yield* expectCount(calls, 9);
        const cachedFocused = yield* classifyPanel("focused");
        expect(cachedFocused).toBe(focused);
        yield* expectCount(calls, 9);
        // A failed native refresh expires the selected cache entry, not just the error.
        const retried = yield* classifyPanel("broad");
        expect(retried).not.toBe(broad);
        expect(retried).toEqual(broad);
        yield* expectCount(calls, 13);
        const cachedBroad = yield* classifyPanel("broad");
        expect(cachedBroad).toBe(retried);
        yield* expectCount(calls, 13);
      }).pipe(Effect.provide(PanelResults.layerNoDeps.pipe(Layer.provide(model))));
    }),
);

it.effect("does not retain failures and permits an explicit same-panel retry", () =>
  Effect.gen(function* () {
    const calls = yield* Ref.make(0);
    const failNext = yield* Ref.make(true);

    const original = new AiError.AiError({
      module: "fixture",
      method: "decide",
      reason: new AiError.RateLimitError({}),
    });

    const model = observedFixture(
      Ref.update(calls, (count) => count + 1).pipe(
        Effect.andThen(Ref.getAndSet(failNext, false)),
        Effect.flatMap((armed) => (armed ? Effect.fail(original) : Effect.void)),
      ),
    );

    yield* Effect.gen(function* () {
      const failed = yield* classifyPanel("broad").pipe(Effect.result);
      expect(Result.isFailure(failed)).toBe(true);
      yield* expectCount(calls, 1);
      const retried = yield* classifyPanel("broad");
      expect(retried.rows).toHaveLength(24);
      yield* expectCount(calls, 5);
      const cached = yield* classifyPanel("broad");
      expect(cached).toBe(retried);
      yield* expectCount(calls, 5);
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
      const calls = yield* Ref.make(0);
      const interruptions = yield* Ref.make(0);

      const model = observedFixture(
        Ref.update(calls, (count) => count + 1).pipe(
          Effect.andThen(Deferred.succeed(started, undefined)),
          Effect.andThen(Deferred.await(release)),
        ),
        Ref.update(interruptions, (count) => count + 1).pipe(
          Effect.andThen(Deferred.succeed(interrupted, undefined)),
          Effect.asVoid,
        ),
      );

      yield* Effect.gen(function* () {
        const first = yield* classifyPanel("broad").pipe(
          Effect.forkChild({ startImmediately: true }),
        );

        yield* Deferred.await(started);

        const second = yield* classifyPanel("broad").pipe(
          Effect.forkChild({ startImmediately: true }),
        );

        yield* Fiber.interrupt(first);
        yield* expectCount(interruptions, 0);
        yield* Fiber.interrupt(second);
        yield* Deferred.await(interrupted);
        yield* expectCount(interruptions, 1);
        yield* expectCount(calls, 1);
        yield* Deferred.succeed(release, undefined);
        const retried = yield* classifyPanel("broad");
        expect(retried.rows).toHaveLength(24);
        yield* expectCount(calls, 5);
        const cached = yield* classifyPanel("broad");
        expect(cached).toBe(retried);
        yield* expectCount(calls, 5);
        yield* expectCount(interruptions, 1);
      }).pipe(Effect.provide(PanelResults.layerNoDeps.pipe(Layer.provide(model))));
    }),
);
