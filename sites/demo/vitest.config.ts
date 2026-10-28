import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
    allowOnly: false,
    environment: "node",
    restoreMocks: true,
  },
});
