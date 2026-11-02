import { defineConfig } from "vitest/config";

export default defineConfig({
  envDir: false,
  test: {
    include: ["test/**/*.test.ts"],
    allowOnly: false,
  },
});
