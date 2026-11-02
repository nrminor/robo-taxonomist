import { afterEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { cdp, page, userEvent } from "vitest/browser";
import { Profiler, StrictMode, type ProfilerOnRenderCallback } from "react";
import { Effect, Layer, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import * as Atom from "effect/reactivity/Atom";
import { RegistryProvider } from "@effect/atom-react";
import { Demo } from "../src/components/demo.tsx";
import { ClassificationFailure, PanelResponse, PublicModelReason } from "../src/lib/contract.ts";
import { type PanelId } from "../src/lib/catalog.ts";
import { classifyPanel, PanelResults } from "../src/server/panel-results.ts";
import { browserRuntime } from "../src/client/panel-atoms.ts";
import { initialBroadReplyThenFetch } from "./fixture-fetch.ts";

afterEach(async () => {
  await page.viewport(1440, 1000);
  await cdp().send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "reduce" }],
  });
});

it("uses the keyboard retry's motion policy after a pointer-initiated failure", async () => {
  await cdp().send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "no-preference" }],
  });
  const failure = Schema.encodeSync(Schema.toCodecJson(ClassificationFailure))(
    ClassificationFailure.cases.ModelFailure.make({
      reason: PublicModelReason.cases.RateLimitError.make({}),
      retryable: true,
    }),
  );
  const focused = await replyFor("focused");
  const interactiveFetch = vi
    .fn<() => Promise<Response>>()
    .mockResolvedValueOnce(Response.json(failure, { status: 503 }))
    .mockResolvedValueOnce(Response.json(focused));
  const view = await renderDemo(interactiveFetch);
  await expect.element(view.getByRole("region", { name: "Panel targets" })).toBeVisible();
  await view.getByRole("radio", { name: "Families, genera and species", exact: true }).click();
  await expect.element(view.getByRole("alert")).toBeVisible();
  view.getByRole("button", { name: "Try again", exact: true }).element().focus();
  await userEvent.keyboard("{Enter}");
  await expect
    .element(
      view.getByRole("region", {
        name: "Families, genera and species",
        exact: true,
      }),
    )
    .toBeVisible();
  expect(document.querySelector("[data-animate]")).toHaveAttribute("data-animate", "false");
  expect(document.querySelector('[data-phase="exiting"], [data-phase="entering"]')).toBeNull();
  expect(interactiveFetch).toHaveBeenCalledTimes(2);
});

const replyFor = (panelId: PanelId) =>
  Effect.runPromise(
    classifyPanel(panelId).pipe(
      Effect.provide(PanelResults.layer),
      Effect.map((response) => Schema.encodeSync(Schema.toCodecJson(PanelResponse))(response)),
    ),
  );

const renderDemo = async (
  interactiveFetch: typeof globalThis.fetch,
  onRender?: ProfilerOnRenderCallback,
) => {
  const fetch = initialBroadReplyThenFetch(await replyFor("broad"), interactiveFetch);
  const layer = FetchHttpClient.layer.pipe(
    Layer.provideMerge(Layer.succeed(FetchHttpClient.Fetch, fetch)),
  );
  const view = await render(
    <StrictMode>
      <RegistryProvider initialValues={[Atom.initialValue(browserRuntime.layer, layer)]}>
        {onRender === undefined ? (
          <Demo />
        ) : (
          <Profiler id="demo" onRender={onRender}>
            <Demo />
          </Profiler>
        )}
      </RegistryProvider>
    </StrictMode>,
  );
  await expect.element(view.getByRole("region", { name: "Panel targets" })).toBeVisible();
  return view;
};

