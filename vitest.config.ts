import { defineConfig } from "vitest/config";

// Thresholds are a ratchet: raise them as coverage improves, never lower them
// just to turn a red build green. See BLA-159 for the module priority order.
export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "html"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.d.ts", "src/manifest.ts", "src/index.ts"],
      thresholds: {
        statements: 65,
        branches: 75,
        functions: 83,
        lines: 65,
        "src/worker.ts": { statements: 30, branches: 74, functions: 48, lines: 30 },
        "src/acp-bridge.ts": { statements: 70, branches: 79, functions: 83, lines: 70 },
        "src/adapter.ts": { statements: 100, branches: 85, functions: 100, lines: 100 },
      },
    },
  },
});
