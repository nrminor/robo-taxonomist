import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { StrictMode, Suspense, use, useLayoutEffect } from "react";
import { Effect, Layer, Result, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import * as Atom from "effect/reactivity/Atom";
import { RegistryProvider } from "@effect/atom-react";
import { Demo } from "../src/components/demo.tsx";
import {
  ClassificationReply,
  ClassificationFailure,
  PublicModelReason,
} from "../src/lib/contract.ts";
import { type PanelId } from "../src/lib/catalog.ts";
import { classifyPanel, PanelResults } from "../src/server/panel-results.ts";
import { browserRuntime } from "../src/client/panel-atoms.ts";

afterEach(() => {
  cleanup();
});

const renderDemo = async (initial: Promise<Schema.Json>, fetch: typeof globalThis.fetch) => {
  const layer = FetchHttpClient.layer.pipe(
    Layer.provideMerge(Layer.succeed(FetchHttpClient.Fetch, fetch)),
  );
  await act(async () => {
    render(
      <StrictMode>
        <RegistryProvider initialValues={[Atom.initialValue(browserRuntime.layer, layer)]}>
          <Demo initial={initial} />
        </RegistryProvider>
      </StrictMode>,
    );
  });
};

const replyFor = (panelId: PanelId) =>
  Effect.runPromise(
    classifyPanel(panelId).pipe(
      Effect.provide(PanelResults.layer),
      Effect.map((response) => Schema.encodeSync(ClassificationReply)(Result.succeed(response))),
    ),
  );

it("accepts a panel selection while the initial result is pending and ignores its late reply", async () => {
  const initial = Promise.withResolvers<Schema.Json>();
  const pending = Promise.withResolvers<Response>();
  const fetch = vi.fn(() => pending.promise);
  await renderDemo(initial.promise, fetch);

  fireEvent.click(screen.getByRole("button", { name: "Nested targets" }));
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  const nested = await replyFor("nested");
  await act(async () => pending.resolve(Response.json(nested)));
  expect(await screen.findByRole("heading", { name: "Nested targets" })).toBeDefined();
  expect(screen.getByText("12 of 24 records match a target.")).toBeDefined();

  const broad = await replyFor("broad");
  await act(async () => initial.resolve(broad));
  expect(screen.getByRole("heading", { name: "Nested targets" })).toBeDefined();
  expect(screen.queryByText("22 of 24 records match a target.")).toBeNull();
  expect(screen.queryByText(/records changed/)).toBeNull();
});

it("shows the initial matches without sending another classification request", async () => {
  const response = await Effect.runPromise(
    classifyPanel("broad").pipe(Effect.provide(PanelResults.layer)),
  );
  const initial = Promise.resolve(Schema.encodeSync(ClassificationReply)(Result.succeed(response)));
  const fetch = vi.fn(() => Promise.reject(new Error("Unexpected browser request")));
  await renderDemo(initial, fetch);

  expect(await screen.findByText("22 of 24 records match a target.")).toBeDefined();
  expect(screen.queryByText(/records changed/)).toBeNull();
  expect(fetch).not.toHaveBeenCalled();
});

it("compares with the last displayed panel and keeps that comparison stable in Strict Mode", async () => {
  const pending = Promise.withResolvers<Response>();
  const fetch = vi.fn(() => pending.promise);
  const initial = Promise.resolve(await replyFor("broad"));
  await renderDemo(initial, fetch);

  fireEvent.click(screen.getByRole("button", { name: "Nested targets" }));
  expect(screen.getByText("22 of 24 records match a target.")).toBeDefined();
  const nested = await replyFor("nested");
  await act(async () => pending.resolve(Response.json(nested)));
  expect(
    await screen.findByText("Matches changed for 19 records since Broad survey."),
  ).toBeDefined();
  expect(screen.getByText("12 of 24 records match a target.")).toBeDefined();
});

it("compares C with committed A, not successful B abandoned by Suspense", async () => {
  const broad = Promise.resolve(await replyFor("broad"));
  const nested = Promise.resolve(await replyFor("nested"));
  const focused = Promise.resolve(await replyFor("focused"));
  const blocked = Promise.withResolvers<never>();
  const reachedGate = vi.fn();
  const committedGate = vi.fn();
  const fetch = vi.fn<typeof globalThis.fetch>(() =>
    Promise.reject(new Error("Unexpected browser request")),
  );
  const layer = FetchHttpClient.layer.pipe(
    Layer.provideMerge(Layer.succeed(FetchHttpClient.Fetch, fetch)),
  );

  function Gate({ suspend }: { readonly suspend: boolean }) {
    reachedGate(suspend);
    useLayoutEffect(() => committedGate(suspend), [suspend]);
    if (suspend) throw blocked.promise;
    return null;
  }
  function Candidate({
    initial,
    suspend,
  }: {
    readonly initial: Promise<Schema.Json>;
    readonly suspend: boolean;
  }) {
    // Resolve use(initial) before traversing Demo, so reaching the later sibling
    // proves B's successful results rendered, rather than its pending fallback.
    use(initial);
    return (
      <>
        <Demo initial={initial} />
        <Gate suspend={suspend} />
      </>
    );
  }
  const tree = (initial: Promise<Schema.Json>, suspend: boolean) => (
    <RegistryProvider initialValues={[Atom.initialValue(browserRuntime.layer, layer)]}>
      <Suspense fallback={<p role="status">Candidate suspended</p>}>
        <Candidate initial={initial} suspend={suspend} />
      </Suspense>
    </RegistryProvider>
  );
  const view = await act(async () => render(tree(broad, false)));
  await screen.findByText("22 of 24 records match a target.");
  expect(committedGate).toHaveBeenCalledWith(false);

  await act(async () => view.rerender(tree(nested, true)));
  expect(screen.getByText("Candidate suspended")).toBeDefined();
  expect(reachedGate).toHaveBeenCalledWith(true);
  expect(committedGate).not.toHaveBeenCalledWith(true);
  expect(screen.queryByRole("heading", { name: "Nested targets" })).toBeNull();

  await act(async () => view.rerender(tree(focused, false)));
  expect(await screen.findByRole("heading", { name: "Focused interests" })).toBeDefined();
  expect(screen.getByText(/records since Broad survey\./)).toBeDefined();
  expect(fetch).not.toHaveBeenCalled();
});

it("counts the full abundance for overlapping matches and lets a genus record rule out a species match", async () => {
  await renderDemo(Promise.resolve(await replyFor("nested")), vi.fn());
  const chart = await screen.findByRole("figure", { name: "Count abundance for each target" });
  const description = within(chart).getByRole("img").getAttribute("aria-label");
  expect(description).toContain("Fungi: 31%;");
  expect(description).toContain("Saccharomyces: 18%;");
  expect(description).toContain("Saccharomyces cerevisiae: 14%;");

  fireEvent.click(screen.getByLabelText("Inspect Saccharomyces"));
  const comparisons = screen.getByRole("table", { name: "Classify Saccharomyces" });
  expect(
    within(comparisons).getByRole("row", { name: /Saccharomyces cerevisiae Does not match/ }),
  ).toBeDefined();
  expect(within(comparisons).getByRole("row", { name: /^Saccharomyces Matches/ })).toBeDefined();
});

it("shows optional provider confidence separately from match support", async () => {
  const reply = Result.map(
    Schema.decodeSync(ClassificationReply)(await replyFor("broad")),
    (response) => ({
      ...response,
      rows: response.rows.map((row) => ({
        ...row,
        matches: row.matches.map((match) => ({
          ...match,
          answer: { ...match.answer, confidence: 0.8 },
        })),
      })),
    }),
  );
  await renderDemo(Promise.resolve(Schema.encodeSync(ClassificationReply)(reply)), vi.fn());
  fireEvent.click(screen.getByLabelText("Inspect Saccharomyces cerevisiae"));
  const comparisons = screen.getByRole("table", { name: "Classify Saccharomyces cerevisiae" });
  const fungi = within(comparisons).getByRole("row", { name: /^Fungi / });
  fireEvent.click(within(fungi).getByText("Within a broader taxon", { selector: "summary" }));
  expect(within(fungi).getByText("Provider confidence")).toBeDefined();
  expect(within(fungi).getByText("80%")).toBeDefined();
  expect(within(fungi).getByText("95%")).toBeDefined();
});

it("ignores superseded replies when Broad survey is selected again before the initial reply arrives", async () => {
  const initial = Promise.withResolvers<Schema.Json>();
  const first = Promise.withResolvers<Response>();
  const latest = Promise.withResolvers<Response>();
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(latest.promise);
  await renderDemo(initial.promise, fetch);

  fireEvent.click(screen.getByRole("button", { name: "Focused interests" }));
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByRole("button", { name: "Broad survey" }));
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  const broad = await replyFor("broad");
  await act(async () => latest.resolve(Response.json(broad)));
  expect(await screen.findByText("22 of 24 records match a target.")).toBeDefined();

  const focused = await replyFor("focused");
  await act(async () => {
    first.resolve(Response.json(focused));
    initial.resolve(broad);
  });
  expect(screen.getByRole("heading", { name: "Broad survey" })).toBeDefined();
  expect(screen.queryByRole("heading", { name: "Focused interests" })).toBeNull();
  expect(screen.queryByText(/Matches changed/)).toBeNull();
});