it("keeps Current record and the mobile workspace in place throughout a pending panel change", async () => {
  await page.viewport(390, 1000);
  const pending = Promise.withResolvers<Response>();
  const view = await renderDemo(() => pending.promise);
  const current = view.getByRole("region", { name: "Current record" });
  const targets = view.getByRole("region", { name: "Panel targets" });
  await expect.element(targets).toBeVisible();
  const currentTop = current.element().getBoundingClientRect().top;
  const targetsTop = targets.element().getBoundingClientRect().top;
  await view.getByRole("radio", { name: "Families, genera and species", exact: true }).click();
  expect(current.element().getBoundingClientRect().top).toBe(currentTop);
  expect(targets.element().getBoundingClientRect().top).toBe(targetsTop);
  await expect
    .element(view.getByRole("status"))
    .toMatchTextContent("Updating to Families, genera and species. Still showing Broad groups.");
  expect(current.element().getBoundingClientRect().top).toBe(currentTop);
  expect(targets.element().getBoundingClientRect().top).toBe(targetsTop);
  pending.resolve(Response.json(await replyFor("focused")));
  await expect
    .element(view.getByRole("region", { name: "Families, genera and species", exact: true }))
    .toBeVisible();
  expect(current.element().getBoundingClientRect().top).toBe(currentTop);
  expect(targets.element().getBoundingClientRect().top).toBe(targetsTop);
});

const chartValues = (figure: Element) =>
  Array.from(figure.querySelectorAll('[role="img"]:not([aria-hidden="true"])'), (row) =>
    row.getAttribute("aria-label"),
  );

it.each([320, 390, 1000, 1440])(
  "shows an inline update on the retained chart without replacing its values at %i px",
  async (width) => {
    await page.viewport(width, 1000);
    const focused = await replyFor("focused");
    const pending = Promise.withResolvers<Response>();
    const view = await renderDemo(() => pending.promise);
    const targets = view.getByRole("region", { name: "Panel targets" });
    const figure = targets.getByRole("figure", { name: "Count abundance for each target" });
    const originalFigure = figure.element();
    const originalValues = chartValues(originalFigure);
    expect(originalValues).toHaveLength(6);
    const top = targets.element().getBoundingClientRect().top;
    const broad = view.getByRole("region", { name: "Broad groups", exact: true });
    const workspace = broad.element().parentElement;
    if (workspace === null) throw new Error("Results workspace missing");
    const message = targets.getByText(
      "Updating to Families, genera and species. Still showing Broad groups.",
      { exact: true },
    );

    await view.getByRole("radio", { name: "Families, genera and species", exact: true }).click();

    await expect.element(message).toBeVisible();
    expect(figure.element()).toBe(originalFigure);
    expect(chartValues(originalFigure)).toEqual(originalValues);
    await expect.element(broad).toBeVisible();
    expect(workspace).toHaveAttribute("aria-busy", "true");
    expect(targets.element().getBoundingClientRect().top).toBe(top);
    const bounds = message.element().getBoundingClientRect();
    const region = targets.element().getBoundingClientRect();
    expect(bounds.left).toBeGreaterThanOrEqual(region.left);
    expect(bounds.right).toBeLessThanOrEqual(region.right);
    expect(bounds.top).toBeGreaterThanOrEqual(region.top);
    expect(bounds.bottom).toBeLessThanOrEqual(originalFigure.getBoundingClientRect().top);
    for (
      let node: Element | null = message.element();
      node !== targets.element();
      node = node.parentElement
    ) {
      if (node === null) throw new Error("Update message must be inside Panel targets");
      expect(["absolute", "fixed"]).not.toContain(getComputedStyle(node).position);
    }
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
    await expect
      .element(view.getByRole("status"))
      .toMatchTextContent("Updating to Families, genera and species. Still showing Broad groups.");

    pending.resolve(Response.json(focused));

    await expect
      .element(view.getByRole("region", { name: "Families, genera and species", exact: true }))
      .toBeVisible();
    await expect.element(message).not.toBeInTheDocument();
    expect(figure.element()).toBe(originalFigure);
    await expect
      .element(figure.getByRole("img", { name: /^Saccharomyces · genus/ }))
      .toHaveAttribute("aria-label", expect.stringContaining("18% of sample"));
    await expect
      .element(figure.getByRole("img", { name: /^Lactiplantibacillus plantarum · species/ }))
      .toHaveAttribute("aria-label", expect.stringContaining("12% of sample"));
    await expect.element(broad).not.toBeInTheDocument();
    expect(workspace).toHaveAttribute("aria-busy", "false");
    expect(targets.element().getBoundingClientRect().top).toBe(top);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
  },
);

