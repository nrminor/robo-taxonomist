import { afterEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { page, userEvent } from "vitest/browser";
import { RegistryProvider } from "@effect/atom-react";
import { Effect, Layer, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import * as Atom from "effect/reactivity/Atom";
import { Demo } from "../src/components/demo.tsx";
import { browserRuntime } from "../src/client/panel-atoms.ts";
import { PanelResponse, ClassifyRequest } from "../src/lib/contract.ts";
import { type PanelId } from "../src/lib/catalog.ts";
import { classifyPanel, PanelResults } from "../src/server/panel-results.ts";
import { initialBroadReplyThenFetch } from "./fixture-fetch.ts";

afterEach(async () => {
  await page.viewport(1440, 1000);
});

const classifyFixture = (panelId: PanelId) =>
  Effect.runPromise(
    classifyPanel(panelId).pipe(
      Effect.provide(PanelResults.layer),
      Effect.map((response) => Schema.encodeSync(Schema.toCodecJson(PanelResponse))(response)),
    ),
  );

const renderDemo = async (interactiveFetch: typeof globalThis.fetch) => {
  const fetch = initialBroadReplyThenFetch(await classifyFixture("broad"), interactiveFetch);
  const layer = FetchHttpClient.layer.pipe(
    Layer.provideMerge(Layer.succeed(FetchHttpClient.Fetch, fetch)),
  );
  const view = await render(
    <RegistryProvider initialValues={[Atom.initialValue(browserRuntime.layer, layer)]}>
      <Demo />
    </RegistryProvider>,
  );
  await expect.element(view.getByRole("region", { name: "Panel targets" })).toBeVisible();
  return view;
};

const unexpectedFetch = () =>
  vi.fn<typeof globalThis.fetch>(() =>
    Promise.reject(new Error("Unexpected classification request")),
  );

const examples = [
  {
    example: "Inspect species example",
    name: "Saccharomyces cerevisiae",
    kind: "Species record",
    metadata: "Species · 14%",
    share: "14%",
    result: "Matches",
  },
  {
    example: "Inspect genus-only example",
    name: "Saccharomyces",
    kind: "Genus-only record",
    metadata: "Genus · 4%",
    share: "4%",
    result: "Matches",
  },
  {
    example: "Inspect unclassified example",
    name: "unclassified microorganism",
    kind: "Unresolved name",
    metadata: "Unclassified · 4%",
    share: "4%",
    result: "Uncertain",
  },
] satisfies ReadonlyArray<{
  example: string;
  name: string;
  kind: string;
  metadata: string;
  share: string;
  result: "Matches" | "Uncertain";
}>;

it.each(examples)(
  "selects $name through its real example and toggles its row without another POST",
  async ({ example, name, kind, metadata, share, result }) => {
    const interactiveFetch = unexpectedFetch();
    const view = await renderDemo(interactiveFetch);
    const row = view.getByRole("button", { name: new RegExp(`^${name}, `) });
    await expect.element(view.getByRole("button", { name: /Select record$/ })).toHaveLength(24);
    await expect
      .element(row)
      .toHaveAttribute("aria-label", `${name}, ${share} of sample. ${result}. Select record`);
    await expect.element(row).toMatchTextContent(kind);
    await view.getByRole("button", { name: example }).click();
    await expect.element(row).toHaveAttribute("aria-pressed", "true");
    const current = view.getByRole("region", { name: "Current record" });
    await expect.element(current).toMatchTextContent(name);
    await expect.element(current).toMatchTextContent(metadata);
    const inspector = view.getByRole("region", { name, exact: true });
    await expect.element(inspector).toMatchTextContent("Results in Broad groups");
    await expect.element(view.getByRole("button", { name: "View answer details" })).toBeVisible();
    await row.click();
    await expect.element(row).toHaveAttribute("aria-pressed", "false");
    await expect.element(inspector).not.toBeInTheDocument();
    await expect
      .element(current)
      .toMatchTextContent("Select a record from the list or an example.");
    await expect
      .element(view.getByRole("button", { name: "Clear selection", exact: true }))
      .not.toBeInTheDocument();
    expect(interactiveFetch).not.toHaveBeenCalled();
  },
);

it("preserves row identity and an open native disclosure for repeated examples, but resets for another record", async () => {
  const view = await renderDemo(unexpectedFetch());
  const row = view.getByRole("button", { name: /^Saccharomyces cerevisiae, / });
  const originalRow = row.element();
  await row.click();
  const fungi = view.getByRole("group", { name: "Fungi", exact: true });
  const summary = fungi.getByText("Answer probabilities", { exact: true });
  await summary.click();
  const disclosure = summary.element().parentElement;
  await expect.element(disclosure).toHaveAttribute("open");
  for (const repeat of [1, 2]) {
    await view.getByRole("button", { name: "Inspect species example" }).click();
    expect(row.element(), `selection ${repeat} retains the row`).toBe(originalRow);
    expect(summary.element().parentElement).toBe(disclosure);
    await expect.element(disclosure).toHaveAttribute("open");
    await expect.element(row).toHaveAttribute("aria-pressed", "true");
  }
  await view.getByRole("button", { name: "Inspect genus-only example" }).click();
  await expect
    .element(fungi.getByText("Answer probabilities").element().parentElement)
    .not.toHaveAttribute("open");
  await view.getByRole("button", { name: "Inspect species example" }).click();
  await expect
    .element(fungi.getByText("Answer probabilities").element().parentElement)
    .not.toHaveAttribute("open");
});

it("focuses answer details, returns to the row, and restores row focus before clearing inline actions", async () => {
  const view = await renderDemo(unexpectedFetch());
  const row = view.getByRole("button", { name: /^Saccharomyces cerevisiae, / });
  await row.click();
  await view.getByRole("button", { name: "View answer details" }).click();
  await expect
    .element(view.getByRole("heading", { name: "Saccharomyces cerevisiae", exact: true }))
    .toHaveFocus();
  await view.getByRole("button", { name: "Back to sample records ↑" }).click();
  await expect.element(row).toHaveFocus();
  await view.getByRole("button", { name: "Clear selection", exact: true }).click();
  await expect.element(row).toHaveFocus();
  await expect.element(row).toHaveAttribute("aria-pressed", "false");
  await expect
    .element(view.getByRole("region", { name: "Saccharomyces cerevisiae", exact: true }))
    .not.toBeInTheDocument();
});

it("scrolls only the real record list for examples on mobile and supports native Enter and Space toggles", async () => {
  await page.viewport(390, 1000);
  const view = await renderDemo(unexpectedFetch());
  const scroller = view.getByLabelText("Sample records and selected-record matches").element();
  for (const { example, name } of examples) {
    const button = view.getByRole("button", { name: example });
    const row = view.getByRole("button", { name: new RegExp(`^${name}, `) });
    for (const repeat of [1, 2]) {
      scroller.scrollTop = name === "Saccharomyces cerevisiae" ? scroller.scrollHeight : 0;
      button.element().scrollIntoView({ block: "center", behavior: "instant" });
      const pageY = window.scrollY;
      await button.click();
      await expect.element(row).toHaveAttribute("aria-pressed", "true");
      await expect
        .poll(
          () => {
            const bounds = scroller.getBoundingClientRect();
            const record = row.element().getBoundingClientRect();
            return record.top >= bounds.top - 0.6 && record.bottom <= bounds.bottom + 0.6;
          },
          { message: `${example}, selection ${repeat} is inside the list viewport` },
        )
        .toBe(true);
      expect(Math.abs(window.scrollY - pageY)).toBeLessThanOrEqual(0.6);
    }
  }
  const row = view.getByRole("button", { name: /^unclassified microorganism, / });
  row.element().focus({ preventScroll: true });
  await expect.element(row).toHaveFocus();
  await userEvent.keyboard("{Enter}");
  await expect.element(row).toHaveAttribute("aria-pressed", "false");
  await userEvent.keyboard(" ");
  await expect.element(row).toHaveAttribute("aria-pressed", "true");
});

it("shows a focused genus record ruling out the species target after a real panel request", async () => {
  const interactiveFetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
    const request = Schema.decodeSync(Schema.fromJsonString(ClassifyRequest))(
      await new Response(init?.body).text(),
    );
    return Response.json(await classifyFixture(request.panelId));
  });
  const view = await renderDemo(interactiveFetch);
  await view.getByRole("radio", { name: "Families, genera and species" }).click();
  await expect
    .element(view.getByRole("region", { name: "Families, genera and species", exact: true }))
    .toBeVisible();
  const row = view.getByRole("button", {
    name: "Lactiplantibacillus, 3% of sample. No match. Select record",
    exact: true,
  });
  await row.click();
  const inspector = view.getByRole("region", { name: "Lactiplantibacillus", exact: true });
  await expect
    .element(
      inspector
        .getByRole("group", { name: "Lactiplantibacillus plantarum", exact: true })
        .getByText("No match", { exact: true }),
    )
    .toBeVisible();
  await expect
    .element(view.getByRole("region", { name: "Current record" }))
    .toMatchTextContent("Genus · 3%");
  expect(interactiveFetch).toHaveBeenCalledTimes(1);
  expect(interactiveFetch.mock.calls[0]?.[1]?.method).toBe("POST");
});