it("keeps the displayed matches and their comparison after failure, then compares the retry with that display", async () => {
  const nested = await replyFor("nested");
  const focused = await replyFor("focused");
  const failure = Schema.encodeSync(ClassificationReply)(
    Result.fail(
      ClassificationFailure.cases.ModelFailure.make({
        reason: PublicModelReason.cases.RateLimitError.make({ retryAfterMs: 30_000 }),
        retryable: true,
      }),
    ),
  );
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockImplementationOnce(() => Promise.resolve(Response.json(nested)))
    .mockImplementationOnce(() => Promise.resolve(Response.json(failure, { status: 503 })))
    .mockImplementationOnce(() => Promise.resolve(Response.json(focused)));
  await renderDemo(Promise.resolve(await replyFor("broad")), fetch);
  fireEvent.click(screen.getByRole("button", { name: "Nested targets" }));
  await screen.findByText("Matches changed for 19 records since Broad survey.");

  fireEvent.click(screen.getByRole("button", { name: "Focused interests" }));
  await screen.findByText("Wait 30 seconds before you try again.");
  expect(screen.getByRole("heading", { name: "Nested targets" })).toBeDefined();
  expect(screen.getByText("Matches changed for 19 records since Broad survey.")).toBeDefined();
  expect(fetch).toHaveBeenCalledTimes(2);

  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(
    await screen.findByText("Matches changed for 18 records since Nested targets."),
  ).toBeDefined();
  expect(screen.getByText("13 of 24 records match a target.")).toBeDefined();
  expect(screen.queryByRole("alert")).toBeNull();
});

