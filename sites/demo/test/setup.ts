import { vi } from "vitest";

vi.stubGlobal("matchMedia", (media: string): MediaQueryList =>
  Object.assign(new EventTarget(), {
    media,
    matches: false,
    onchange: null,
    addListener() {},
    removeListener() {},
  }),
);
