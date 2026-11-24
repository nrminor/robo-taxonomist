// @vitest-environment node
import assert from "node:assert/strict";
import { expect, it } from "@effect/vitest";
import { afterAll, vi } from "vitest";
import {
  Cause,
  Context,
  Data,
  Deferred,
  Effect,
  Exit,
  Layer,
  ManagedRuntime,
  Option,
  Record,
  Redacted,
  Ref,
  Schema,
  Scope,
} from "effect";
import { AiError, DecisionModel } from "effect/ai";
import { HttpClientRequest, HttpClientResponse, HttpServerRequest } from "effect/http";
import { Errors } from "robo-taxonomist";
import { ClassificationFailure, PanelResponse, PublicModelReason } from "../src/lib/contract.ts";
import { FailureDiagnostic } from "../src/lib/failure-diagnostic.ts";
import { POST } from "../src/app/api/classify/route.ts";
import { classifyRequest, makeHandlers } from "../src/server/classify.ts";
import { classifyPanel, PanelResults } from "../src/server/panel-results.ts";
import { expectCount, observedFixture } from "./fixture-decision.ts";
import * as TestJson from "./Json.ts";

vi.stubEnv("DEMO_MODEL", "fixture");

afterAll(() => vi.unstubAllEnvs());

const decodePanelReply = HttpClientResponse.schemaBodyJson(PanelResponse);

const readPanelReply = (request: Request, response: Response) =>
  decodePanelReply(HttpClientResponse.fromWeb(HttpClientRequest.fromWeb(request), response));

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

it.effect("refreshes through the same POST contract without disturbing other cached panels", () =>
  Effect.gen(function* () {
    const calls = yield* Ref.make(0);

    const model = observedFixture(Ref.update(calls, (count) => count + 1));

    const runtime = yield* Effect.acquireRelease(
      Effect.sync(() => ManagedRuntime.make(PanelResults.layerNoDeps.pipe(Layer.provide(model)))),
      (runtime) => runtime.disposeEffect,
    );

    const handlers = makeHandlers(runtime);

    const post = (panelId: string, refresh?: boolean) =>
      Effect.gen(function* () {
        const body = yield* TestJson.encode({ panelId, refresh });

        const request = new Request("http://localhost/api/classify", { method: "POST", body });
        const response = yield* Effect.promise(() => handlers.classifyHttp(request));

        expect(response.status).toBe(200);
        expect(response.headers.get("Cache-Control")).toBe("no-store");

        return yield* readPanelReply(request, response);
      });

    const broad = yield* post("broad");
    yield* expectCount(calls, 4);
    const unchanged = yield* post("broad", false);
    expect(unchanged).toEqual(broad);
    yield* expectCount(calls, 4);
    const focused = yield* post("focused");
    yield* expectCount(calls, 8);
    const refreshed = yield* post("broad", true);
    expect(refreshed).toEqual(broad);
    yield* expectCount(calls, 12);
    const cachedBroad = yield* post("broad");
    expect(cachedBroad).toEqual(broad);
    const cachedFocused = yield* post("focused");
    expect(cachedFocused).toEqual(focused);
    yield* expectCount(calls, 12);

    // Each explicit refresh requests new work; ordinary reads still coalesce separately.
    const repeated = yield* Effect.all([post("broad", true), post("broad", true)], {
      concurrency: 2,
    });

    expect(repeated).toEqual([broad, broad]);
    yield* expectCount(calls, 20);
    const focusedAfterRefreshes = yield* post("focused");
    expect(focusedAfterRefreshes).toEqual(focused);
    yield* expectCount(calls, 20);
  }),
);

