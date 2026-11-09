// @vitest-environment node
import { expect, it } from "@effect/vitest";
import { afterAll, vi } from "vitest";
import { Data, Deferred, Effect, Exit, Layer, ManagedRuntime, Record, Schema, Scope } from "effect";
import { AiError, DecisionModel } from "effect/ai";
import { Errors } from "robo-taxonomist";
import { ClassificationFailure, PanelResponse, PublicModelReason } from "../src/lib/contract.ts";
import { POST } from "../src/app/api/classify/route.ts";
import { makeHandlers } from "../src/server/classify.ts";
import { classifyPanel, PanelResults } from "../src/server/panel-results.ts";
import { FixtureModel } from "../src/server/fixture-model.ts";
import * as TestJson from "./Json.ts";

vi.mock("server-only", () => ({}));
vi.stubEnv("DEMO_MODEL", "fixture");
afterAll(() => vi.unstubAllEnvs());

it.effect("treats invalid server catalog input as a safe internal failure", () =>
  Effect.gen(function* () {
    const cause = yield* Schema.decodeUnknownEffect(Schema.Finite)("SECRET catalog").pipe(
      Effect.flip,
    );
    const original = new Errors.InvalidInput({ cause });
    const runtime = yield* Effect.acquireRelease(
      Effect.sync(() =>
        ManagedRuntime.make(
          Layer.succeed(PanelResults, {
            classify: () => Effect.fail(original),
          }),
        ),
      ),
      (runtime) => runtime.disposeEffect,
    );
    const internal = yield* Effect.promise(() =>
      runtime.runPromise(Effect.flip(classifyPanel("broad"))),
    );
    expect(internal).toBe(original);
    expect(original.cause).toBe(cause);
    const requestBody = yield* TestJson.encode({ panelId: "broad" });
    const response = yield* Effect.promise(() =>
      makeHandlers(runtime).classifyHttp(
        new Request("http://localhost/api/classify", {
          method: "POST",
          body: requestBody,
        }),
      ),
    );
    expect(response.status).toBe(500);
    const wire = yield* Effect.promise(() => response.text());
    expect(wire).not.toContain("SECRET");
    const document = yield* TestJson.decode(wire);
    const failure = yield* Schema.decodeUnknownEffect(Schema.toCodecJson(ClassificationFailure))(
      document,
    );
    expect(failure).toEqual(ClassificationFailure.cases.InternalFailure.make({}));
  }),
);

it.effect("preserves the provider error until the HTTP boundary", () =>
  Effect.gen(function* () {
    const original = new AiError.AiError({
      module: "SECRET provider",
      method: "decide",
      reason: new AiError.RateLimitError({ metadata: { body: "SECRET body" } }),
    });
    const model = Layer.effect(
      DecisionModel.DecisionModel,
      DecisionModel.make({ decide: () => Effect.fail(original) }),
    );
    const runtime = yield* Effect.acquireRelease(
      Effect.sync(() => ManagedRuntime.make(PanelResults.layerNoDeps.pipe(Layer.provide(model)))),
      (runtime) => runtime.disposeEffect,
    );
    const error = yield* Effect.promise(() =>
      runtime.runPromise(Effect.flip(classifyPanel("broad"))),
    );
    expect(error).toBe(original);
    const requestBody = yield* TestJson.encode({ panelId: "broad" });
    const response = yield* Effect.promise(() =>
      makeHandlers(runtime).classifyHttp(
        new Request("http://localhost/api/classify", {
          method: "POST",
          body: requestBody,
        }),
      ),
    );
    expect(response.status).toBe(503);
    const wire = yield* Effect.promise(() => response.text());
    expect(wire).not.toContain("SECRET");
    const document = yield* TestJson.decode(wire);
    const failure = yield* Schema.decodeUnknownEffect(Schema.toCodecJson(ClassificationFailure))(
      document,
    );
    expect(failure).toEqual(
      ClassificationFailure.cases.ModelFailure.make({
        reason: PublicModelReason.cases.RateLimitError.make({}),
        retryable: true,
      }),
    );
  }),
);

const observedFixture = (before: () => Effect.Effect<void, AiError.AiError>) =>
  Layer.effect(
    DecisionModel.DecisionModel,
    Effect.gen(function* () {
      const fixture = yield* DecisionModel.DecisionModel;
      return DecisionModel.DecisionModel.of({
        ...fixture,
        decide: (definition, options) =>
          before().pipe(Effect.andThen(fixture.decide(definition, options))),
      });
    }),
  ).pipe(Layer.provide(FixtureModel));

