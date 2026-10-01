import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.{ts,tsx}"],
    // Node by default; DOM tests opt in per file with `// @vitest-environment happy-dom`.
    environment: "node",
  },
});