it("clears the inline chart update on failure while retaining Broad groups and offering retry", async () => {
  const failure = Schema.encodeSync(Schema.toCodecJson(ClassificationFailure))(
    ClassificationFailure.cases.ModelFailure.make({
      reason: PublicModelReason.cases.RateLimitError.make({}),
      retryable: true,
    }),
  );
  const pending = Promise.withResolvers<Response>();
  const view = await renderDemo(() => pending.promise);
  const targets = view.getByRole("region", { name: "Panel targets" });
  const figure = targets.getByRole("figure", { name: "Count abundance for each target" });
  const originalFigure = figure.element();
  const broad = view.getByRole("region", { name: "Broad groups", exact: true });
  const workspace = broad.element().parentElement;
  if (workspace === null) throw new Error("Results workspace missing");
  const message = targets.getByText(
    "Updating to Families, genera and species. Still showing Broad groups.",
    { exact: true },
  );
  await view.getByRole("radio", { name: "Families, genera and species", exact: true }).click();
  await expect.element(message).toBeVisible();

  pending.resolve(Response.json(failure, { status: 503 }));

  await expect
    .element(view.getByRole("alert"))
    .toMatchTextContent(
      "Could not update Families, genera and species. Still showing Broad groups.",
    );
  await expect.element(message).not.toBeInTheDocument();
  await expect.element(broad).toBeVisible();
  expect(figure.element()).toBe(originalFigure);
  await expect
    .element(figure.getByRole("img", { name: /^Fungi · kingdom/ }))
    .toHaveAttribute("aria-label", expect.stringContaining("31% of sample"));
  expect(workspace).toHaveAttribute("aria-busy", "false");
  await expect.element(view.getByRole("button", { name: "Try again", exact: true })).toBeVisible();
});

it("keeps the old results busy for a full visible update before publishing a ready reply", async () => {
  const focused = await replyFor("focused");
  const pending = Promise.withResolvers<Response>();
  const shown = Promise.withResolvers<number>();
  const published = Promise.withResolvers<number>();
  const observeCommit: ProfilerOnRenderCallback = (
    _id,
    _phase,
    _actual,
    _base,
    _started,
    committedAt,
  ) => {
    const status = document.querySelector('main [role="status"]');
    if (status?.textContent?.startsWith("Updating to")) shown.resolve(committedAt);
    if (document.querySelector('section[aria-label="Families, genera and species"]'))
      published.resolve(committedAt);
  };
  const view = await renderDemo(() => pending.promise, observeCommit);
  const broad = view.getByRole("region", { name: "Broad groups", exact: true });
  await expect.element(broad).toBeVisible();
  const workspace = broad.element().parentElement;
  if (workspace === null) throw new Error("Results workspace missing");
  await view.getByRole("radio", { name: "Families, genera and species", exact: true }).click();
  const shownAt = await shown.promise;
  pending.resolve(Response.json(focused));
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  await expect.element(broad).toBeVisible();
  expect(workspace).toHaveAttribute("aria-busy", "true");
  expect((await published.promise) - shownAt).toBeGreaterThanOrEqual(245);
  await expect
    .element(view.getByRole("status"))
    .toMatchTextContent("Families, genera and species results displayed.");
  expect(workspace).toHaveAttribute("aria-busy", "false");
});

it("publishes a fast reply without briefly announcing an update", async () => {
  const focused = await replyFor("focused");
  const view = await renderDemo(async () => Response.json(focused));
  await expect.element(view.getByRole("region", { name: "Panel targets" })).toBeVisible();
  const messages: string[] = [];
  const observer = new MutationObserver(() => {
    for (const status of document.querySelectorAll('main [role="status"]')) {
      const text = status.textContent?.trim();
      if (text && /^(Classifying|Updating|Retrying)/.test(text)) messages.push(text);
    }
  });
  observer.observe(document.body, { childList: true, characterData: true, subtree: true });
  try {
    await view.getByRole("radio", { name: "Families, genera and species", exact: true }).click();
    await expect
      .element(view.getByRole("region", { name: "Families, genera and species", exact: true }))
      .toBeVisible();
    expect(messages).toEqual([]);
  } finally {
    observer.disconnect();
  }
});

