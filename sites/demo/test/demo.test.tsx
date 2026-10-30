import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render as renderBrowser } from "vitest-browser-react";
import { page } from "vitest/browser";
import { StrictMode } from "react";
import { Effect, Layer, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import * as Atom from "effect/reactivity/Atom";
import { RegistryProvider } from "@effect/atom-react";
import { Demo } from "../src/components/demo.tsx";
import { PanelResponse, ClassificationFailure, PublicModelReason } from "../src/lib/contract.ts";
import { type PanelId } from "../src/lib/catalog.ts";
import { classifyPanel, PanelResults } from "../src/server/panel-results.ts";
import { browserRuntime } from "../src/client/panel-atoms.ts";
import { initialBroadReplyThenFetch } from "./fixture-fetch.ts";

afterEach(() => cleanup());

const renderHttpDemo = (fetch: typeof globalThis.fetch) => {
  const layer = FetchHttpClient.layer.pipe(
    Layer.provideMerge(Layer.succeed(FetchHttpClient.Fetch, fetch)),
  );
  return renderBrowser(
    <StrictMode>
      <RegistryProvider initialValues={[Atom.initialValue(browserRuntime.layer, layer)]}>
        <Demo />
      </RegistryProvider>
    </StrictMode>,
  );
};

// The caller's fetch double counts interactive requests, not the initial POST.
const renderDemo = async (
  initial: Promise<Schema.Json>,
  interactiveFetch: typeof globalThis.fetch,
) => {
  const view = await renderHttpDemo(initialBroadReplyThenFetch(initial, interactiveFetch));
  await expect.element(view.getByRole("region", { name: "Panel targets" })).toBeVisible();
  return view;
};

const replyFor = (panelId: PanelId) =>
  Effect.runPromise(
    classifyPanel(panelId).pipe(
      Effect.provide(PanelResults.layer),
      Effect.map((response) => Schema.encodeSync(Schema.toCodecJson(PanelResponse))(response)),
    ),
  );

it("presents native panel choices beside a records-first workspace", async () => {
  const interactiveFetch = vi.fn(() => Promise.reject(new Error("Unexpected browser request")));
  const fetch = initialBroadReplyThenFetch(await replyFor("broad"), interactiveFetch);
  const view = await renderHttpDemo(fetch);
  await expect.element(view.getByRole("heading", { name: "robo-taxonomist demo" })).toBeVisible();
  await expect.element(view.getByRole("radio", { name: "Broad groups" })).toBeChecked();
  await expect.element(view.getByRole("region", { name: "Input records" })).toBeVisible();
  await expect.element(view.getByRole("region", { name: "Panel targets" })).toBeVisible();
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(interactiveFetch).not.toHaveBeenCalled();
});

it("accepts a panel selection while the initial result is pending and ignores its late reply", async () => {
  const initial = Promise.withResolvers<Response>();
  const pending = Promise.withResolvers<Response>();
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockReturnValueOnce(initial.promise)
    .mockReturnValueOnce(pending.promise);
  await renderHttpDemo(fetch);
  await expect.poll(() => fetch.mock.calls.length).toBe(1);
  await expect.element(page.getByText("Classifying with Broad groups…")).toBeVisible();
  await expect.element(page.getByRole("region", { name: "Panel targets" })).not.toBeInTheDocument();

  await page.getByRole("radio", { name: "Groups and subgroups" }).click();
  await expect.poll(() => fetch.mock.calls.length).toBe(2);
  await expect.poll(() => fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  const nested = await replyFor("nested");
  pending.resolve(Response.json(nested));
  await expect.element(page.getByRole("region", { name: "Groups and subgroups" })).toBeVisible();
  await expect.element(page.getByText("12 of 24 records match a target.")).toBeVisible();

  const broad = await replyFor("broad");
  initial.resolve(Response.json(broad));
  await expect.element(page.getByRole("region", { name: "Groups and subgroups" })).toBeVisible();
  await expect.element(page.getByText("22 of 24 records match a target.")).not.toBeInTheDocument();
  await expect.element(page.getByText(/records changed/)).not.toBeInTheDocument();
});

it("shows initial POST matches without sending an interactive classification request", async () => {
  const response = await Effect.runPromise(
    classifyPanel("broad").pipe(Effect.provide(PanelResults.layer)),
  );
  const initial = Promise.resolve(Schema.encodeSync(Schema.toCodecJson(PanelResponse))(response));
  const fetch = vi.fn(() => Promise.reject(new Error("Unexpected browser request")));
  await renderDemo(initial, fetch);

  await expect.element(page.getByText("22 of 24 records match a target.")).toBeVisible();
  await expect.element(page.getByText(/records changed/)).not.toBeInTheDocument();
  expect(fetch).not.toHaveBeenCalled();
});

it("does not refetch or invent a comparison when an ancestor rerenders", async () => {
  const fetch = initialBroadReplyThenFetch(await replyFor("broad"), () =>
    Promise.reject(new Error("Unexpected classification request")),
  );
  const layer = FetchHttpClient.layer.pipe(
    Layer.provideMerge(Layer.succeed(FetchHttpClient.Fetch, fetch)),
  );
  const tree = () => (
    <RegistryProvider initialValues={[Atom.initialValue(browserRuntime.layer, layer)]}>
      <Demo />
    </RegistryProvider>
  );
  const view = await renderBrowser(tree());
  await expect.element(view.getByText("22 of 24 records match a target.")).toBeVisible();
  await view.rerender(tree());
  await expect.element(view.getByText(/Matches changed/)).not.toBeInTheDocument();
  expect(fetch).toHaveBeenCalledTimes(1);
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

it("preserves the record list and open answer disclosure through the first panel request", async () => {
  const pending = Promise.withResolvers<Response>();
  const view = await renderDemo(Promise.resolve(await replyFor("broad")), () => pending.promise);
  const row = view.getByRole("button", { name: /^Saccharomyces cerevisiae, / });
  await row.click();
  const fungi = view.getByRole("group", { name: "Fungi", exact: true });
  await fungi.getByText("Answer probabilities", { exact: true }).click();
  const originalRow = row.element();
  const disclosure = fungi
    .getByText("Answer probabilities", { exact: true })
    .element().parentElement;
  const scroller = view.getByLabelText("Sample records and selected-record matches").element();
  const scrollTop = scroller.scrollTop;

  await view.getByRole("radio", { name: "Groups and subgroups" }).click();
  expect(row.element()).toBe(originalRow);
  expect(disclosure).toHaveProperty("open", true);
  expect(scroller.scrollTop).toBe(scrollTop);

  pending.resolve(Response.json(await replyFor("nested")));
  await expect.element(view.getByText("12 of 24 records match a target.")).toBeVisible();
  expect(row.element()).toBe(originalRow);
  expect(fungi.getByText("Answer probabilities", { exact: true }).element().parentElement).toBe(
    disclosure,
  );
  expect(disclosure).toHaveProperty("open", true);
  expect(scroller.scrollTop).toBe(scrollTop);
});

it("keeps the target workspace in place while a request is pending and after it fails", async () => {
  const pending = Promise.withResolvers<Response>();
  const view = await renderDemo(Promise.resolve(await replyFor("broad")), () => pending.promise);
  const targets = view.getByRole("region", { name: "Panel targets" });
  await expect.element(targets).toBeVisible();
  const top = targets.element().getBoundingClientRect().top;
  await view.getByRole("radio", { name: "Families, genera and species" }).click();
  expect(targets.element().getBoundingClientRect().top).toBe(top);
  pending.resolve(
    Response.json(
      Schema.encodeSync(Schema.toCodecJson(ClassificationFailure))(
        ClassificationFailure.cases.ModelFailure.make({
          reason: PublicModelReason.cases.RateLimitError.make({}),
          retryable: true,
        }),
      ),
      { status: 503 },
    ),
  );
  await expect.element(view.getByRole("alert")).toMatchTextContent("Wait before you try again.");
  expect(targets.element().getBoundingClientRect().top).toBe(top);
  await expect.element(view.getByText("22 of 24 records match a target.")).toBeVisible();
});

it("counts the full abundance for overlapping matches and lets a genus record rule out a species match", async () => {
  const nested = await replyFor("nested");
  const view = await renderDemo(Promise.resolve(await replyFor("broad")), async () =>
    Response.json(nested),
  );
  await view.getByRole("radio", { name: "Groups and subgroups" }).click();
  await expect
    .element(view.getByRole("region", { name: "Groups and subgroups", exact: true }))
    .toBeVisible();
  const chart = view.getByRole("figure", { name: "Count abundance for each target" });
  await expect
    .element(chart.getByRole("img", { name: /^Fungi · kingdom/ }))
    .toHaveAttribute("aria-label", expect.stringContaining("31% of sample"));
  await expect
    .element(chart.getByRole("img", { name: /^Saccharomyces · genus/ }))
    .toHaveAttribute("aria-label", expect.stringContaining("18% of sample"));
  await expect
    .element(chart.getByRole("img", { name: /^Saccharomyces cerevisiae · species/ }))
    .toHaveAttribute("aria-label", expect.stringContaining("14% of sample"));

  await view.getByRole("button", { name: /^Saccharomyces, / }).click();
  const comparisons = view.getByRole("region", { name: "Saccharomyces", exact: true });
  await expect
    .element(
      comparisons
        .getByRole("group", { name: "Saccharomyces cerevisiae", exact: true })
        .getByText("No match", { exact: true }),
    )
    .toBeVisible();
  await expect
    .element(
      comparisons
        .getByRole("group", { name: "Saccharomyces", exact: true })
        .getByText("Matches", { exact: true }),
    )
    .toBeVisible();
});

it("shows optional provider confidence separately from match support", async () => {
  const response = Schema.decodeSync(Schema.toCodecJson(PanelResponse))(await replyFor("broad"));
  const reply = {
    ...response,
    rows: response.rows.map((row) => ({
      ...row,
      matches: row.matches.map((match) => ({
        ...match,
        answer: { ...match.answer, confidence: 0.8 },
      })),
    })),
  };
  const view = await renderDemo(
    Promise.resolve(Schema.encodeSync(Schema.toCodecJson(PanelResponse))(reply)),
    () => Promise.reject(new Error("Unexpected browser request")),
  );
  await view.getByRole("button", { name: /^Saccharomyces cerevisiae, / }).click();
  const comparisons = view.getByRole("region", {
    name: "Saccharomyces cerevisiae",
    exact: true,
  });
  const fungi = comparisons.getByRole("group", { name: "Fungi", exact: true });
  await fungi.getByText("Answer probabilities", { exact: true }).click();
  await expect.element(fungi.getByText("Answer confidence: 80%", { exact: true })).toBeVisible();
  await expect.element(fungi.getByText("Match support: 95%", { exact: true })).toBeVisible();
});

it("ignores superseded HTTP replies when Broad groups is selected again before the initial reply arrives", async () => {
  const initial = Promise.withResolvers<Response>();
  const first = Promise.withResolvers<Response>();
  const latest = Promise.withResolvers<Response>();
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockReturnValueOnce(initial.promise)
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(latest.promise);
  await renderHttpDemo(fetch);
  await expect.poll(() => fetch.mock.calls.length).toBe(1);

  await page.getByRole("radio", { name: "Families, genera and species" }).click();
  await expect.poll(() => fetch.mock.calls.length).toBe(2);
  await expect.poll(() => fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  await page.getByRole("radio", { name: "Broad groups" }).click();
  await expect.poll(() => fetch.mock.calls.length).toBe(3);
  await expect.poll(() => fetch.mock.calls[1]?.[1]?.signal?.aborted).toBe(true);
  const broad = await replyFor("broad");
  latest.resolve(Response.json(broad));
  await expect.element(page.getByText("22 of 24 records match a target.")).toBeVisible();

  const focused = await replyFor("focused");
  first.resolve(Response.json(focused));
  initial.resolve(Response.json(broad));
  await expect.element(page.getByRole("region", { name: "Broad groups" })).toBeVisible();
  await expect
    .element(page.getByRole("region", { name: "Families, genera and species" }))
    .not.toBeInTheDocument();
  await expect.element(page.getByText(/Matches changed/)).not.toBeInTheDocument();
});

it("keeps the displayed matches and their comparison after failure, then compares the retry with that display", async () => {
  const nested = await replyFor("nested");
  const focused = await replyFor("focused");
  const failure = Schema.encodeSync(Schema.toCodecJson(ClassificationFailure))(
    ClassificationFailure.cases.ModelFailure.make({
      reason: PublicModelReason.cases.RateLimitError.make({ retryAfterMs: 30_000 }),
      retryable: true,
    }),
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
  const response = Schema.decodeSync(Schema.toCodecJson(PanelResponse))(original);
  const revised = {
    ...response,
    rows: response.rows.map((row) => ({
      ...row,
      matches: row.matches.map((match) => ({ ...match, support: match.support - 0.01 })),
    })),
  };
  const wire = Schema.encodeSync(Schema.toCodecJson(PanelResponse))(revised);
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

it("aborts the initial POST when the demo unmounts", async () => {
  const pending = Promise.withResolvers<Response>();
  const fetch = vi.fn<typeof globalThis.fetch>(() => pending.promise);
  const view = await renderHttpDemo(fetch);
  await expect.poll(() => fetch.mock.calls.length).toBe(1);
  expect(fetch.mock.calls[0]?.[1]?.method).toBe("POST");
  await view.unmount();
  await expect.poll(() => fetch.mock.calls[0]?.[1]?.signal?.aborted, { timeout: 2_000 }).toBe(true);
});

it.each([
  ["a different panel", "broad", 200, "success"],
  ["a failed HTTP status", "nested", 500, "success"],
  ["an error body with a successful HTTP status", "nested", 200, "failure"],
] as const)(
  "rejects %s without replacing the displayed matches",
  async (_description, panelId, status, body) => {
    const broad = await replyFor("broad");
    const reply =
      body === "success"
        ? await replyFor(panelId)
        : Schema.encodeSync(Schema.toCodecJson(ClassificationFailure))(
            ClassificationFailure.cases.ModelFailure.make({
              reason: PublicModelReason.cases.RateLimitError.make({}),
              retryable: true,
            }),
          );
    const fetch = () => Promise.resolve(Response.json(reply, { status }));
    await renderDemo(Promise.resolve(broad), fetch);
    await page.getByRole("radio", { name: "Groups and subgroups" }).click();
    await expect.element(page.getByText("Could not read the reply. Try again.")).toBeVisible();
    await expect.element(page.getByText("Wait before you try again.")).not.toBeInTheDocument();
    await expect.element(page.getByRole("region", { name: "Broad groups" })).toBeVisible();
    await expect.element(page.getByText(/Matches changed/)).not.toBeInTheDocument();
  },
);
