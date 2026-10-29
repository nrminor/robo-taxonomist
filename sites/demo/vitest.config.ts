import { defineConfig } from "vitest/config";

export default defineConfig({
  oxc: { jsx: { runtime: "automatic" } },
  test: {
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
    allowOnly: false,
    environment: "jsdom",
    setupFiles: ["./test/setup.ts"],
    restoreMocks: true,
  },
});
