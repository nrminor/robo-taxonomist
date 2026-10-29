import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { StrictMode } from "react";
import { renderToString } from "react-dom/server";
import { hydrateRoot } from "react-dom/client";
import { ThemeControl } from "../src/components/theme-control.tsx";
import RootLayout from "../src/app/layout.tsx";

let media: MediaQueryList;
let changes: EventTarget;

beforeEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset.theme;
  changes = new EventTarget();
  media = {
    matches: false,
    media: "(prefers-color-scheme: dark)",
    onchange: null,
    addEventListener: changes.addEventListener.bind(changes),
    removeEventListener: changes.removeEventListener.bind(changes),
    dispatchEvent: changes.dispatchEvent.bind(changes),
    addListener() {},
    removeListener() {},
  };
  vi.stubGlobal("matchMedia", () => media);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete document.documentElement.dataset.theme;
});

function changeSystem(dark: boolean) {
  Object.defineProperty(media, "matches", { value: dark, configurable: true });
  act(() => {
    changes.dispatchEvent(new Event("change"));
  });
}

const themes = [
  { stored: null, systemDark: false, theme: "light", action: "Switch to dark mode" },
  { stored: null, systemDark: true, theme: "dark", action: "Switch to light mode" },
  { stored: "light", systemDark: true, theme: "light", action: "Switch to dark mode" },
  { stored: "dark", systemDark: false, theme: "dark", action: "Switch to light mode" },
  { stored: "invalid", systemDark: true, theme: "dark", action: "Switch to light mode" },
] satisfies ReadonlyArray<{
  stored: string | null;
  systemDark: boolean;
  theme: "light" | "dark";
  action: string;
}>;

it.each(themes)(
  "resolves stored=$stored, systemDark=$systemDark to $theme",
  ({ stored, systemDark, theme, action }) => {
    if (stored !== null) localStorage.setItem("taxonomy-theme", stored);
    Object.defineProperty(media, "matches", { value: systemDark, configurable: true });
    render(<ThemeControl />);
    expect(document.documentElement.dataset.theme).toBe(theme);
    const button = screen.getByRole("button", { name: action });
    expect(button.title).toBe(button.getAttribute("aria-label"));
    expect(localStorage.getItem("taxonomy-theme")).toBe(stored);
  },
);

it("persists toggles across a reload mount, overriding the system", () => {
  const first = render(<ThemeControl />);
  fireEvent.click(screen.getByRole("button", { name: "Switch to dark mode" }));
  expect(document.documentElement.dataset.theme).toBe("dark");
  expect(localStorage.getItem("taxonomy-theme")).toBe("dark");
  first.unmount();
  delete document.documentElement.dataset.theme;
  render(<ThemeControl />);
  expect(document.documentElement.dataset.theme).toBe("dark");
  fireEvent.click(screen.getByRole("button", { name: "Switch to light mode" }));
  expect(document.documentElement.dataset.theme).toBe("light");
  expect(localStorage.getItem("taxonomy-theme")).toBe("light");
});

it("follows live system changes only until an explicit choice", () => {
  const mounted = render(
    <StrictMode>
      <ThemeControl />
    </StrictMode>,
  );
  changeSystem(true);
  expect(document.documentElement.dataset.theme).toBe("dark");
  expect(screen.getByRole("button", { name: "Switch to light mode" })).toBeDefined();
  changeSystem(false);
  expect(document.documentElement.dataset.theme).toBe("light");
  fireEvent.click(screen.getByRole("button", { name: "Switch to dark mode" }));
  changeSystem(true);
  changeSystem(false);
  expect(document.documentElement.dataset.theme).toBe("dark");
  mounted.unmount();
});

it("stops following system changes after unmount in Strict Mode", () => {
  const mounted = render(
    <StrictMode>
      <ThemeControl />
    </StrictMode>,
  );
  expect(document.documentElement.dataset.theme).toBe("light");
  mounted.unmount();
  changeSystem(true);
  expect(document.documentElement.dataset.theme).toBe("light");
});

it("ignores system changes for an already persisted light choice", () => {
  localStorage.setItem("taxonomy-theme", "light");
  render(<ThemeControl />);
  changeSystem(true);
  expect(document.documentElement.dataset.theme).toBe("light");
});

it("keeps working when storage reads and writes throw", () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("blocked");
  });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("blocked");
  });
  render(<ThemeControl />);
  changeSystem(true);
  expect(document.documentElement.dataset.theme).toBe("dark");
  fireEvent.click(screen.getByRole("button", { name: "Switch to light mode" }));
  changeSystem(false);
  changeSystem(true);
  expect(document.documentElement.dataset.theme).toBe("light");
  expect(screen.getByRole("button", { name: "Switch to dark mode" })).toBeDefined();
});

it.each(themes)(
  "selects $theme before hydration for stored=$stored, systemDark=$systemDark",
  ({ stored, systemDark, theme }) => {
    if (stored !== null) localStorage.setItem("taxonomy-theme", stored);
    Object.defineProperty(media, "matches", { value: systemDark, configurable: true });
    const html = renderToString(
      <RootLayout>
        <ThemeControl />
      </RootLayout>,
    );
    const parsed = new DOMParser().parseFromString(html, "text/html");
    const scripts = parsed.head.querySelectorAll("script");
    expect(scripts).toHaveLength(1);
    const script = scripts.item(0);
    if (script === null) throw new Error("Root layout did not render theme initialization");
    window.eval(script.textContent);
    expect(document.documentElement.dataset.theme).toBe(theme);
  },
);

it.each([false, true])("initializes the head from system dark=%s with blocked storage", (dark) => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("blocked");
  });
  Object.defineProperty(media, "matches", { value: dark, configurable: true });
  const html = renderToString(
    <RootLayout>
      <ThemeControl />
    </RootLayout>,
  );
  const parsed = new DOMParser().parseFromString(html, "text/html");
  const scripts = parsed.head.querySelectorAll("script");
  expect(scripts).toHaveLength(1);
  const script = scripts.item(0);
  if (script === null) throw new Error("Root layout did not render theme initialization");
  window.eval(script.textContent);
  expect(document.documentElement.dataset.theme).toBe(dark ? "dark" : "light");
});

it("hydrates the control without a mismatch when the head has selected dark", async () => {
  localStorage.setItem("taxonomy-theme", "dark");
  document.documentElement.dataset.theme = "dark";
  const container = document.createElement("div");
  container.innerHTML = renderToString(<ThemeControl />);
  document.body.append(container);
  const recover = vi.fn();
  const root = await act(async () =>
    hydrateRoot(container, <ThemeControl />, { onRecoverableError: recover }),
  );
  expect(recover).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Switch to light mode" })).toBeDefined();
  act(() => root.unmount());
  container.remove();
});
