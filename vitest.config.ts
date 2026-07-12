import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { defineConfig } from "vitest/config";

const rootDir = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
    root: rootDir,
    test: {
        environment: "jsdom",
        globals: true,
        setupFiles: [resolve(rootDir, "src/test/setup.ts")],
        clearMocks: true,
        restoreMocks: true,
        coverage: {
            provider: "v8",
            reporter: ["text", "html"],
            reportsDirectory: resolve(rootDir, "coverage"),
            // Enforced only when coverage runs (pnpm test:coverage / CI), so the plain
            // `pnpm test` loop stays fast. These floors sit well below the current numbers
            // on purpose: they catch a large coverage regression without making routine
            // changes brittle. Mutation testing (pnpm test:mutation) remains the
            // higher-signal quality gate; this is a coarse backstop, not a substitute.
            thresholds: {
                statements: 80,
                branches: 72,
                functions: 75,
                lines: 80,
                // The pure-logic layers carry the most business rules, so hold them higher.
                "src/utils/**": {
                    statements: 90,
                    branches: 88,
                    functions: 90,
                    lines: 90,
                },
                "src/services/**": {
                    statements: 75,
                    branches: 70,
                    functions: 72,
                    lines: 75,
                },
            },
        },
    },
});