it.effect("refreshes through the same POST contract without disturbing other cached panels", () =>
  Effect.gen(function* () {
    let calls = 0;
    const model = observedFixture(() =>
      Effect.sync(() => {
        calls++;
      }),
    );
    const runtime = yield* Effect.acquireRelease(
      Effect.sync(() => ManagedRuntime.make(PanelResults.layerNoDeps.pipe(Layer.provide(model)))),
      (runtime) => runtime.disposeEffect,
    );
    const handlers = makeHandlers(runtime);
    const post = (panelId: string, refresh?: boolean) =>
      Effect.gen(function* () {
        const body = yield* TestJson.encode({ panelId, refresh });
        const response = yield* Effect.promise(() =>
          handlers.classifyHttp(
            new Request("http://localhost/api/classify", {
              method: "POST",
              body,
            }),
          ),
        );
        expect(response.status).toBe(200);
        expect(response.headers.get("Cache-Control")).toBe("no-store");
        const decodeResponse = Schema.decodeUnknownEffect(Schema.toCodecJson(PanelResponse));
        const value = yield* Effect.promise(() => response.json());
        return yield* decodeResponse(value);
      });
    const broad = yield* post("broad");
    expect(calls).toBe(4);
    const unchanged = yield* post("broad", false);
    expect(unchanged).toEqual(broad);
    expect(calls).toBe(4);
    const focused = yield* post("focused");
    expect(calls).toBe(8);
    const refreshed = yield* post("broad", true);
    expect(refreshed).toEqual(broad);
    expect(calls).toBe(12);
    const cachedBroad = yield* post("broad");
    expect(cachedBroad).toEqual(broad);
    const cachedFocused = yield* post("focused");
    expect(cachedFocused).toEqual(focused);
    expect(calls).toBe(12);
    // Each explicit refresh requests new work; ordinary reads still coalesce separately.
    const repeated = yield* Effect.all([post("broad", true), post("broad", true)], {
      concurrency: 2,
    });
    expect(repeated).toEqual([broad, broad]);
    expect(calls).toBe(20);
    const focusedAfterRefreshes = yield* post("focused");
    expect(focusedAfterRefreshes).toEqual(focused);
    expect(calls).toBe(20);
  }),
);

it.effect("returns a safe 503 for a failed refresh and performs fresh work on retry", () =>
  Effect.gen(function* () {
    let calls = 0;
    const model = observedFixture(() =>
      Effect.suspend(() => {
        calls++;
        return calls === 5
          ? Effect.fail(
              new AiError.AiError({
                module: "SECRET fixture",
                method: "decide",
                reason: new AiError.RateLimitError({ metadata: { body: "SECRET body" } }),
              }),
            )
          : Effect.void;
      }),
    );
    const runtime = yield* Effect.acquireRelease(
      Effect.sync(() => ManagedRuntime.make(PanelResults.layerNoDeps.pipe(Layer.provide(model)))),
      (runtime) => runtime.disposeEffect,
    );
    const handlers = makeHandlers(runtime);
    const post = (refresh?: boolean) =>
      TestJson.encode({ panelId: "broad", refresh }).pipe(
        Effect.flatMap((body) =>
          Effect.promise(() =>
            handlers.classifyHttp(
              new Request("http://localhost/api/classify", {
                method: "POST",
                body,
              }),
            ),
          ),
        ),
      );
    const initial = yield* post();
    expect(initial.status).toBe(200);
    expect(calls).toBe(4);
    const failed = yield* post(true);
    expect(failed.status).toBe(503);
    expect(failed.headers.get("Cache-Control")).toBe("no-store");
    const wire = yield* Effect.promise(() => failed.text());
    expect(wire).not.toContain("SECRET");
    const document = yield* TestJson.decode(wire);
    const failure = yield* Schema.decodeUnknownEffect(Schema.toCodecJson(ClassificationFailure))(
      document,
    );
    expect(failure).toEqual(
      ClassificationFailure.cases.ModelFailure.make({
        reason: PublicModelReason.cases.RateLimitError.make({}),
        retryable: true,
      }),
    );
    expect(calls).toBe(5);
    const retried = yield* post();
    expect(retried.status).toBe(200);
    const decodeResponse = Schema.decodeUnknownEffect(Schema.toCodecJson(PanelResponse));
    const value = yield* Effect.promise(() => retried.json());
    const reply = yield* decodeResponse(value);
    expect(reply.rows).toHaveLength(24);
    expect(calls).toBe(9);
    const cached = yield* post();
    expect(cached.status).toBe(200);
    expect(calls).toBe(9);
  }),
);