it.effect("returns a safe 503 for a failed refresh and performs fresh work on retry", () =>
  Effect.gen(function* () {
    const calls = yield* Ref.make(0);
    const failNext = yield* Ref.make(false);

    const original = new AiError.AiError({
      module: "SECRET fixture",
      method: "decide",
      reason: new AiError.RateLimitError({ metadata: { body: "SECRET body" } }),
    });

    const model = observedFixture(
      Ref.update(calls, (count) => count + 1).pipe(
        Effect.andThen(Ref.getAndSet(failNext, false)),
        Effect.flatMap((armed) => (armed ? Effect.fail(original) : Effect.void)),
      ),
    );

    const runtime = yield* Effect.acquireRelease(
      Effect.sync(() => ManagedRuntime.make(PanelResults.layerNoDeps.pipe(Layer.provide(model)))),
      (runtime) => runtime.disposeEffect,
    );

    const handlers = makeHandlers(runtime);

    const post = (refresh?: boolean) =>
      TestJson.encode({ panelId: "broad", refresh }).pipe(
        Effect.flatMap((body) => {
          const request = new Request("http://localhost/api/classify", { method: "POST", body });

          return Effect.promise(() => handlers.classifyHttp(request)).pipe(
            Effect.map((response) => ({ request, response })),
          );
        }),
      );

    const { response: initial } = yield* post();
    expect(initial.status).toBe(200);
    yield* expectCount(calls, 4);
    yield* Ref.set(failNext, true);
    const { response: failed } = yield* post(true);
    expect(failed.status).toBe(503);
    expect(failed.headers.get("Cache-Control")).toBe("no-store");
    const wire = yield* Effect.promise(() => failed.text());
    expect(wire).not.toContain("SECRET");
    const document = yield* TestJson.decode(wire);

    const expected = yield* TestJson.decode(
      '{"_tag":"ModelFailure","reason":{"_tag":"RateLimitError"},"retryable":true}',
    );

    expect(document).toEqual(expected);
    yield* expectCount(calls, 5);
    const { request: retryRequest, response: retried } = yield* post();
    expect(retried.status).toBe(200);
    const reply = yield* readPanelReply(retryRequest, retried);
    expect(reply.rows).toHaveLength(24);
    yield* expectCount(calls, 9);
    const { response: cached } = yield* post();
    expect(cached.status).toBe(200);
    yield* expectCount(calls, 9);
  }),
);

it.effect("rejects nonboolean refresh values with a safe 400 before any inference", () =>
  Effect.gen(function* () {
    const calls = yield* Ref.make(0);

    const model = observedFixture(Ref.update(calls, (count) => count + 1));

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
      yield* expectCount(calls, 0);
    }
  }),
);

it.effect("rejects malformed hints without exposing their contents or starting inference", () =>
  Effect.gen(function* () {
    const calls = yield* Ref.make(0);

    const model = observedFixture(Ref.update(calls, (count) => count + 1));

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
      const expected = yield* TestJson.decode('{"_tag":"InvalidHints"}');
      expect(document).toEqual(expected);
      yield* expectCount(calls, 0);
    }
  }),
);