it("holds an immediately successful retry for a full committed update and restores panel focus", async () => {
  const failure = Schema.encodeSync(Schema.toCodecJson(ClassificationFailure))(
    ClassificationFailure.cases.ModelFailure.make({
      reason: PublicModelReason.cases.RateLimitError.make({}),
      retryable: true,
    }),
  );
  const focused = await replyFor("focused");
  const interactiveFetch = vi
    .fn<() => Promise<Response>>()
    .mockResolvedValueOnce(Response.json(failure, { status: 503 }))
    .mockResolvedValueOnce(Response.json(focused));
  const shown = Promise.withResolvers<number>();
  const published = Promise.withResolvers<number>();
  const observeCommit: ProfilerOnRenderCallback = (
    _id,
    _phase,
    _actual,
    _base,
    _started,
    committedAt,
  ) => {
    const status = document.querySelector('main [role="status"]');
    if (status?.textContent?.startsWith("Retrying")) shown.resolve(committedAt);
    if (document.querySelector('section[aria-label="Families, genera and species"]'))
      published.resolve(committedAt);
  };
  const view = await renderDemo(interactiveFetch, observeCommit);
  const panel = view.getByRole("radio", { name: "Families, genera and species", exact: true });
  await panel.click();
  await expect.element(view.getByRole("alert")).toBeVisible();
  await view.getByRole("button", { name: "Try again", exact: true }).click();
  // Retry feedback must commit even when the response is already available.
  expect((await published.promise) - (await shown.promise)).toBeGreaterThanOrEqual(245);
  await expect
    .element(view.getByRole("region", { name: "Families, genera and species", exact: true }))
    .toBeVisible();
  await expect
    .element(view.getByRole("region", { name: "Panel update", exact: true }))
    .not.toBeInTheDocument();
  await expect.element(panel).toHaveFocus();
  expect(interactiveFetch).toHaveBeenCalledTimes(2);
});

it("discards a held success when another panel replaces it, preserving the committed comparison", async () => {
  const focused = await replyFor("focused");
  const nested = await replyFor("nested");
  const first = Promise.withResolvers<Response>();
  const second = Promise.withResolvers<Response>();
  const interactiveFetch = vi
    .fn<() => Promise<Response>>()
    .mockImplementationOnce(() => first.promise)
    .mockImplementationOnce(() => second.promise);
  const view = await renderDemo(interactiveFetch);
  const broad = view.getByRole("region", { name: "Broad groups", exact: true });
  await expect.element(broad).toBeVisible();
  const published: string[] = [];
  const observer = new MutationObserver(() => {
    for (const name of ["Families, genera and species", "Groups and subgroups"]) {
      if (document.querySelector(`section[aria-label="${name}"]`)) published.push(name);
    }
  });
  observer.observe(document.body, { childList: true, attributes: true, subtree: true });
  try {
    await view.getByRole("radio", { name: "Families, genera and species", exact: true }).click();
    await expect
      .element(view.getByRole("status"))
      .toMatchTextContent("Updating to Families, genera and species.");
    const shownAt = performance.now();
    first.resolve(Response.json(focused));
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    await expect.element(broad).toBeVisible();
    await view.getByRole("radio", { name: "Groups and subgroups", exact: true }).click();
    await expect
      .element(view.getByRole("status"))
      .toMatchTextContent("Updating to Groups and subgroups. Still showing Broad groups.");
    await expect.poll(() => performance.now() - shownAt).toBeGreaterThanOrEqual(270);
    await expect.element(broad).toBeVisible();
    second.resolve(Response.json(nested));
    await expect
      .element(view.getByRole("region", { name: "Groups and subgroups", exact: true }))
      .toBeVisible();
    await expect
      .element(view.getByText("Matches changed for 19 records since Broad groups."))
      .toBeVisible();
    expect(published).not.toContain("Families, genera and species");
    expect(interactiveFetch).toHaveBeenCalledTimes(2);
  } finally {
    observer.disconnect();
  }
});