it.effect("rejects nonboolean refresh values with a safe 400 before any inference", () =>
  Effect.gen(function* () {
    let calls = 0;
    const model = observedFixture(() =>
      Effect.sync(() => {
        calls++;
      }),
    );
    const runtime = yield* Effect.acquireRelease(
      Effect.sync(() => ManagedRuntime.make(PanelResults.layerNoDeps.pipe(Layer.provide(model)))),
      (runtime) => runtime.disposeEffect,
    );
    const handlers = makeHandlers(runtime);
    for (const refresh of ["true", "false", "SECRET", 0, 1, null, [], {}]) {
      const body = yield* TestJson.encode({ panelId: "broad", refresh });
      const response = yield* Effect.promise(() =>
        handlers.classifyHttp(
          new Request("http://localhost/api/classify", {
            method: "POST",
            body,
          }),
        ),
      );
      expect(response.status).toBe(400);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      const wire = yield* Effect.promise(() => response.text());
      expect(wire).not.toContain("SECRET");
      const document = yield* TestJson.decode(wire);
      const failure = yield* Schema.decodeUnknownEffect(Schema.toCodecJson(ClassificationFailure))(
        document,
      );
      expect(failure).toEqual(ClassificationFailure.cases.InvalidPanel.make({}));
      expect(calls).toBe(0);
    }
  }),
);

it.effect("rejects malformed hints without exposing their contents or starting inference", () =>
  Effect.gen(function* () {
    let calls = 0;
    const model = observedFixture(() =>
      Effect.sync(() => {
        calls++;
      }),
    );
    const runtime = yield* Effect.acquireRelease(
      Effect.sync(() => ManagedRuntime.make(PanelResults.layerNoDeps.pipe(Layer.provide(model)))),
      (runtime) => runtime.disposeEffect,
    );
    for (const hints of ["SECRET", null, {}, ["   "], ["SECRET", 1]]) {
      const body = yield* TestJson.encode({ panelId: "broad", hints });
      const response = yield* Effect.promise(() =>
        makeHandlers(runtime).classifyHttp(
          new Request("http://localhost/api/classify", {
            method: "POST",
            body,
          }),
        ),
      );
      expect(response.status).toBe(400);
      const wire = yield* Effect.promise(() => response.text());
      expect(wire).not.toContain("SECRET");
      const document = yield* TestJson.decode(wire);
      expect(document).toEqual({ _tag: "InvalidHints" });
      expect(calls).toBe(0);
    }
  }),
);

it.effect("passes exact hint text through HTTP to every Broad batch", () =>
  Effect.gen(function* () {
    const states: DecisionModel.ProviderOptions["state"][] = [];
    const { Classify } = Data.taggedEnum<DecisionModel.ProviderClassifyAnswer>();
    const model = Layer.effect(
      DecisionModel.DecisionModel,
      DecisionModel.make({
        decide: ({ state, decisions }) => {
          states.push(state);
          return Effect.succeed({
            answers: Record.map(decisions, () =>
              Classify({
                label: "undetermined",
                probabilities: { sameTaxon: 0, withinTaxon: 0, noMatch: 0, undetermined: 1 },
              }),
            ),
            usage: { inputTokens: undefined, outputTokens: undefined },
          });
        },
      }),
    );
    const runtime = yield* Effect.acquireRelease(
      Effect.sync(() => ManagedRuntime.make(PanelResults.layerNoDeps.pipe(Layer.provide(model)))),
      (runtime) => runtime.disposeEffect,
    );
    const requestBody = yield* TestJson.encode({
      panelId: "broad",
      hints: ["  contextual note  "],
    });
    const response = yield* Effect.promise(() =>
      makeHandlers(runtime).classifyHttp(
        new Request("http://localhost/api/classify", {
          method: "POST",
          body: requestBody,
        }),
      ),
    );
    expect(response.status).toBe(200);
    const decodeResponse = Schema.decodeUnknownEffect(Schema.toCodecJson(PanelResponse));
    const value = yield* Effect.promise(() => response.json());
    const reply = yield* decodeResponse(value);
    expect(reply.rows).toHaveLength(24);
    expect(reply.rows.every((row) => row.matches.length === 6)).toBe(true);
    expect(states).toHaveLength(4);
    for (const state of states) expect(state).toMatchObject({ hints: ["  contextual note  "] });
  }),
);

