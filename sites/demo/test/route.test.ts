// @vitest-environment node
import { expect, it } from "@effect/vitest";
import { afterAll, vi } from "vitest";
import { Deferred, Effect, Layer, ManagedRuntime, Schema } from "effect";
import { AiError, DecisionModel } from "effect/ai";
import { ClassificationFailure, PanelResponse, PublicModelReason } from "../src/lib/contract.ts";
import { POST } from "../src/app/api/classify/route.ts";
import { makeHandlers } from "../src/server/classify.ts";
import { PanelResults } from "../src/server/panel-results.ts";
import { FixtureModel } from "../src/server/fixture-model.ts";

vi.mock("server-only", () => ({}));
vi.stubEnv("DEMO_MODEL", "fixture");
afterAll(() => vi.unstubAllEnvs());

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
        const response = yield* Effect.promise(() =>
          handlers.classifyHttp(
            new Request("http://localhost/api/classify", {
              method: "POST",
              body: JSON.stringify({ panelId, refresh }),
            }),
          ),
        );
        expect(response.status).toBe(200);
        expect(response.headers.get("Cache-Control")).toBe("no-store");
        return yield* Schema.decodeUnknownEffect(Schema.toCodecJson(PanelResponse))(
          yield* Effect.promise(() => response.json()),
        );
      });
    const broad = yield* post("broad");
    expect(calls).toBe(4);
    expect(yield* post("broad", false)).toEqual(broad);
    expect(calls).toBe(4);
    const focused = yield* post("focused");
    expect(calls).toBe(8);
    expect(yield* post("broad", true)).toEqual(broad);
    expect(calls).toBe(12);
    expect(yield* post("broad")).toEqual(broad);
    expect(yield* post("focused")).toEqual(focused);
    expect(calls).toBe(12);
    // Each explicit refresh requests new work; ordinary reads still coalesce separately.
    const repeated = yield* Effect.all([post("broad", true), post("broad", true)], {
      concurrency: 2,
    });
    expect(repeated).toEqual([broad, broad]);
    expect(calls).toBe(20);
    expect(yield* post("focused")).toEqual(focused);
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
      Effect.promise(() =>
        handlers.classifyHttp(
          new Request("http://localhost/api/classify", {
            method: "POST",
            body: JSON.stringify({ panelId: "broad", refresh }),
          }),
        ),
      );
    expect((yield* post()).status).toBe(200);
    expect(calls).toBe(4);
    const failed = yield* post(true);
    expect(failed.status).toBe(503);
    expect(failed.headers.get("Cache-Control")).toBe("no-store");
    const wire = yield* Effect.promise(() => failed.text());
    expect(wire).not.toContain("SECRET");
    expect(
      yield* Schema.decodeUnknownEffect(Schema.toCodecJson(ClassificationFailure))(
        JSON.parse(wire),
      ),
    ).toEqual(
      ClassificationFailure.cases.ModelFailure.make({
        reason: PublicModelReason.cases.RateLimitError.make({}),
        retryable: true,
      }),
    );
    expect(calls).toBe(5);
    const retried = yield* post();
    expect(retried.status).toBe(200);
    const reply = yield* Schema.decodeUnknownEffect(Schema.toCodecJson(PanelResponse))(
      yield* Effect.promise(() => retried.json()),
    );
    expect(reply.rows).toHaveLength(24);
    expect(calls).toBe(9);
    expect((yield* post()).status).toBe(200);
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
      const response = yield* Effect.promise(() =>
        handlers.classifyHttp(
          new Request("http://localhost/api/classify", {
            method: "POST",
            body: JSON.stringify({ panelId: "broad", refresh }),
          }),
        ),
      );
      expect(response.status).toBe(400);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      const wire = yield* Effect.promise(() => response.text());
      expect(wire).not.toContain("SECRET");
      expect(
        yield* Schema.decodeUnknownEffect(Schema.toCodecJson(ClassificationFailure))(
          JSON.parse(wire),
        ),
      ).toEqual(ClassificationFailure.cases.InvalidPanel.make({}));
      expect(calls).toBe(0);
    }
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
    const controller = new AbortController();
    const pending = makeHandlers(runtime).classifyHttp(
      new Request("http://localhost/api/classify", {
        method: "POST",
        body: JSON.stringify({ panelId: "broad" }),
        signal: controller.signal,
      }),
    );
    yield* Effect.promise(() => runtime.runPromise(Deferred.await(started)));
    controller.abort(new Error("SECRET cancellation"));
    const response = yield* Effect.promise(() => pending);
    expect(response.status).toBe(499);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(yield* Effect.promise(() => response.text())).toBe("");
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
    const controller = new AbortController();
    const cancelled = handlers.classifyHttp(
      new Request("http://localhost/api/classify", {
        method: "POST",
        body: JSON.stringify({ panelId: "broad" }),
        signal: controller.signal,
      }),
    );
    yield* Effect.promise(() => runtime.runPromise(Deferred.await(started)));
    const remaining = handlers.classifyHttp(
      new Request("http://localhost/api/classify", {
        method: "POST",
        body: JSON.stringify({ panelId: "broad" }),
      }),
    );
    yield* Effect.promise(() => runtime.runPromise(Effect.yieldNow));
    expect(calls).toBe(1);
    controller.abort(new Error("SECRET cancellation"));
    const response = yield* Effect.promise(() => cancelled);
    expect(response.status).toBe(499);
    expect(yield* Effect.promise(() => response.text())).toBe("");
    expect(interruptions).toBe(0);
    yield* Deferred.succeed(release, undefined);
    const remainingResponse = yield* Effect.promise(() => remaining);
    expect(remainingResponse.status).toBe(200);
    expect(remainingResponse.headers.get("Cache-Control")).toBe("no-store");
    const reply = yield* Schema.decodeUnknownEffect(Schema.toCodecJson(PanelResponse))(
      yield* Effect.promise(() => remainingResponse.json()),
    );
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
        body: JSON.stringify({ panelId: "broad" }),
      }),
    );
    expect(response.status).toBe(500);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const wire = await response.text();
    expect(wire).not.toContain("SECRET");
    const expected = ClassificationFailure.cases.InternalFailure.make({});
    expect(
      Schema.decodeUnknownSync(Schema.toCodecJson(ClassificationFailure))(JSON.parse(wire)),
    ).toEqual(expected);
    const repeated = await handlers.classifyHttp(
      new Request("http://localhost/api/classify", {
        method: "POST",
        body: JSON.stringify({ panelId: "broad" }),
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
        body: JSON.stringify({ panelId: "broad" }),
      }),
    );
    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const wire = await response.text();
    expect(wire).not.toContain("SECRET");
    expect(
      Schema.decodeUnknownSync(Schema.toCodecJson(ClassificationFailure))(JSON.parse(wire)),
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
      body: JSON.stringify({ panelId: "broad" }),
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
      body: JSON.stringify({ panelId: "nested" }),
    }),
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  const reply = Schema.decodeUnknownSync(Schema.toCodecJson(PanelResponse))(await response.json());
  expect(reply.panelId).toBe("nested");
  expect(reply.rows).toHaveLength(24);
});

