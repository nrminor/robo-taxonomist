import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render as renderBrowser } from "vitest-browser-react";
import { page } from "vitest/browser";
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

afterEach(() => cleanup());

const renderDemo = async (initial: Promise<Schema.Json>, fetch: typeof globalThis.fetch) => {
  const layer = FetchHttpClient.layer.pipe(
    Layer.provideMerge(Layer.succeed(FetchHttpClient.Fetch, fetch)),
  );
  return renderBrowser(
    <StrictMode>
      <RegistryProvider initialValues={[Atom.initialValue(browserRuntime.layer, layer)]}>
        <Demo initial={initial} />
      </RegistryProvider>
    </StrictMode>,
  );
};

const replyFor = (panelId: PanelId) =>
  Effect.runPromise(
    classifyPanel(panelId).pipe(
      Effect.provide(PanelResults.layer),
      Effect.map((response) => Schema.encodeSync(ClassificationReply)(Result.succeed(response))),
    ),
  );

it("presents native panel choices beside a records-first workspace", async () => {
  const fetch = vi.fn(() => Promise.reject(new Error("Unexpected browser request")));
  const layer = FetchHttpClient.layer.pipe(
    Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch)),
  );
  const view = await renderBrowser(
    <RegistryProvider initialValues={[Atom.initialValue(browserRuntime.layer, layer)]}>
      <Demo initial={Promise.resolve(await replyFor("broad"))} />
    </RegistryProvider>,
  );
  await expect.element(view.getByRole("heading", { name: "robo-taxonomist demo" })).toBeVisible();
  await expect.element(view.getByRole("radio", { name: "Broad groups" })).toBeChecked();
  await expect.element(view.getByRole("region", { name: "Input records" })).toBeVisible();
  await expect.element(view.getByRole("region", { name: "Panel targets" })).toBeVisible();
  expect(fetch).not.toHaveBeenCalled();
});

it("accepts a panel selection while the initial result is pending and ignores its late reply", async () => {
  const initial = Promise.withResolvers<Schema.Json>();
  const pending = Promise.withResolvers<Response>();
  const fetch = vi.fn(() => pending.promise);
  await renderDemo(initial.promise, fetch);

  await page.getByRole("radio", { name: "Groups and subgroups" }).click();
  await expect.poll(() => fetch.mock.calls.length).toBe(1);
  const nested = await replyFor("nested");
  pending.resolve(Response.json(nested));
  await expect.element(page.getByRole("region", { name: "Groups and subgroups" })).toBeVisible();
  await expect.element(page.getByText("12 of 24 records match a target.")).toBeVisible();

  const broad = await replyFor("broad");
  initial.resolve(broad);
  await expect.element(page.getByRole("region", { name: "Groups and subgroups" })).toBeVisible();
  await expect.element(page.getByText("22 of 24 records match a target.")).not.toBeInTheDocument();
  await expect.element(page.getByText(/records changed/)).not.toBeInTheDocument();
});

it("shows the initial matches without sending another classification request", async () => {
  const response = await Effect.runPromise(
    classifyPanel("broad").pipe(Effect.provide(PanelResults.layer)),
  );
  const initial = Promise.resolve(Schema.encodeSync(ClassificationReply)(Result.succeed(response)));
  const fetch = vi.fn(() => Promise.reject(new Error("Unexpected browser request")));
  await renderDemo(initial, fetch);

  await expect.element(page.getByText("22 of 24 records match a target.")).toBeVisible();
  await expect.element(page.getByText(/records changed/)).not.toBeInTheDocument();
  expect(fetch).not.toHaveBeenCalled();
});

it("compares with the last displayed panel and keeps that comparison stable in Strict Mode", async () => {
  const pending = Promise.withResolvers<Response>();
  const fetch = vi.fn(() => pending.promise);
  const initial = Promise.resolve(await replyFor("broad"));
  await renderDemo(initial, fetch);

  await page.getByRole("radio", { name: "Groups and subgroups" }).click();
  await expect.element(page.getByText("22 of 24 records match a target.")).toBeVisible();
  const nested = await replyFor("nested");
  pending.resolve(Response.json(nested));
  await expect
    .element(page.getByText("Matches changed for 19 records since Broad groups."))
    .toBeVisible();
  await expect.element(page.getByText("12 of 24 records match a target.")).toBeVisible();
});

