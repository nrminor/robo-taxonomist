import { afterEach, expect, it } from "vitest";
import { cleanup, render } from "vitest-browser-react";
import { cdp, userEvent } from "vitest/browser";
import { StrictMode } from "react";
import { Effect, Layer, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import * as Atom from "effect/reactivity/Atom";
import { RegistryProvider } from "@effect/atom-react";
import { Demo } from "../src/components/demo.tsx";
import { ClassifyRequest, PanelResponse } from "../src/lib/contract.ts";
import { type PanelId } from "../src/lib/catalog.ts";
import { classifyPanel, PanelResults } from "../src/server/panel-results.ts";
import { browserRuntime } from "../src/client/panel-atoms.ts";

const media = (value: "reduce" | "no-preference") =>
  cdp().send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value }],
  });

afterEach(async () => {
  await cleanup();
  await media("reduce");
  localStorage.clear();
});

const fixture = (panelId: PanelId) =>
  Effect.runPromise(classifyPanel(panelId).pipe(Effect.provide(PanelResults.layer)));
const wire = (response: PanelResponse) =>
  Schema.encodeSync(Schema.toCodecJson(PanelResponse))(response);
const renderDemo = async () => {
  await media("no-preference");
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = Schema.decodeUnknownSync(ClassifyRequest)(
      await new Request(input, init).json(),
    );
    return Response.json(wire(await fixture(request.panelId)));
  };
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
  await expect.element(view.getByRole("region", { name: "Panel targets" })).toBeVisible();
  return view;
};

it("moves a retained target 108px without record selection resetting its native transition", async () => {
  const view = await renderDemo();
  const target = view.getByRole("img", { name: /^Acetobacteraceae · family/ });
  await expect.element(target).toBeVisible();
  const original = target.element();
  const top = original.getBoundingClientRect().top;
  await view.getByRole("radio", { name: "Families, genera and species", exact: true }).click();
  await expect.poll(() => original.getAnimations().length).toBeGreaterThan(0);
  const animations = original.getAnimations();
  for (const animation of animations) {
    expect(animation.effect?.getTiming().duration).toBe(200);
    animation.pause();
    animation.currentTime = 100;
  }
  const middle = original.getBoundingClientRect().top;
  expect(middle).toBeGreaterThan(top);
  expect(middle).toBeLessThan(top + 108);
  const transform = getComputedStyle(original).transform;
  const segment = original.querySelector('[data-record-id="r02"]');
  await view.getByRole("button", { name: /^Kluyveromyces lactis, / }).click();
  expect(original.getAnimations()).toEqual(animations);
  expect(getComputedStyle(original).transform).toBe(transform);
  expect(original.querySelector('[data-record-id="r02"]')).toBe(segment);
  const selected = view
    .getByRole("img", { name: /^Kluyveromyces lactis · species/ })
    .element()
    .querySelector('[data-record-id="r02"]');
  if (selected === null) throw new Error("Selected segment missing");
  expect(getComputedStyle(selected).backgroundColor).toBe("rgb(8, 126, 121)");
  await view.getByRole("button", { name: "Inspect species example", exact: true }).click();
  expect(original.getAnimations()).toEqual(animations);
  expect(getComputedStyle(original).transform).toBe(transform);
  expect(getComputedStyle(selected).backgroundColor).toBe("rgb(37, 99, 235)");
  for (const animation of animations) animation.play();
  await Promise.all(animations.map((animation) => animation.finished.catch(() => undefined)));
  expect(target.element()).toBe(original);
  expect(original.getBoundingClientRect().top - top).toBeCloseTo(108, 1);
});

