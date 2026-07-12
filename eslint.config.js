import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";

export default tseslint.config(
    {
        ignores: [
            "dist/**",
            "coverage/**",
            "node_modules/**",
            "src-tauri/**",
            "src/types/generated/**",
            "**/*.config.{js,cjs,ts}",
        ],
    },
    js.configs.recommended,
    ...tseslint.configs.recommended,
    {
        files: ["src/**/*.{ts,tsx}"],
        languageOptions: {
            globals: {
                ...globals.browser,
            },
            // Type-aware linting for the app sources (all covered by tsconfig.json), so the
            // async-safety rules below can see promise types. Scoped to src/ only - the plain-JS
            // scripts and ignored config files are not part of a tsconfig project.
            parserOptions: {
                projectService: true,
                tsconfigRootDir: import.meta.dirname,
            },
        },
        plugins: {
            "react-hooks": reactHooks,
        },
        rules: {
            // TypeScript's compiler already reports undefined references and unused
            // locals/params (noUnusedLocals/noUnusedParameters); leave those to tsc to
            // avoid duplicate, noisier reports here.
            "no-undef": "off",
            "@typescript-eslint/no-unused-vars": "off",

            // The point of adding ESLint: enforce React's hook rules that tsc cannot see.
            "react-hooks/rules-of-hooks": "error",
            "react-hooks/exhaustive-deps": "error",

            // Catch unhandled async work. The codebase already marks fire-and-forget with a
            // `void` prefix and try/catch; these lock that discipline in so a future unawaited
            // promise (a lost error, an out-of-order write) fails lint instead of slipping by.
            // `checksVoidReturn.attributes` is off: an async React event handler (e.g.
            // `onClick={doAsync}`) is a deliberate, safe pattern here (rejections are caught by
            // the global handler), not the misuse this rule targets.
            "@typescript-eslint/no-floating-promises": "error",
            "@typescript-eslint/no-misused-promises": [
                "error",
                { checksVoidReturn: { attributes: false } },
            ],
        },
    },
    {
        // Test files run under jsdom with node-style globals and looser patterns.
        files: ["src/**/*.test.{ts,tsx}", "src/test/**/*.{ts,tsx}"],
        languageOptions: {
            globals: {
                ...globals.node,
            },
        },
        rules: {
            // Test mocks legitimately use `any`; production code has none (enforced above).
            "@typescript-eslint/no-explicit-any": "off",
        },
    },
    {
        // Release/build helper scripts: plain ESM run by Node, not the browser bundle.
        files: ["scripts/**/*.js"],
        languageOptions: {
            globals: {
                ...globals.node,
            },
        },
    }
);