it.effect("interrupts provider work when its active HTTP request is cancelled", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const interrupted = yield* Deferred.make<void>();
    const model = Layer.effect(
      DecisionModel.DecisionModel,
      DecisionModel.make({
        decide: () =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
          ),
      }),
    );
    const runtime = yield* Effect.acquireRelease(
      Effect.sync(() => ManagedRuntime.make(PanelResults.layerNoDeps.pipe(Layer.provide(model)))),
      (runtime) => runtime.disposeEffect,
    );
    const clientScope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
      Scope.close(scope, Exit.void),
    );
    const signal = yield* Effect.abortSignal.pipe(Scope.provide(clientScope));
    const requestBody = yield* TestJson.encode({ panelId: "broad" });
    const pending = makeHandlers(runtime).classifyHttp(
      new Request("http://localhost/api/classify", {
        method: "POST",
        body: requestBody,
        signal,
      }),
    );
    yield* Effect.promise(() => runtime.runPromise(Deferred.await(started)));
    yield* Scope.close(clientScope, Exit.void);
    const response = yield* Effect.promise(() => pending);
    expect(response.status).toBe(499);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body = yield* Effect.promise(() => response.text());
    expect(body).toBe("");
    yield* Deferred.await(interrupted);
  }),
);

it.effect("cancels one HTTP waiter without cancelling another request for the same panel", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
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
                Effect.sync(() => {
                  interruptions++;
                }),
              ),
            ),
        });
      }),
    ).pipe(Layer.provide(FixtureModel));
    const runtime = yield* Effect.acquireRelease(
      Effect.sync(() => ManagedRuntime.make(PanelResults.layerNoDeps.pipe(Layer.provide(model)))),
      (runtime) => runtime.disposeEffect,
    );
    const handlers = makeHandlers(runtime);
    const clientScope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
      Scope.close(scope, Exit.void),
    );
    const signal = yield* Effect.abortSignal.pipe(Scope.provide(clientScope));
    const remainingClientScope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
      Scope.close(scope, Exit.void),
    );
    const remainingSignal = yield* Effect.abortSignal.pipe(Scope.provide(remainingClientScope));
    const requestBody = yield* TestJson.encode({ panelId: "broad" });
    const cancelled = handlers.classifyHttp(
      new Request("http://localhost/api/classify", {
        method: "POST",
        body: requestBody,
        signal,
      }),
    );
    yield* Deferred.await(started);
    const remaining = handlers.classifyHttp(
      new Request("http://localhost/api/classify", {
        method: "POST",
        body: requestBody,
        signal: remainingSignal,
      }),
    );
    yield* Effect.promise(() => runtime.runPromise(Effect.yieldNow));
    expect(calls).toBe(1);
    yield* Scope.close(clientScope, Exit.void);
    const response = yield* Effect.promise(() => cancelled);
    expect(response.status).toBe(499);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body = yield* Effect.promise(() => response.text());
    expect(body).toBe("");
    expect(interruptions).toBe(0);
    yield* Deferred.succeed(release, undefined);
    const remainingResponse = yield* Effect.promise(() => remaining);
    expect(remainingResponse.status).toBe(200);
    expect(remainingResponse.headers.get("Cache-Control")).toBe("no-store");
    const decodeResponse = Schema.decodeUnknownEffect(Schema.toCodecJson(PanelResponse));
    const value = yield* Effect.promise(() => remainingResponse.json());
    const reply = yield* decodeResponse(value);
    expect(reply.rows).toHaveLength(24);
    // Both HTTP waiters share the four provider batches for this panel.
    expect(calls).toBe(4);
    expect(interruptions).toBe(0);
  }),
);