it.each([
  JSON.stringify({ panelId: "SECRET invalid panel" }),
  "SECRET malformed JSON",
  JSON.stringify({ panelId: "nested", records: [{ name: "SECRET record" }] }),
  JSON.stringify({ panelId: "nested", provider: "SECRET provider" }),
  JSON.stringify({ panelId: "nested", extra: "SECRET extra field" }),
  JSON.stringify({}),
  JSON.stringify(null),
])("rejects invalid input with a safe 400 reply: %s", async (body) => {
  const response = await POST(
    new Request("http://localhost/api/classify", { method: "POST", body }),
  );
  expect(response.status).toBe(400);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  const wire = await response.text();
  expect(wire).not.toContain("SECRET");
  expect(
    Schema.decodeUnknownSync(Schema.toCodecJson(ClassificationFailure))(JSON.parse(wire)),
  ).toEqual(ClassificationFailure.cases.InvalidPanel.make({}));
});

it("does not serialize an internal failure for an already cancelled request", async () => {
  const controller = new AbortController();
  controller.abort(new Error("SECRET cancellation reason"));
  const response = await POST(
    new Request("http://localhost/api/classify", {
      method: "POST",
      body: JSON.stringify({ panelId: "nested" }),
      signal: controller.signal,
    }),
  );
  expect(response.status).toBe(499);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(await response.text()).toBe("");
});