it("does not count a support-only change as a change in matches", async () => {
  const original = await replyFor("broad");
  const revised = Result.map(Schema.decodeSync(ClassificationReply)(original), (response) => ({
    ...response,
    rows: response.rows.map((row) => ({
      ...row,
      matches: row.matches.map((match) => ({ ...match, support: match.support - 0.01 })),
    })),
  }));
  const wire = Schema.encodeSync(ClassificationReply)(revised);
  const fetch = vi.fn<typeof globalThis.fetch>(() => Promise.resolve(Response.json(wire)));
  await renderDemo(Promise.resolve(original), fetch);
  fireEvent.click(screen.getByRole("button", { name: "Broad survey" }));
  expect(
    await screen.findByText("Matches changed for 0 records since Broad survey."),
  ).toBeDefined();
  expect(screen.getByText("22 of 24 records match a target.")).toBeDefined();
});

it("does not report a superseded failure", async () => {
  const earlier = Promise.withResolvers<Response>();
  const focused = await replyFor("focused");
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockReturnValueOnce(earlier.promise)
    .mockImplementationOnce(() => Promise.resolve(Response.json(focused)));
  await renderDemo(Promise.resolve(await replyFor("broad")), fetch);
  fireEvent.click(screen.getByRole("button", { name: "Nested targets" }));
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByRole("button", { name: "Focused interests" }));
  await screen.findByText("13 of 24 records match a target.");
  await act(async () => earlier.reject(new Error("Superseded request failed")));
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByRole("heading", { name: "Focused interests" })).toBeDefined();
});

it("interrupts an unfinished request when its registry is disposed", async () => {
  const pending = Promise.withResolvers<Response>();
  const fetch = vi.fn<typeof globalThis.fetch>(() => pending.promise);
  await renderDemo(Promise.resolve(await replyFor("broad")), fetch);
  fireEvent.click(screen.getByRole("button", { name: "Nested targets" }));
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  vi.useFakeTimers();
  try {
    await act(async () => {
      cleanup();
      await vi.advanceTimersByTimeAsync(501);
    });
    expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});

it.each([
  ["a different panel", "broad", 200],
  ["a failed HTTP status", "nested", 500],
] as const)(
  "rejects a success reply for %s without replacing the displayed matches",
  async (_description, panelId, status) => {
    const broad = await replyFor("broad");
    const reply = await replyFor(panelId);
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(Response.json(reply, { status })),
    );
    await renderDemo(Promise.resolve(broad), fetch);
    fireEvent.click(screen.getByRole("button", { name: "Nested targets" }));
    expect(await screen.findByText("Could not read the reply. Try again.")).toBeDefined();
    expect(screen.getByRole("heading", { name: "Broad survey" })).toBeDefined();
    expect(screen.queryByText(/Matches changed/)).toBeNull();
  },
);
