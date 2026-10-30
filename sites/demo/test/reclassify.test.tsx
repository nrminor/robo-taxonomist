import { afterEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { cdp, userEvent } from "vitest/browser";
import { StrictMode } from "react";
import { RegistryProvider } from "@effect/atom-react";
import { Effect, Layer, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import * as Atom from "effect/reactivity/Atom";
import { Demo } from "../src/components/demo.tsx";
import { browserRuntime } from "../src/client/panel-atoms.ts";
import { type PanelId } from "../src/lib/catalog.ts";
import { ClassificationFailure, PanelResponse, PublicModelReason } from "../src/lib/contract.ts";
import { classifyPanel, PanelResults } from "../src/server/panel-results.ts";
import { initialBroadReplyThenFetch } from "./fixture-fetch.ts";

afterEach(async () => {
  await cdp().send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "reduce" }],
  });
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
  initial: Schema.Json | Promise<Schema.Json> = replyFor("broad"),
) => {
  const fetch = initialBroadReplyThenFetch(initial, interactiveFetch);
  const layer = FetchHttpClient.layer.pipe(
    Layer.provideMerge(Layer.succeed(FetchHttpClient.Fetch, fetch)),
  );
  const view = await render(
    <StrictMode>
      <RegistryProvider initialValues={[Atom.initialValue(browserRuntime.layer, layer)]}>
        <Demo />
      </RegistryProvider>
    </StrictMode>,
  );
  return { view, fetch };
};

const expectPosts = async (
  fetch: ReturnType<typeof initialBroadReplyThenFetch>,
  bodies: ReadonlyArray<{ readonly panelId: PanelId; readonly refresh?: true }>,
) => {
  expect(fetch).toHaveBeenCalledTimes(bodies.length);
  for (const [index, [input, init]] of fetch.mock.calls.entries()) {
    const request = new Request(
      new URL(
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
        "http://localhost",
      ),
      init,
    );
    expect(new URL(request.url).pathname).toBe("/api/classify");
    expect(request.method).toBe("POST");
    // Compare the raw wire body: decoding could silently discard an unwanted refresh field.
    expect(await request.json()).toEqual(bodies[index]);
  }
};

const chartValues = (figure: Element) =>
  Array.from(figure.querySelectorAll('[role="img"]:not([aria-hidden="true"])'), (row) =>
    row.getAttribute("aria-label"),
  );

it("keeps reclassification focusable but disabled until the initial results arrive", async () => {
  const initial = Promise.withResolvers<Schema.Json>();
  const interactiveFetch = vi.fn<typeof globalThis.fetch>(() =>
    Promise.reject(new Error("Unexpected reclassification during the initial request")),
  );
  const { view, fetch } = await renderDemo(interactiveFetch, initial.promise);
  const button = view.getByRole("button", { name: "Reclassify panel", exact: true });
  await expect.element(button).toBeVisible();
  await expect.element(button).toHaveAttribute("aria-disabled", "true");
  button.element().focus();
  await expect.element(button).toHaveFocus();
  await userEvent.keyboard("{Enter} ");
  await button.click({ force: true });
  await expectPosts(fetch, [{ panelId: "broad" }]);
  expect(interactiveFetch).not.toHaveBeenCalled();

  initial.resolve(await replyFor("broad"));
  await expect.element(view.getByRole("region", { name: "Panel targets" })).toBeVisible();
  await expect.element(button).not.toHaveAttribute("aria-disabled", "true");
});

it("posts a fresh Broad request once and retains the mounted chart while it is pending", async () => {
  const pending = Promise.withResolvers<Response>();
  const interactiveFetch = vi.fn<typeof globalThis.fetch>(() => pending.promise);
  const { view, fetch } = await renderDemo(interactiveFetch);
  const targets = view.getByRole("region", { name: "Panel targets" });
  await expect.element(targets).toBeVisible();
  const figure = targets.getByRole("figure", { name: "Count abundance for each target" });
  const originalFigure = figure.element();
  const originalValues = chartValues(originalFigure);
  expect(originalValues).toHaveLength(6);
  const controls = view.getByRole("complementary", { name: "Classification controls" });
  const button = controls.getByRole("button", { name: /^Reclassif/ });
  await button.click();
  await expect
    .element(view.getByRole("status"))
    .toMatchTextContent("Reclassifying with Broad groups. Still showing Broad groups.");
  await expect.element(button).toHaveTextContent("Reclassifying…");
  await expect.element(button).toHaveAttribute("aria-disabled", "true");
  await expect.element(button).toHaveFocus();
  await button.click({ force: true });
  await userEvent.keyboard("{Enter} ");
  await expectPosts(fetch, [{ panelId: "broad" }, { panelId: "broad", refresh: true }]);
  expect(interactiveFetch).toHaveBeenCalledTimes(1);
  expect(figure.element()).toBe(originalFigure);
  expect(chartValues(originalFigure)).toEqual(originalValues);
  await expect
    .element(view.getByRole("region", { name: "Broad groups", exact: true }))
    .toBeVisible();
  await expect
    .element(controls.getByRole("button", { name: /Switch to (dark|light) mode/ }))
    .toBeVisible();

  pending.resolve(Response.json(await replyFor("broad")));
  await expect.element(button).toHaveTextContent("Reclassify panel");
  await expect.element(button).not.toHaveAttribute("aria-disabled", "true");
  expect(figure.element()).toBe(originalFigure);
  await expectPosts(fetch, [{ panelId: "broad" }, { panelId: "broad", refresh: true }]);
});

