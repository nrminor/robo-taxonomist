import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { page } from "vitest/browser";
import { RegistryProvider } from "@effect/atom-react";
import { StrictMode } from "react";
import { DateTime, Effect, Layer, Result, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import * as Atom from "effect/reactivity/Atom";
import { Demo } from "../src/components/demo.tsx";
import { browserRuntime } from "../src/client/panel-atoms.ts";
import {
  ClassificationFailure,
  ClassificationReply,
  ClassifyRequest,
  PublicModelReason,
} from "../src/lib/contract.ts";
import { classifyPanel, PanelResults } from "../src/server/panel-results.ts";

const renderDemo = async (initial: Schema.Json, mockFetch: typeof globalThis.fetch) => {
  const layer = FetchHttpClient.layer.pipe(
    Layer.provideMerge(Layer.succeed(FetchHttpClient.Fetch, mockFetch)),
  );
  return render(
    <StrictMode>
      <RegistryProvider initialValues={[Atom.initialValue(browserRuntime.layer, layer)]}>
        <Demo initial={Promise.resolve(initial)} />
      </RegistryProvider>
    </StrictMode>,
  );
};

const failedReply = (failure: ClassificationFailure) =>
  Schema.encodeSync(ClassificationReply)(Result.fail(failure));

it("waits for an explicit retry after showing the initial rate limit and sends the selected panel", async () => {
  const initial = failedReply(
    ClassificationFailure.cases.ModelFailure.make({
      reason: PublicModelReason.cases.RateLimitError.make({ retryAfterMs: 30_000 }),
      retryable: true,
      requestId: "req-rate-limit",
    }),
  );
  const mockFetch = vi.fn<typeof globalThis.fetch>(() => Promise.resolve(Response.json(initial)));
  await renderDemo(initial, mockFetch);

  await expect
    .element(page.getByRole("alert"))
    .toMatchTextContent("Wait 30 seconds before you try again.");
  await expect.element(page.getByText("Request ID: req-rate-limit")).toBeVisible();
  expect(mockFetch).not.toHaveBeenCalled();
  await page.getByRole("button", { name: "Try again" }).click();
  await expect.poll(() => mockFetch.mock.calls.length).toBe(1);
  const call = mockFetch.mock.calls[0];
  if (call === undefined) throw new Error("Expected a classification request");
  const [url, init] = call;
  const requestUrl = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
  expect(requestUrl).toContain("/api/classify");
  expect(init?.method).toBe("POST");
  expect(
    Schema.decodeSync(Schema.fromJsonString(ClassifyRequest))(
      await new Response(init?.body).text(),
    ),
  ).toEqual({ panelId: "broad" });
});

it.each([
  ["InvalidKey", "Set a valid API key, then try again."],
  ["ExpiredKey", "Replace the expired API key, then try again."],
  ["MissingKey", "Set an API key, then try again."],
  ["InsufficientPermissions", "Give the API key permission to use this model, then try again."],
  ["Unknown", "Check the API key and its permissions, then try again."],
] as const)("explains %s without offering an unchanged request", async (kind, message) => {
  const initial = failedReply(
    ClassificationFailure.cases.ModelFailure.make({
      reason: PublicModelReason.cases.AuthenticationError.make({ kind }),
      retryable: true,
      requestId: "req-auth",
    }),
  );
  const mockFetch = vi.fn(() => Promise.reject(new Error("Unexpected request")));
  await renderDemo(initial, mockFetch);

  await expect.element(page.getByRole("alert")).toMatchTextContent(message);
  await expect.element(page.getByText("Request ID: req-auth")).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Try again" })).not.toBeInTheDocument();
  expect(mockFetch).not.toHaveBeenCalled();
});

it("shows the quota reset time without offering a request that cannot succeed yet", async () => {
  const initial = failedReply(
    ClassificationFailure.cases.ModelFailure.make({
      reason: PublicModelReason.cases.QuotaExhaustedError.make({
        resetAt: DateTime.makeUnsafe("2026-10-29T00:00:00Z"),
      }),
      retryable: true,
    }),
  );
  const mockFetch = vi.fn(() => Promise.reject(new Error("Unexpected request")));
  await renderDemo(initial, mockFetch);

  await expect
    .element(page.getByRole("alert"))
    .toMatchTextContent("Wait until 2026-10-29T00:00:00.000Z");
  await expect.element(page.getByRole("button", { name: "Try again" })).not.toBeInTheDocument();
  expect(mockFetch).not.toHaveBeenCalled();
});

it.each([
  {
    description: "a retryable provider connection failure",
    reason: PublicModelReason.cases.NetworkError.make({}),
    retryable: true,
    offersRetry: true,
    message: "Could not reach the model service. Try again.",
  },
  {
    description: "a non-retryable provider connection failure",
    reason: PublicModelReason.cases.NetworkError.make({}),
    retryable: false,
    offersRetry: false,
    message: "Could not reach the model service. Contact the site administrator.",
  },
  {
    description: "invalid tool input even when the provider calls it retryable",
    reason: PublicModelReason.cases.ToolParameterValidationError.make({}),
    retryable: true,
    offersRetry: false,
    message: "Fix the model tool's input before you try again.",
  },
])(
  "respects retry policy for $description",
  async ({ reason, retryable, offersRetry, message }) => {
    const initial = failedReply(
      ClassificationFailure.cases.ModelFailure.make({ reason, retryable }),
    );
    const broad = await Effect.runPromise(
      classifyPanel("broad").pipe(Effect.provide(PanelResults.layer)),
    );
    const success = Schema.encodeSync(ClassificationReply)(Result.succeed(broad));
    const mockFetch = vi.fn(() => Promise.resolve(Response.json(success)));
    await renderDemo(initial, mockFetch);

    await expect.element(page.getByRole("alert")).toMatchTextContent(message);
    expect(mockFetch).not.toHaveBeenCalled();
    if (!offersRetry) {
      await expect.element(page.getByRole("button", { name: "Try again" })).not.toBeInTheDocument();
      return;
    }
    await page.getByRole("button", { name: "Try again" }).click();
    await expect.element(page.getByRole("region", { name: "Broad groups" })).toBeVisible();
    expect(mockFetch).toHaveBeenCalledTimes(1);
    await expect.element(page.getByRole("alert")).not.toBeInTheDocument();
  },
);

it("shows safe reply guidance for malformed initial data rather than exposing its contents", async () => {
  const mockFetch = vi.fn(() => Promise.reject(new Error("Unexpected request")));
  await renderDemo({ invalid: "SECRET raw schema issues" }, mockFetch);

  await expect
    .element(page.getByRole("alert"))
    .toMatchTextContent("Could not read the reply. Try again.");
  await expect.element(page.getByText(/SECRET/)).not.toBeInTheDocument();
  await expect.element(page.getByRole("button", { name: "Try again" })).toBeVisible();
  expect(mockFetch).not.toHaveBeenCalled();
});

it("does not display an invalid authentication kind from a malformed reply", async () => {
  const valid = failedReply(
    ClassificationFailure.cases.ModelFailure.make({
      reason: PublicModelReason.cases.AuthenticationError.make({ kind: "InvalidKey" }),
      retryable: false,
    }),
  );
  const invalid = Schema.decodeSync(Schema.fromJsonString(Schema.Json))(
    JSON.stringify(valid).replace('"InvalidKey"', '"SECRET invalid authentication kind"'),
  );
  const mockFetch = vi.fn(() => Promise.reject(new Error("Unexpected request")));
  await renderDemo(invalid, mockFetch);

  await expect
    .element(page.getByRole("alert"))
    .toMatchTextContent("Could not read the reply. Try again.");
  await expect.element(page.getByText(/SECRET/)).not.toBeInTheDocument();
  expect(mockFetch).not.toHaveBeenCalled();
});

it.each([
  [
    "transport",
    () => Promise.reject(new Error("SECRET network cause")),
    "Could not complete the request. Check your connection, then try again.",
  ],
  [
    "malformed JSON",
    () => Promise.resolve(new Response("SECRET invalid JSON")),
    "Could not read the reply. Try again.",
  ],
  [
    "malformed reply",
    () => Promise.resolve(Response.json({ body: "SECRET invalid reply" })),
    "Could not read the reply. Try again.",
  ],
] as const)(
  "distinguishes %s failures after choosing a panel without exposing raw data",
  async (_kind, response, message) => {
    const broad = await Effect.runPromise(
      classifyPanel("broad").pipe(Effect.provide(PanelResults.layer)),
    );
    const initial = Schema.encodeSync(ClassificationReply)(Result.succeed(broad));
    const mockFetch = vi.fn<typeof globalThis.fetch>(response);
    await renderDemo(initial, mockFetch);

    await page.getByRole("radio", { name: "Groups and subgroups" }).click();
    await expect.element(page.getByRole("alert")).toMatchTextContent(message);
    await expect.element(page.getByText(/SECRET/)).not.toBeInTheDocument();
    expect(mockFetch).toHaveBeenCalledTimes(1);
    await page.getByRole("button", { name: "Try again" }).click();
    await expect.poll(() => mockFetch.mock.calls.length).toBe(2);
    const retry = mockFetch.mock.calls[1];
    if (retry === undefined) throw new Error("Expected a retry request");
    expect(retry[1]?.method).toBe("POST");
    expect(
      Schema.decodeSync(Schema.fromJsonString(ClassifyRequest))(
        await new Response(retry[1]?.body).text(),
      ),
    ).toEqual({ panelId: "nested" });
  },
);
