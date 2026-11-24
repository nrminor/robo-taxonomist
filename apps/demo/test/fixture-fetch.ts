import { expect, vi } from "vitest";
import { Schema } from "effect";
import { ClassifyRequest } from "../src/lib/contract.ts";

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