it("returns only a safe 500 reply for a provider defect", async () => {
  const model = Layer.effect(
    DecisionModel.DecisionModel,
    DecisionModel.make({ decide: () => Effect.die(new Error("SECRET defect")) }),
  );
  const runtime = ManagedRuntime.make(PanelResults.layerNoDeps.pipe(Layer.provide(model)));
  try {
    const handlers = makeHandlers(runtime);
    const response = await handlers.classifyHttp(
      new Request("http://localhost/api/classify", {
        method: "POST",
        body: TestJson.encodeSync({ panelId: "broad" }),
      }),
    );
    expect(response.status).toBe(500);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const wire = await response.text();
    expect(wire).not.toContain("SECRET");
    const expected = ClassificationFailure.cases.InternalFailure.make({});
    expect(
      Schema.decodeUnknownSync(Schema.toCodecJson(ClassificationFailure))(
        TestJson.decodeSync(wire),
      ),
    ).toEqual(expected);
    const repeated = await handlers.classifyHttp(
      new Request("http://localhost/api/classify", {
        method: "POST",
        body: TestJson.encodeSync({ panelId: "broad" }),
      }),
    );
    expect(repeated.status).toBe(500);
    expect(
      Schema.decodeUnknownSync(Schema.toCodecJson(ClassificationFailure))(await repeated.json()),
    ).toEqual(expected);
  } finally {
    await runtime.dispose();
  }
});

it("returns a safe 503 reply when classification fails at the provider", async () => {
  const model = Layer.effect(
    DecisionModel.DecisionModel,
    DecisionModel.make({
      decide: () =>
        Effect.fail(
          new AiError.AiError({
            module: "SECRET module",
            method: "decide",
            reason: new AiError.RateLimitError({ metadata: { body: "SECRET provider body" } }),
          }),
        ),
    }),
  );
  const runtime = ManagedRuntime.make(PanelResults.layerNoDeps.pipe(Layer.provide(model)));
  try {
    const response = await makeHandlers(runtime).classifyHttp(
      new Request("http://localhost/api/classify", {
        method: "POST",
        body: TestJson.encodeSync({ panelId: "broad" }),
      }),
    );
    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const wire = await response.text();
    expect(wire).not.toContain("SECRET");
    expect(
      Schema.decodeUnknownSync(Schema.toCodecJson(ClassificationFailure))(
        TestJson.decodeSync(wire),
      ),
    ).toEqual(
      ClassificationFailure.cases.ModelFailure.make({
        reason: PublicModelReason.cases.RateLimitError.make({}),
        retryable: true,
      }),
    );
  } finally {
    await runtime.dispose();
  }
});

it("classifies the initial Broad groups panel through the POST wire contract", async () => {
  const response = await POST(
    new Request("http://localhost/api/classify", {
      method: "POST",
      body: TestJson.encodeSync({ panelId: "broad" }),
    }),
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  const wire = await response.json();
  const reply = Schema.decodeUnknownSync(Schema.toCodecJson(PanelResponse))(wire);
  expect(reply.panelId).toBe("broad");
  expect(reply.rows).toHaveLength(24);
  expect(() => Schema.decodeUnknownSync(Schema.toCodecJson(ClassificationFailure))(wire)).toThrow();
});

it("classifies the nested panel through the POST wire contract", async () => {
  const response = await POST(
    new Request("http://localhost/api/classify", {
      method: "POST",
      body: TestJson.encodeSync({ panelId: "nested" }),
    }),
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  const reply = Schema.decodeUnknownSync(Schema.toCodecJson(PanelResponse))(await response.json());
  expect(reply.panelId).toBe("nested");
  expect(reply.rows).toHaveLength(24);
});

it.each([
  TestJson.encodeSync({ panelId: "SECRET invalid panel" }),
  "SECRET malformed JSON",
  TestJson.encodeSync({ panelId: "nested", records: [{ name: "SECRET record" }] }),
  TestJson.encodeSync({ panelId: "nested", provider: "SECRET provider" }),
  TestJson.encodeSync({ panelId: "nested", extra: "SECRET extra field" }),
  TestJson.encodeSync({}),
  TestJson.encodeSync(null),
])("rejects invalid input with a safe 400 reply: %s", async (body) => {
  const response = await POST(
    new Request("http://localhost/api/classify", { method: "POST", body }),
  );
  expect(response.status).toBe(400);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  const wire = await response.text();
  expect(wire).not.toContain("SECRET");
  expect(
    Schema.decodeUnknownSync(Schema.toCodecJson(ClassificationFailure))(TestJson.decodeSync(wire)),
  ).toEqual(ClassificationFailure.cases.InvalidPanel.make({}));
});

it("does not serialize an internal failure for an already cancelled request", async () => {
  const controller = new AbortController();
  controller.abort(new Error("SECRET cancellation reason"));
  const response = await POST(
    new Request("http://localhost/api/classify", {
      method: "POST",
      body: TestJson.encodeSync({ panelId: "nested" }),
      signal: controller.signal,
    }),
  );
  expect(response.status).toBe(499);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(await response.text()).toBe("");
});
