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
        },
    },
});