it("compares C with committed A, not successful B abandoned by Suspense", async () => {
  const broad = Promise.resolve(await replyFor("broad"));
  const nested = Promise.resolve(await replyFor("nested"));
  const focused = Promise.resolve(await replyFor("focused"));
  const blocked = Promise.withResolvers<never>();
  const reachedGate = vi.fn();
  const committedGate = vi.fn();
  const fetch = vi.fn(() => Promise.reject(new Error("Unexpected browser request")));
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
  const view = await renderBrowser(tree(broad, false));
  await expect.element(view.getByText("22 of 24 records match a target.")).toBeVisible();
  expect(committedGate).toHaveBeenCalledWith(false);

  await view.rerender(tree(nested, true));
  await expect.element(view.getByText("Candidate suspended")).toBeVisible();
  expect(reachedGate).toHaveBeenCalledWith(true);
  expect(committedGate).not.toHaveBeenCalledWith(true);
  await expect
    .element(view.getByRole("region", { name: "Groups and subgroups" }))
    .not.toBeInTheDocument();

  await view.rerender(tree(focused, false));
  await expect
    .element(view.getByRole("region", { name: "Families, genera and species" }))
    .toBeVisible();
  await expect.element(view.getByText(/records since Broad groups\./)).toBeVisible();
  expect(fetch).not.toHaveBeenCalled();
});

