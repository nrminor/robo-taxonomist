import { expect, vi } from "vitest";
import { Schema } from "effect";
import { ClassifyRequest } from "../src/lib/contract.ts";

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
