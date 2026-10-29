import { afterEach, expect, it } from "vitest";
import { cleanup, render } from "vitest-browser-react";
import { page, userEvent } from "vitest/browser";
import { StrictMode } from "react";
import { Effect, Layer, Result, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import * as Atom from "effect/reactivity/Atom";
import { RegistryProvider } from "@effect/atom-react";
import { Demo } from "../src/components/demo.tsx";
import {
  ClassificationReply,
  ClassifyRequest,
  MatchJudgment,
  PanelResponse,
} from "../src/lib/contract.ts";
import { type PanelId } from "../src/lib/catalog.ts";
import { classifyPanel, PanelResults } from "../src/server/panel-results.ts";
import { browserRuntime } from "../src/client/panel-atoms.ts";

afterEach(async () => {
  await cleanup();
  localStorage.clear();
  await page.viewport(1440, 1000);
});

const fixture = (panelId: PanelId) =>
  Effect.runPromise(classifyPanel(panelId).pipe(Effect.provide(PanelResults.layer)));
const wire = (response: PanelResponse) =>
  Schema.encodeSync(ClassificationReply)(Result.succeed(response));
const renderDemo = async (response: PanelResponse) => {
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = Schema.decodeUnknownSync(ClassifyRequest)(
      await new Request(input, init).json(),
    );
    return Response.json(wire(await fixture(request.panelId)));
  };
  const layer = FetchHttpClient.layer.pipe(
    Layer.provideMerge(Layer.succeed(FetchHttpClient.Fetch, fetch)),
  );
  return render(
    <StrictMode>
      <RegistryProvider initialValues={[Atom.initialValue(browserRuntime.layer, layer)]}>
        <Demo initial={Promise.resolve(wire(response))} />
      </RegistryProvider>
    </StrictMode>,
  );
};

it("paints full record shares in catalog order and selects only actual contributions", async () => {
  const view = await renderDemo(await fixture("nested"));
  const fungi = view.getByRole("img", { name: /^Fungi · kingdom/ });
  await expect.element(fungi).toBeVisible();
  const plot = fungi.element().querySelector("[data-plot]");
  if (plot === null) throw new Error("Fungi plot is missing");
  const width = plot.getBoundingClientRect().width;
  const left = plot.getBoundingClientRect().left;
  const examples = [
    { id: "r01", share: 0.35, offset: 0 },
    { id: "r02", share: 0.2, offset: 0.35 },
    { id: "r03", share: 0.125, offset: 0.55 },
    { id: "r19", share: 0.1, offset: 0.675 },
  ];
  for (const { id, share, offset } of examples) {
    const segment = fungi.element().querySelector(`[data-record-id="${id}"]`);
    if (segment === null) throw new Error(`Fungi segment ${id} is missing`);
    expect(segment.getBoundingClientRect().width).toBeCloseTo(width * share, 1);
    expect(segment.getBoundingClientRect().left - left).toBeCloseTo(width * offset, 1);
  }
  const segment = fungi.element().querySelector('[data-record-id="r02"]');
  if (segment === null) throw new Error("Fungi segment r02 is missing");
  expect(getComputedStyle(segment).backgroundColor).toBe("rgb(37, 99, 235)");
  const before = segment.getBoundingClientRect().width;
  await view.getByRole("button", { name: /^Kluyveromyces lactis, / }).click();
  await expect.element(fungi).toHaveAttribute("data-contributing", "true");
  expect(fungi.element().querySelector('[data-record-id="r02"]')).toBe(segment);
  expect(segment.getBoundingClientRect().width).toBe(before);
  expect(segment).toHaveAttribute("data-selected", "true");
  expect(getComputedStyle(segment).backgroundColor).toBe("rgb(8, 126, 121)");
  await view.getByRole("button", { name: /^Saccharomyces, / }).click();
  const species = view.getByRole("img", { name: /^Saccharomyces cerevisiae · species/ });
  await expect.element(species).toHaveAttribute("data-contributing", "false");
  expect(species.element().querySelector('[data-record-id="r19"]')).toHaveAttribute(
    "data-contributing",
    "false",
  );
});

it("retains keyed rows and segments across absence, with active rows in panel keyboard order", async () => {
  const view = await renderDemo(await fixture("broad"));
  const fungi = view.getByRole("img", { name: /^Fungi · kingdom/ });
  await expect.element(fungi).toBeVisible();
  const original = fungi.element();
  const segment = original.querySelector('[data-record-id="r02"]');
  const acetobacter = view.getByRole("img", { name: /^Acetobacteraceae · family/ }).element();
  await view.getByRole("radio", { name: "Families, genera and species", exact: true }).click();
  await expect
    .element(view.getByRole("img", { name: /^Kluyveromyces lactis · species/ }))
    .toBeVisible();
  expect(original).not.toBeVisible();
  expect(original).toHaveAttribute("inert");
  expect(original).toHaveAttribute("aria-hidden", "true");
  expect(original).toHaveAttribute("tabindex", "-1");
  expect(original.querySelector('[data-record-id="r02"]')).toBe(segment);
  expect(segment).toHaveAttribute("data-contributing", "true");
  expect(view.getByRole("img", { name: /^Acetobacteraceae · family/ }).element()).toBe(acetobacter);
  const chart = view.getByRole("figure", { name: "Count abundance for each target" }).element();
  expect(
    [...chart.querySelectorAll('[data-active="true"]')].map((row) =>
      row.getAttribute("data-target-id"),
    ),
  ).toEqual([
    "saccharomyces",
    "kluyveromyces-lactis",
    "lactiplantibacillus-plantarum",
    "levilactobacillus",
    "acetobacteraceae",
    "bifidobacterium",
    "streptomyces-coelicolor",
    "nostoc",
    "methanobacteriaceae",
    "methanococcus-maripaludis",
  ]);
  await view.getByRole("radio", { name: "Groups and subgroups", exact: true }).click();
  await expect.element(fungi).toBeVisible();
  expect(fungi.element()).toBe(original);
  expect(original.querySelector('[data-record-id="r02"]')).toBe(segment);
});