it.each([
  { width: 320, focus: "retry" },
  { width: 1440, focus: "record" },
])(
  "keeps long failures bounded and preserves retry focus at $width px ($focus)",
  async ({ width, focus }) => {
    await page.viewport(width, 1000);
    const failure = Schema.encodeSync(Schema.toCodecJson(ClassificationFailure))(
      ClassificationFailure.cases.ModelFailure.make({
        reason: PublicModelReason.cases.RateLimitError.make({}),
        retryable: true,
        requestId: `req-${"x".repeat(2000)}`,
      }),
    );
    const focused = await replyFor("focused");
    const retried = Promise.withResolvers<Response>();
    const interactiveFetch = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(Response.json(failure, { status: 503 }))
      .mockImplementationOnce(() => retried.promise);
    const view = await renderDemo(interactiveFetch);
    const current = view.getByRole("region", { name: "Current record" });
    await expect.element(current).toBeVisible();
    const top = current.element().getBoundingClientRect().top;
    await view.getByRole("radio", { name: "Families, genera and species", exact: true }).click();
    await expect.element(view.getByRole("alert")).toMatchTextContent("Wait before you try again.");
    expect(current.element().getBoundingClientRect().top).toBe(top);
    const card = view.getByRole("region", { name: "Panel update", exact: true });
    const bounds = card.element().getBoundingClientRect();
    expect(bounds.left).toBeGreaterThanOrEqual(16);
    expect(bounds.right).toBeLessThanOrEqual(width - 16);
    expect(bounds.bottom).toBeLessThanOrEqual(984);
    expect(bounds.height).toBeLessThanOrEqual(500);
    const retry = view.getByRole("button", { name: "Try again", exact: true });
    const button = retry.element();
    await retry.click();
    await expect
      .element(view.getByRole("status"))
      .toMatchTextContent("Retrying Families, genera and species. Still showing Broad groups.");
    expect(retry.element()).toBe(button);
    await expect.element(retry).toHaveFocus();
    await expect.element(retry).toHaveAttribute("aria-disabled", "true");
    await userEvent.keyboard("{Enter}");
    expect(interactiveFetch).toHaveBeenCalledTimes(2);
    const record = view.getByRole("button", { name: /^Saccharomyces cerevisiae, / });
    if (focus === "record") {
      record.element().focus({ preventScroll: true });
    }
    retried.resolve(Response.json(focused));
    await expect
      .element(view.getByRole("region", { name: "Families, genera and species", exact: true }))
      .toBeVisible();
    await expect.element(view.getByRole("alert")).not.toBeInTheDocument();
    await expect.element(card).not.toBeInTheDocument();
    await expect
      .element(
        focus === "record"
          ? record
          : view.getByRole("radio", { name: "Families, genera and species", exact: true }),
      )
      .toHaveFocus();
  },
);

it("announces a new retry failure even when its request details were collapsed", async () => {
  const failure = Schema.encodeSync(Schema.toCodecJson(ClassificationFailure))(
    ClassificationFailure.cases.ModelFailure.make({
      reason: PublicModelReason.cases.RateLimitError.make({}),
      retryable: true,
    }),
  );
  const pending = Promise.withResolvers<Response>();
  const interactiveFetch = vi
    .fn<() => Promise<Response>>()
    .mockResolvedValueOnce(Response.json(failure, { status: 503 }))
    .mockImplementationOnce(() => pending.promise);
  const view = await renderDemo(interactiveFetch);
  await view.getByRole("radio", { name: "Families, genera and species", exact: true }).click();
  await expect.element(view.getByRole("alert")).toBeVisible();
  await view.getByRole("button", { name: "Try again", exact: true }).click();
  await expect
    .element(view.getByRole("status"))
    .toMatchTextContent("Retrying Families, genera and species.");
  await view.getByText("Request details", { exact: true }).click();
  pending.resolve(Response.json(failure, { status: 503 }));
  await expect.element(view.getByRole("alert")).toBeVisible();
  await expect
    .element(view.getByRole("alert"))
    .toMatchTextContent(
      "Could not update Families, genera and species. Still showing Broad groups.",
    );
});
