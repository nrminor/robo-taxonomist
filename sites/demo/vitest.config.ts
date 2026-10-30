import { defineConfig } from "vitest/config";
import { playwright } from "@vitest/browser-playwright";

export default defineConfig({
  envDir: false,
  oxc: { jsx: { runtime: "automatic" } },
  test: {
    allowOnly: false,
    restoreMocks: true,
    projects: [
      { test: { name: "node", environment: "node", include: ["test/**/*.test.ts"] } },
      {
        optimizeDeps: { include: ["react/jsx-dev-runtime", "effect/reactivity/AsyncResult"] },
        test: {
          name: "browser",
          include: ["test/**/*.test.tsx"],
          setupFiles: ["./test/browser-setup.ts"],
          browser: {
            enabled: true,
            headless: true,
            provider: playwright({
              contextOptions: { colorScheme: "light", reducedMotion: "reduce" },
            }),
            viewport: { width: 1440, height: 1000 },
            instances: [{ browser: "chromium" }],
          },
        },
      },
    ],
  },
});