it("expands its axis for actual response judgments and never contracts on the next panel", async () => {
  const broad = await fixture("broad");
  const expanded = Schema.decodeUnknownSync(PanelResponse)({
    ...broad,
    rows: broad.rows.map((row) => ({
      ...row,
      matches: row.matches.map((match) =>
        match.targetId === "fungi"
          ? {
              ...match,
              judgment: MatchJudgment.cases.Matched.make({}),
              support: 0.51,
              answer: {
                label: "withinTaxon",
                confidence: 0.51,
                probabilities: { sameTaxon: 0, withinTaxon: 0.51, noMatch: 0.49, undetermined: 0 },
              },
            }
          : match,
      ),
    })),
  });
  const view = await renderDemo(expanded);
  const fungi = view.getByRole("img", { name: /^Fungi · kingdom/ });
  await expect
    .element(fungi)
    .toHaveAttribute("aria-label", expect.stringContaining("100% of sample · 24 matching records"));
  const plot = fungi.element().querySelector("[data-plot]");
  const first = fungi.element().querySelector('[data-record-id="r01"]');
  if (plot === null || first === null) throw new Error("Fungi composition is missing");
  expect(first.getBoundingClientRect().width).toBeCloseTo(
    plot.getBoundingClientRect().width * 0.14,
    1,
  );
  await view.getByRole("radio", { name: "Families, genera and species", exact: true }).click();
  const genus = view.getByRole("img", { name: /^Saccharomyces · genus/ });
  await expect.element(genus).toBeVisible();
  const nextPlot = genus.element().querySelector("[data-plot]");
  const nextSegment = genus.element().querySelector('[data-record-id="r01"]');
  if (nextPlot === null || nextSegment === null)
    throw new Error("Saccharomyces composition is missing");
  expect(nextSegment.getBoundingClientRect().width).toBeCloseTo(
    nextPlot.getBoundingClientRect().width * 0.14,
    1,
  );
  await expect
    .element(view.getByLabelText("Target abundances from zero to 100 percent"))
    .toBeVisible();
});

it("provides bounded hover and keyboard tooltips at desktop and narrow widths", async () => {
  const view = await renderDemo(await fixture("nested"));
  for (const width of [1440, 390]) {
    await page.viewport(width, 1000);
    const fungi = view.getByRole("img", { name: /^Fungi · kingdom/ });
    await fungi.hover();
    const tooltip = page.getByRole("tooltip");
    await expect.element(tooltip).toBeVisible();
    await expect.element(tooltip).toMatchTextContent("31% of sample · 4 matching records");
    await expect
      .poll(() => {
        const tip = tooltip.element().getBoundingClientRect();
        const workspace = view
          .getByRole("region", { name: "Groups and subgroups", exact: true })
          .element()
          .getBoundingClientRect();
        return (
          tip.left >= Math.max(0, workspace.left) &&
          tip.right <= Math.min(width, workspace.right) + 1 &&
          tip.top >= Math.max(0, workspace.top) &&
          tip.bottom <= Math.min(1000, workspace.bottom) + 1
        );
      })
      .toBe(true);
    await userEvent.keyboard("{Escape}");
    await expect.element(tooltip).not.toBeInTheDocument();
    fungi.element().focus();
    await userEvent.tab();
    await expect
      .element(view.getByRole("img", { name: /^Saccharomycetaceae · family/ }))
      .toHaveFocus();
    await expect.element(page.getByRole("tooltip")).toBeVisible();
    await userEvent.keyboard("{Escape}");
  }
});

it("describes selected judgments and uncertainty without adding a segment", async () => {
  const view = await renderDemo(await fixture("nested"));
  await view.getByRole("button", { name: "Inspect genus-only example", exact: true }).click();
  const species = view.getByRole("img", { name: /^Saccharomyces cerevisiae · species/ });
  await expect
    .element(species)
    .toHaveAttribute("aria-label", expect.stringContaining("No match · Match support:"));
  await expect
    .element(species)
    .toHaveAttribute("aria-label", expect.stringContaining("selected record is not included"));
  await expect.element(view.getByText("Other matching records", { exact: true })).toBeVisible();
  await view.getByRole("button", { name: "Inspect unclassified example", exact: true }).click();
  const fungi = view.getByRole("img", { name: /^Fungi · kingdom/ });
  await expect
    .element(fungi)
    .toHaveAttribute("aria-label", expect.stringContaining("Uncertain · Match support:"));
  await expect
    .element(
      view.getByText(
        "There is not enough information to decide whether this record matches 10 targets. It is not included in any target total in Groups and subgroups.",
        { exact: true },
      ),
    )
    .toBeVisible();
  expect(fungi.element().querySelector('[data-record-id="r23"]')).toHaveAttribute(
    "data-contributing",
    "false",
  );
  expect(fungi.element().querySelector('[data-record-id="r23"]')).toHaveAttribute(
    "data-selected",
    "false",
  );
});
