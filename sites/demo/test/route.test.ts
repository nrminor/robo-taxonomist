// @vitest-environment node
import { expect, it } from "@effect/vitest";
import { vi } from "vitest";
import { Deferred, Effect, Layer, ManagedRuntime, Result, Schema } from "effect";
import { AiError, DecisionModel } from "effect/ai";
import {
  ClassificationFailure,
  ClassificationReply,
  PublicModelReason,
} from "../src/lib/contract.ts";
import { POST } from "../src/app/api/classify/route.ts";
import { initialReply, makeHandlers } from "../src/server/classify.ts";
import { PanelResults } from "../src/server/panel-results.ts";
import { FixtureModel } from "../src/server/fixture-model.ts";

vi.mock("server-only", () => ({}));

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

it.effect("cancels an active HTTP request without cancelling a shared initial render", () =>
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
    const remaining = handlers.initialReply();
    yield* Effect.promise(() => runtime.runPromise(Effect.yieldNow));
    expect(calls).toBe(1);
    controller.abort(new Error("SECRET cancellation"));
    const response = yield* Effect.promise(() => cancelled);
    expect(response.status).toBe(499);
    expect(yield* Effect.promise(() => response.text())).toBe("");
    expect(interruptions).toBe(0);
    yield* Deferred.succeed(release, undefined);
    const reply = Schema.decodeSync(ClassificationReply)(yield* Effect.promise(() => remaining));
    expect(Result.isSuccess(reply)).toBe(true);
    if (Result.isSuccess(reply)) expect(reply.success.rows).toHaveLength(24);
    // Both entry points share the two provider batches for this panel.
    expect(calls).toBe(2);
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
    const expected = Result.fail(ClassificationFailure.cases.InternalFailure.make({}));
    expect(Schema.decodeUnknownSync(ClassificationReply)(JSON.parse(wire))).toEqual(expected);
    expect(Schema.decodeSync(ClassificationReply)(await handlers.initialReply())).toEqual(expected);
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
    expect(Schema.decodeUnknownSync(ClassificationReply)(JSON.parse(wire))).toEqual(
      Result.fail(
        ClassificationFailure.cases.ModelFailure.make({
          reason: PublicModelReason.cases.RateLimitError.make({}),
          retryable: true,
        }),
      ),
    );
  } finally {
    await runtime.dispose();
  }
});

it("loads Broad survey directly for initial rendering", async () => {
  const reply = Schema.decodeSync(ClassificationReply)(await initialReply());
  expect(Result.isSuccess(reply)).toBe(true);
  if (Result.isSuccess(reply)) {
    expect(reply.success.panelId).toBe("broad");
    expect(reply.success.rows).toHaveLength(24);
  }
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
  const reply = Schema.decodeUnknownSync(ClassificationReply)(await response.json());
  expect(Result.isSuccess(reply)).toBe(true);
  if (Result.isSuccess(reply)) {
    expect(reply.success.panelId).toBe("nested");
    expect(reply.success.rows).toHaveLength(24);
  }
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
  expect(Schema.decodeUnknownSync(ClassificationReply)(JSON.parse(wire))).toEqual(
    Result.fail(ClassificationFailure.cases.InvalidPanel.make({})),
  );
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
