import { expect, vi } from "vitest";
import { Deferred, Effect, Fiber, Layer, Queue, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import { ClassifyRequest } from "../src/lib/contract.ts";

type Fetch = typeof FetchHttpClient.Fetch.Service;

const fetchAborted = (signal: AbortSignal | null | undefined) =>
  Effect.callback<void>((resume) => {
    if (signal == null) {
      resume(Effect.die(new Error("Expected a request with an abort signal")));

      return;
    }

    if (signal.aborted) {
      resume(Effect.void);

      return;
    }

    const onAbort = () => resume(Effect.void);
    signal.addEventListener("abort", onAbort, { once: true });

    return Effect.sync(() => signal.removeEventListener("abort", onAbort));
  });

type PendingFetch = {
  readonly aborted: Effect.Effect<void>;
  readonly reply: Deferred.Deferred<Response>;
};

/** Keep the real Fetch adapter while letting the test release each reply. */
export const makeControlledFetchLayer = Effect.fn("DemoTest.makeControlledFetchLayer")(
  function* () {
    const scope = yield* Effect.scope;
    const arrivals = yield* Queue.unbounded<PendingFetch>();
    const context = yield* Effect.context();

    const fetch: Fetch = (_input, init) =>
      Effect.gen(function* () {
        const reply = yield* Deferred.make<Response>();
        yield* Queue.offer(arrivals, { aborted: fetchAborted(init?.signal), reply });

        return yield* Deferred.await(reply);
      }).pipe(
        // A superseded reply must still be deliverable; the test scope owns cleanup.
        Effect.forkIn(scope),
        Effect.flatMap(Fiber.join),
        Effect.runPromiseWith(context),
      );

    const layer = FetchHttpClient.layer.pipe(
      Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch)),
    );

    return { layer, next: Queue.take(arrivals), pendingRequests: Queue.size(arrivals) };
  },
);

/** Observe the first call to a fetch response handler without changing when it replies. */
export const observeFetch = (respond: typeof globalThis.fetch) => {
  const started = Promise.withResolvers<Parameters<typeof globalThis.fetch>>();

  const fetch: typeof globalThis.fetch = (...args) => {
    started.resolve(args);

    return respond(...args);
  };

  return { fetch, started: started.promise };
};

/** Wait for cancellation, including when it happened before the test could listen. */
export const waitForRequestAbort = (signal: AbortSignal | null | undefined) => {
  if (signal == null) throw new Error("Expected a request with an abort signal");

  if (signal.aborted) return Promise.resolve();

  return new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
};

// Every mount sends a real initial POST through FetchHttpClient. The supplied
// interactiveFetch double counts only subsequent requests; this returned double
// records all requests, including the initial Broad groups query.
// Error-body fixtures must supply their non-2xx status explicitly.
export const initialBroadReplyThenFetch = (
  initial: Schema.Json | Promise<Schema.Json>,
  interactiveFetch: typeof globalThis.fetch,
  initialStatus = 200,
) => {
  let initialRequested = false;

  return vi.fn<typeof globalThis.fetch>(async (input, init) => {
    if (initialRequested) return interactiveFetch(input, init);
    initialRequested = true;

    const request = new Request(
      new URL(
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
        "http://localhost",
      ),
      init,
    );

    expect(new URL(request.url).pathname).toBe("/api/classify");
    expect(request.method).toBe("POST");
    expect(Schema.decodeUnknownSync(ClassifyRequest)(await request.json())).toEqual({
      panelId: "broad",
    });

    // Deliberately ignore cancellation: late-provider tests must demonstrate
    // that an obsolete successful reply cannot replace the current display.
    return Response.json(await initial, { status: initialStatus });
  });
};
