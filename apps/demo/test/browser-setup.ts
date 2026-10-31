import { afterEach } from "vitest";
import { cleanup } from "vitest-browser-react";
import "../src/app/globals.css";

afterEach(async () => {
  await cleanup();
  localStorage.clear();
  delete document.documentElement.dataset.theme;
});