it("reclassifies the selected focused panel rather than Broad and leaves ordinary selection unchanged", async () => {
  await cdp().send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "no-preference" }],
  });
  const selection = Promise.withResolvers<Response>();
  const refreshed = Promise.withResolvers<Response>();
  const interactiveFetch = vi
    .fn<typeof globalThis.fetch>()
    .mockImplementationOnce(() => selection.promise)
    .mockImplementationOnce(() => refreshed.promise);
  const { view, fetch } = await renderDemo(interactiveFetch);
  await expect.element(view.getByRole("region", { name: "Panel targets" })).toBeVisible();
  await view.getByRole("radio", { name: "Families, genera and species", exact: true }).click();
  const button = view.getByRole("button", { name: /^Reclassif/ });
  await expect.element(button).toHaveAttribute("aria-disabled", "true");
  await expectPosts(fetch, [{ panelId: "broad" }, { panelId: "focused" }]);
  selection.resolve(Response.json(await replyFor("focused")));
  await expect
    .element(view.getByRole("region", { name: "Families, genera and species", exact: true }))
    .toBeVisible();
  await expect.element(button).not.toHaveAttribute("aria-disabled", "true");
  button.element().focus();
  await userEvent.keyboard("{Enter}");
  await expect
    .element(view.getByRole("status"))
    .toMatchTextContent(
      "Reclassifying with Families, genera and species. Still showing Families, genera and species.",
    );
  await expectPosts(fetch, [
    { panelId: "broad" },
    { panelId: "focused" },
    { panelId: "focused", refresh: true },
  ]);
  refreshed.resolve(Response.json(await replyFor("focused")));
  await expect.element(button).toHaveTextContent("Reclassify panel");
  expect(document.querySelector("[data-animate]")).toHaveAttribute("data-animate", "false");
  expect(document.querySelector('[data-phase="exiting"], [data-phase="entering"]')).toBeNull();
});

it("retains results after a fresh request fails and retries the same refresh operation exactly once", async () => {
  const failure = Schema.encodeSync(Schema.toCodecJson(ClassificationFailure))(
    ClassificationFailure.cases.ModelFailure.make({
      reason: PublicModelReason.cases.RateLimitError.make({}),
      retryable: true,
    }),
  );
  const first = Promise.withResolvers<Response>();
  const retried = Promise.withResolvers<Response>();
  const interactiveFetch = vi
    .fn<typeof globalThis.fetch>()
    .mockImplementationOnce(() => first.promise)
    .mockImplementationOnce(() => retried.promise);
  const { view, fetch } = await renderDemo(interactiveFetch);
  const targets = view.getByRole("region", { name: "Panel targets" });
  await expect.element(targets).toBeVisible();
  const figure = targets.getByRole("figure", { name: "Count abundance for each target" });
  const originalFigure = figure.element();
  const originalValues = chartValues(originalFigure);
  await view.getByRole("button", { name: "Reclassify panel", exact: true }).click();
  first.resolve(Response.json(failure, { status: 503 }));
  await expect.element(view.getByRole("alert")).toBeVisible();
  await expect
    .element(view.getByRole("region", { name: "Broad groups", exact: true }))
    .toBeVisible();
  expect(figure.element()).toBe(originalFigure);
  expect(chartValues(originalFigure)).toEqual(originalValues);

  const retry = view.getByRole("button", { name: "Try again", exact: true });
  retry.element().focus();
  await userEvent.keyboard("{Enter}");
  await expect.element(retry).toHaveAttribute("aria-disabled", "true");
  await userEvent.keyboard("{Enter} ");
  await expectPosts(fetch, [
    { panelId: "broad" },
    { panelId: "broad", refresh: true },
    { panelId: "broad", refresh: true },
  ]);
  expect(interactiveFetch).toHaveBeenCalledTimes(2);
  expect(figure.element()).toBe(originalFigure);
  expect(chartValues(originalFigure)).toEqual(originalValues);
  retried.resolve(Response.json(await replyFor("broad")));
  await expect.element(view.getByRole("alert")).not.toBeInTheDocument();
  await expect
    .element(view.getByRole("button", { name: "Reclassify panel", exact: true }))
    .not.toHaveAttribute("aria-disabled", "true");
  expect(figure.element()).toBe(originalFigure);
  await expectPosts(fetch, [
    { panelId: "broad" },
    { panelId: "broad", refresh: true },
    { panelId: "broad", refresh: true },
  ]);
});
