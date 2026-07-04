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
            "scripts/**",
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
    }
);