it("counts the full abundance for overlapping matches and lets a genus record rule out a species match", async () => {
  const view = await renderDemo(Promise.resolve(await replyFor("nested")), () =>
    Promise.reject(new Error("Unexpected browser request")),
  );
  const chart = view.getByRole("figure", { name: "Count abundance for each target" });
  await expect
    .element(chart.getByRole("img"))
    .toHaveAttribute("aria-label", expect.stringContaining("Fungi: 31%;"));
  await expect
    .element(chart.getByRole("img"))
    .toHaveAttribute("aria-label", expect.stringContaining("Saccharomyces: 18%;"));
  await expect
    .element(chart.getByRole("img"))
    .toHaveAttribute("aria-label", expect.stringContaining("Saccharomyces cerevisiae: 14%;"));

  await view.getByLabelText("Inspect Saccharomyces", { exact: true }).click();
  const comparisons = view.getByRole("table", { name: "Classify Saccharomyces", exact: true });
  await expect
    .element(comparisons.getByRole("row", { name: /Saccharomyces cerevisiae Does not match/ }))
    .toBeVisible();
  await expect
    .element(comparisons.getByRole("row", { name: /^Saccharomyces Matches/ }))
    .toBeVisible();
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
  const view = await renderDemo(
    Promise.resolve(Schema.encodeSync(ClassificationReply)(reply)),
    () => Promise.reject(new Error("Unexpected browser request")),
  );
  await view.getByLabelText("Inspect Saccharomyces cerevisiae", { exact: true }).click();
  const comparisons = view.getByRole("table", {
    name: "Classify Saccharomyces cerevisiae",
    exact: true,
  });
  const fungi = comparisons.getByRole("row", { name: /^Fungi / });
  await fungi.getByText("Within a broader taxon", { exact: true }).first().click();
  await expect.element(fungi.getByText("Provider confidence")).toBeVisible();
  await expect.element(fungi.getByText("80%")).toBeVisible();
  await expect.element(fungi.getByText("95%")).toBeVisible();
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

  await page.getByRole("radio", { name: "Families, genera and species" }).click();
  await expect.poll(() => fetch.mock.calls.length).toBe(1);
  await page.getByRole("radio", { name: "Broad groups" }).click();
  await expect.poll(() => fetch.mock.calls.length).toBe(2);
  await expect.poll(() => fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  const broad = await replyFor("broad");
  latest.resolve(Response.json(broad));
  await expect.element(page.getByText("22 of 24 records match a target.")).toBeVisible();

  const focused = await replyFor("focused");
  first.resolve(Response.json(focused));
  initial.resolve(broad);
  await expect.element(page.getByRole("region", { name: "Broad groups" })).toBeVisible();
  await expect
    .element(page.getByRole("region", { name: "Families, genera and species" }))
    .not.toBeInTheDocument();
  await expect.element(page.getByText(/Matches changed/)).not.toBeInTheDocument();
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
    .fn(() => Promise.resolve(Response.json(nested)))
    .mockImplementationOnce(() => Promise.resolve(Response.json(nested)))
    .mockImplementationOnce(() => Promise.resolve(Response.json(failure, { status: 503 })))
    .mockImplementationOnce(() => Promise.resolve(Response.json(focused)));
  await renderDemo(Promise.resolve(await replyFor("broad")), fetch);
  await page.getByRole("radio", { name: "Groups and subgroups" }).click();
  await expect
    .element(page.getByText("Matches changed for 19 records since Broad groups."))
    .toBeVisible();

  await page.getByRole("radio", { name: "Families, genera and species" }).click();
  await expect.element(page.getByText("Wait 30 seconds before you try again.")).toBeVisible();
  await expect.element(page.getByRole("region", { name: "Groups and subgroups" })).toBeVisible();
  await expect
    .element(page.getByText("Matches changed for 19 records since Broad groups."))
    .toBeVisible();
  expect(fetch).toHaveBeenCalledTimes(2);

  await page.getByRole("button", { name: "Try again" }).click();
  await expect
    .element(page.getByText("Matches changed for 18 records since Groups and subgroups."))
    .toBeVisible();
  await expect.element(page.getByText("13 of 24 records match a target.")).toBeVisible();
  await expect.element(page.getByRole("alert")).not.toBeInTheDocument();
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
  const pending = Promise.withResolvers<Response>();
  const fetch = vi
    .fn(() => pending.promise)
    .mockReturnValueOnce(pending.promise)
    .mockResolvedValueOnce(Response.json(wire));
  await renderDemo(Promise.resolve(original), fetch);
  await page.getByRole("radio", { name: "Groups and subgroups" }).click();
  await expect.poll(() => fetch.mock.calls.length).toBe(1);
  await page.getByRole("radio", { name: "Broad groups" }).click();
  await expect
    .element(page.getByText("Matches changed for 0 records since Broad groups."))
    .toBeVisible();
  await expect.element(page.getByText("22 of 24 records match a target.")).toBeVisible();
});

it("does not report a superseded failure", async () => {
  const earlier = Promise.withResolvers<Response>();
  const focused = await replyFor("focused");
  const fetch = vi
    .fn(() => earlier.promise)
    .mockReturnValueOnce(earlier.promise)
    .mockImplementationOnce(() => Promise.resolve(Response.json(focused)));
  await renderDemo(Promise.resolve(await replyFor("broad")), fetch);
  await page.getByRole("radio", { name: "Groups and subgroups" }).click();
  await expect.poll(() => fetch.mock.calls.length).toBe(1);
  await page.getByRole("radio", { name: "Families, genera and species" }).click();
  await expect.element(page.getByText("13 of 24 records match a target.")).toBeVisible();
  earlier.reject(new Error("Superseded request failed"));
  await expect.element(page.getByRole("alert")).not.toBeInTheDocument();
  await expect
    .element(page.getByRole("region", { name: "Families, genera and species" }))
    .toBeVisible();
});

it("interrupts an unfinished request when its registry is disposed", async () => {
  const pending = Promise.withResolvers<Response>();
  const fetch = vi.fn<typeof globalThis.fetch>(() => pending.promise);
  const view = await renderDemo(Promise.resolve(await replyFor("broad")), fetch);
  await view.getByRole("radio", { name: "Groups and subgroups" }).click();
  await expect.poll(() => fetch.mock.calls.length).toBe(1);
  await view.unmount();
  await expect.poll(() => fetch.mock.calls[0]?.[1]?.signal?.aborted, { timeout: 2_000 }).toBe(true);
});

it.each([
  ["a different panel", "broad", 200],
  ["a failed HTTP status", "nested", 500],
] as const)(
  "rejects a success reply for %s without replacing the displayed matches",
  async (_description, panelId, status) => {
    const broad = await replyFor("broad");
    const reply = await replyFor(panelId);
    const fetch = () => Promise.resolve(Response.json(reply, { status }));
    await renderDemo(Promise.resolve(broad), fetch);
    await page.getByRole("radio", { name: "Groups and subgroups" }).click();
    await expect.element(page.getByText("Could not read the reply. Try again.")).toBeVisible();
    await expect.element(page.getByRole("region", { name: "Broad groups" })).toBeVisible();
    await expect.element(page.getByText(/Matches changed/)).not.toBeInTheDocument();
  },
);