it.effect("keeps the rejected hint cause on the internal classification failure", () =>
  Effect.gen(function* () {
    const request = new Request("http://localhost/api/classify", {
      method: "POST",
      body: '{"panelId":"broad","hints":["SECRET",1]}',
    });

    const exit = yield* classifyRequest.pipe(
      Effect.provideService(
        HttpServerRequest.HttpServerRequest,
        HttpServerRequest.fromWeb(request),
      ),
      Effect.provideService(PanelResults, {
        classify: () => Effect.die("Invalid hints must not start classification"),
      }),
      Effect.exit,
    );

    assert(Exit.isFailure(exit));
    const failure = Option.getOrThrow(Cause.findErrorOption(exit.cause));
    expect(failure).toSatisfy(ClassificationFailure.guards.InvalidHints);

    const diagnostic = Context.getOrUndefined(Cause.annotations(exit.cause), FailureDiagnostic);
    assert(diagnostic !== undefined);
    const original = Option.getOrThrow(Cause.findErrorOption(Redacted.value(diagnostic)));
    expect(Schema.isSchemaError(original)).toBe(true);
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

    const request = new Request("http://localhost/api/classify", {
      method: "POST",
      body: requestBody,
    });

    const response = yield* Effect.promise(() => makeHandlers(runtime).classifyHttp(request));

    expect(response.status).toBe(200);
    const reply = yield* readPanelReply(request, response);
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
    const calls = yield* Ref.make(0);
    const interruptions = yield* Ref.make(0);

    const model = observedFixture(
      Ref.update(calls, (count) => count + 1).pipe(
        Effect.andThen(Deferred.succeed(started, undefined)),
        Effect.andThen(Deferred.await(release)),
      ),
      Ref.update(interruptions, (count) => count + 1),
    );

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

    const remainingRequest = new Request("http://localhost/api/classify", {
      method: "POST",
      body: requestBody,
      signal: remainingSignal,
    });

    const remaining = handlers.classifyHttp(remainingRequest);

    yield* Effect.promise(() => runtime.runPromise(Effect.yieldNow));
    yield* expectCount(calls, 1);
    yield* Scope.close(clientScope, Exit.void);
    const response = yield* Effect.promise(() => cancelled);
    expect(response.status).toBe(499);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body = yield* Effect.promise(() => response.text());
    expect(body).toBe("");
    yield* expectCount(interruptions, 0);
    yield* Deferred.succeed(release, undefined);
    const remainingResponse = yield* Effect.promise(() => remaining);
    expect(remainingResponse.status).toBe(200);
    expect(remainingResponse.headers.get("Cache-Control")).toBe("no-store");
    const reply = yield* readPanelReply(remainingRequest, remainingResponse);
    expect(reply.rows).toHaveLength(24);
    // Both HTTP waiters share the four provider batches for this panel.
    yield* expectCount(calls, 4);
    yield* expectCount(interruptions, 0);
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
    const expected = TestJson.decodeSync('{"_tag":"InternalFailure"}');
    expect(TestJson.decodeSync(wire)).toEqual(expected);

    const repeated = await handlers.classifyHttp(
      new Request("http://localhost/api/classify", {
        method: "POST",
        body: TestJson.encodeSync({ panelId: "broad" }),
      }),
    );

    expect(repeated.status).toBe(500);
    expect(TestJson.decodeSync(await repeated.text())).toEqual(expected);
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
    expect(TestJson.decodeSync(wire)).toEqual(
      TestJson.decodeSync(
        '{"_tag":"ModelFailure","reason":{"_tag":"RateLimitError"},"retryable":true}',
      ),
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
  const wire = TestJson.decodeSync(await response.text());
  const reply = Schema.decodeUnknownSync(Schema.toCodecJson(PanelResponse))(wire);
  expect(reply.panelId).toBe("broad");
  expect(reply.rows).toHaveLength(24);
  expect(() => Schema.decodeUnknownSync(Schema.toCodecJson(ClassificationFailure))(wire)).toThrow();
});

it.effect("classifies the nested panel through the POST wire contract", () =>
  Effect.gen(function* () {
    const request = new Request("http://localhost/api/classify", {
      method: "POST",
      body: TestJson.encodeSync({ panelId: "nested" }),
    });

    const response = yield* Effect.promise(() => POST(request));
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const reply = yield* readPanelReply(request, response);
    expect(reply.panelId).toBe("nested");
    expect(reply.rows).toHaveLength(24);
  }),
);

it.each([
  TestJson.encodeSync({ panelId: "SECRET invalid panel" }),
  "SECRET malformed JSON",
  TestJson.encodeSync({ panelId: "nested", records: [{ name: "SECRET record" }] }),
  TestJson.encodeSync({ panelId: "nested", provider: "SECRET provider" }),
  TestJson.encodeSync({ panelId: "nested", extra: "SECRET extra field" }),
  TestJson.encodeSync({ panelId: "nested", extra: true, hints: ["SECRET", 1] }),
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
  expect(TestJson.decodeSync(wire)).toEqual(TestJson.decodeSync('{"_tag":"InvalidPanel"}'));
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