it("enters at its fresh position and reclaims an exiting row without resetting its opacity", async () => {
  const view = await renderDemo();
  const fungi = view.getByRole("img", { name: /^Fungi · kingdom/ });
  await expect.element(fungi).toBeVisible();
  const original = fungi.element();
  const top = original.getBoundingClientRect().top;
  await view.getByRole("button", { name: /^Kluyveromyces lactis, / }).click();
  await view.getByRole("radio", { name: "Families, genera and species", exact: true }).click();
  await expect.poll(() => original.getAnimations().length).toBeGreaterThan(0);
  const exit = original.getAnimations({ subtree: true });
  for (const animation of exit) {
    expect(animation.effect?.getTiming().duration).toBe(160);
    animation.pause();
    animation.currentTime = 40;
  }
  const opacity = Number(getComputedStyle(original).opacity);
  expect(opacity).toBeGreaterThan(0);
  expect(opacity).toBeLessThan(1);
  expect(original).toHaveAttribute("inert");
  expect(original).toHaveAttribute("aria-hidden", "true");
  expect(original).toHaveAttribute("tabindex", "-1");
  expect(original).toHaveAttribute(
    "aria-label",
    expect.stringContaining("Matches · Match support:"),
  );
  const entry = view.getByRole("img", { name: /^Kluyveromyces lactis · species/ }).element();
  const entrance = entry.getAnimations({ subtree: true });
  expect(entrance.length).toBeGreaterThan(0);
  for (const animation of entrance) {
    expect(animation.effect?.getTiming().duration).toBe(200);
    animation.pause();
    animation.currentTime = 0;
  }
  expect(entry.getBoundingClientRect().top - top).toBeCloseTo(54, 1);
  const appearance = entry.firstElementChild;
  if (appearance === null) throw new Error("Entry appearance missing");
  expect(appearance.getBoundingClientRect().top - entry.getBoundingClientRect().top).toBeCloseTo(
    4,
    1,
  );
  for (const animation of entrance) animation.play();
  await Promise.all(entrance.map((animation) => animation.finished.catch(() => undefined)));
  expect(original.getAnimations({ subtree: true })).toEqual(exit);
  expect(Number(getComputedStyle(original).opacity)).toBe(opacity);
  expect(original).toHaveAttribute("inert");
  await view.getByRole("radio", { name: "Broad groups", exact: true }).click();
  await expect.element(fungi).toBeVisible();
  expect(fungi.element()).toBe(original);
  expect(Number(getComputedStyle(original).opacity)).toBeGreaterThanOrEqual(opacity);
  expect(original).not.toHaveAttribute("inert");
  const resumed = original.getAnimations({ subtree: true });
  for (const animation of resumed) animation.play();
  await Promise.all(resumed.map((animation) => animation.finished.catch(() => undefined)));
  expect(getComputedStyle(original).opacity).toBe("1");
  expect(original.getBoundingClientRect().top).toBeCloseTo(top, 1);
  await expect.element(entry).not.toBeVisible();
  expect(entry).toHaveAttribute("inert");
});

it("changes panels instantly for keyboard navigation and reduced-motion pointers", async () => {
  const view = await renderDemo();
  const fungi = view.getByRole("img", { name: /^Fungi · kingdom/ });
  await expect.element(fungi).toBeVisible();
  const original = fungi.element();
  const chart = view.getByRole("figure", { name: "Count abundance for each target" }).element();
  view.getByRole("radio", { name: "Broad groups", exact: true }).element().focus();
  await userEvent.keyboard("{ArrowRight}");
  await expect
    .element(view.getByRole("radio", { name: "Families, genera and species", exact: true }))
    .toBeChecked();
  await expect.element(original).not.toBeVisible();
  await expect.poll(() => chart.getAnimations({ subtree: true }).length).toBe(0);
  await media("reduce");
  await view.getByRole("radio", { name: "Broad groups", exact: true }).click();
  await expect.element(fungi).toBeVisible();
  expect(chart.getAnimations({ subtree: true })).toHaveLength(0);
  await media("no-preference");
  await view.getByRole("radio", { name: "Families, genera and species", exact: true }).click();
  await expect.poll(() => original.getAnimations().length).toBeGreaterThan(0);
  for (const animation of chart.getAnimations({ subtree: true })) animation.pause();
  await media("reduce");
  await expect.element(original).not.toBeVisible();
  await expect.poll(() => chart.getAnimations({ subtree: true }).length).toBe(0);
});

it("places a previously unpainted exit at its fresh slot when it returns in another panel", async () => {
  const view = await renderDemo();
  const top = view
    .getByRole("img", { name: /^Fungi · kingdom/ })
    .element()
    .getBoundingClientRect().top;
  await view.getByRole("radio", { name: "Families, genera and species", exact: true }).click();
  const genus = view.getByRole("img", { name: /^Saccharomyces · genus/ });
  await expect.element(genus).toBeVisible();
  const row = genus.element();
  for (const animation of row.getAnimations({ subtree: true })) {
    animation.pause();
    animation.currentTime = 0;
  }
  expect(getComputedStyle(row).opacity).toBe("0");
  await view.getByRole("radio", { name: "Broad groups", exact: true }).click();
  await expect.element(row).toHaveAttribute("aria-hidden", "true");
  await Promise.all(
    row
      .getAnimations({ subtree: true })
      .map((animation) => animation.finished.catch(() => undefined)),
  );
  await expect.poll(() => getComputedStyle(row).visibility).toBe("hidden");
  await view.getByRole("radio", { name: "Groups and subgroups", exact: true }).click();
  await expect.element(genus).toBeVisible();
  for (const animation of row.getAnimations({ subtree: true })) {
    animation.pause();
    animation.currentTime = 0;
  }
  expect(row.getBoundingClientRect().top - top).toBeCloseTo(108, 1);
});
