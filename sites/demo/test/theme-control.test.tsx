import { afterEach, expect, it } from "vitest";
import { cdp } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";
import { renderToString } from "react-dom/server";
import { RegistryProvider } from "@effect/atom-react";
import { ThemeProvider } from "next-themes";
import { Effect, Result, Schema } from "effect";
import { Demo } from "../src/components/demo.tsx";
import RootLayout from "../src/app/layout.tsx";
import globalStyles from "../src/app/globals.css?inline";
import { ClassificationReply } from "../src/lib/contract.ts";
import { classifyPanel, PanelResults } from "../src/server/panel-results.ts";
import type {} from "@vitest/browser-playwright";

const systemTheme = (theme: "light" | "dark") =>
  cdp().send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-color-scheme", value: theme }],
  });

const renderDemo = async () => {
  const response = await Effect.runPromise(
    classifyPanel("broad").pipe(Effect.provide(PanelResults.layer)),
  );
  return render(
    <ThemeProvider attribute="data-theme" storageKey="taxonomy-theme" defaultTheme="system">
      <RegistryProvider>
        <Demo
          initial={Promise.resolve(
            Schema.encodeSync(ClassificationReply)(Result.succeed(response)),
          )}
        />
      </RegistryProvider>
    </ThemeProvider>,
  );
};

afterEach(async () => {
  await cleanup();
  await systemTheme("light");
});

it.each([
  { system: "light", action: "Switch to dark mode", background: "rgb(255, 255, 255)" },
  { system: "dark", action: "Switch to light mode", background: "rgb(23, 27, 32)" },
] satisfies ReadonlyArray<{ system: "light" | "dark"; action: string; background: string }>)(
  "follows the browser's $system preference without saving an explicit choice",
  async ({ system, action, background }) => {
    await systemTheme(system);
    const view = await renderDemo();
    await expect.element(view.getByRole("button", { name: action })).toBeVisible();
    expect(getComputedStyle(document.body).backgroundColor).toBe(background);
    expect(localStorage.getItem("taxonomy-theme")).toBeNull();
  },
);

it("retains an explicit theme across remounts despite a different system preference", async () => {
  const view = await renderDemo();
  await view.getByRole("button", { name: "Switch to dark mode" }).click();
  expect(localStorage.getItem("taxonomy-theme")).toBe("dark");
  await view.unmount();
  await systemTheme("light");
  const remounted = await renderDemo();
  await expect
    .element(remounted.getByRole("button", { name: "Switch to light mode" }))
    .toBeVisible();
  await remounted.getByRole("button", { name: "Switch to light mode" }).click();
  expect(localStorage.getItem("taxonomy-theme")).toBe("light");
});

it.each([
  { system: "light", action: "Switch to dark mode", next: "dark" },
  { system: "dark", action: "Switch to light mode", next: "light" },
] satisfies ReadonlyArray<{ system: "light" | "dark"; action: string; next: string }>)(
  "toggles from the rendered $system fallback when the stored preference is invalid",
  async ({ system, action, next }) => {
    await systemTheme(system);
    localStorage.setItem("taxonomy-theme", "invalid");
    const view = await renderDemo();
    await view.getByRole("button", { name: action }).click();
    expect(localStorage.getItem("taxonomy-theme")).toBe(next);
    await expect
      .poll(() => getComputedStyle(document.body).backgroundColor)
      .toBe(next === "dark" ? "rgb(23, 27, 32)" : "rgb(255, 255, 255)");
  },
);

it("follows live system changes only until the user chooses a theme", async () => {
  const view = await renderDemo();
  await systemTheme("dark");
  await expect.element(view.getByRole("button", { name: "Switch to light mode" })).toBeVisible();
  await view.getByRole("button", { name: "Switch to light mode" }).click();
  await systemTheme("light");
  await systemTheme("dark");
  expect(matchMedia("(prefers-color-scheme: dark)").matches).toBe(true);
  await expect.element(view.getByRole("button", { name: "Switch to dark mode" })).toBeVisible();
});

it("removes the system-theme subscription when the demo unmounts", async () => {
  const view = await renderDemo();
  await view.unmount();
  await systemTheme("dark");
  expect(document.documentElement.dataset.theme).toBe("light");
});

it.each([
  { system: "light", stored: "dark", expected: "dark" },
  { system: "dark", stored: "light", expected: "light" },
  { system: "dark", stored: "invalid", expected: "dark" },
  { system: "light", stored: "invalid", expected: "light" },
  { system: "dark", stored: null, expected: "dark" },
  { system: "light", stored: null, expected: "light" },
] satisfies ReadonlyArray<{
  system: "light" | "dark";
  stored: string | null;
  expected: "light" | "dark";
}>)(
  "renders the document theme before hydration: system=$system, stored=$stored",
  async ({ system, stored, expected }) => {
    await systemTheme(system);
    if (stored === null) localStorage.removeItem("taxonomy-theme");
    else localStorage.setItem("taxonomy-theme", stored);
    const html = renderToString(
      <RootLayout>
        <style>{globalStyles}</style>
        <p>Document theme</p>
      </RootLayout>,
    );
    const view = await render(<iframe title="Theme initialization" srcDoc={html} />);
    const frame = view.getByTitle("Theme initialization").element();
    if (!(frame instanceof HTMLIFrameElement)) throw new Error("Expected the theme document frame");
    await expect.poll(() => frame.contentDocument?.body.textContent).toContain("Document theme");
    if (stored === "light" || stored === "dark") {
      await expect.poll(() => frame.contentDocument?.documentElement.dataset.theme).toBe(stored);
    }
    await expect
      .poll(() => {
        const body = frame.contentDocument?.body;
        return body ? getComputedStyle(body).backgroundColor : undefined;
      })
      .toBe(expected === "dark" ? "rgb(23, 27, 32)" : "rgb(255, 255, 255)");
  },
);
