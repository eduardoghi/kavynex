import { describe, expect, it } from "vitest";
import { isAllowed } from "./check-js-licenses.js";

// The gate has no real compound-expression input today (94 production packages, 7 distinct
// licenses, all single permissive names), so these tests are what exercise the AND/OR/paren
// branches before a dependency ever ships such an expression - the moment a bug here would either
// let a copyleft license through or block CI on a fine package.
describe("isAllowed", () => {
    it("accepts a single permissive license", () => {
        expect(isAllowed("MIT")).toBe(true);
        expect(isAllowed("Apache-2.0")).toBe(true);
        expect(isAllowed("CC0-1.0")).toBe(true);
    });

    it("rejects a single disallowed license", () => {
        expect(isAllowed("GPL-3.0")).toBe(false);
        expect(isAllowed("LGPL-3.0")).toBe(false);
        expect(isAllowed("Nonexistent-1.0")).toBe(false);
    });

    it("accepts an OR expression when at least one side is allowed", () => {
        // A dual license lets us take the permissive side.
        expect(isAllowed("MIT OR Apache-2.0")).toBe(true);
        expect(isAllowed("GPL-3.0 OR MIT")).toBe(true);
    });

    it("rejects an OR expression when no side is allowed", () => {
        expect(isAllowed("GPL-3.0 OR LGPL-3.0")).toBe(false);
    });

    it("accepts an AND expression only when every term is allowed", () => {
        expect(isAllowed("MIT AND Apache-2.0")).toBe(true);
    });

    it("rejects an AND expression if any term is disallowed", () => {
        // Every AND term binds, so one copyleft term poisons the whole expression.
        expect(isAllowed("GPL-3.0 AND MIT")).toBe(false);
        expect(isAllowed("MIT AND GPL-3.0")).toBe(false);
    });

    it("strips surrounding parentheses", () => {
        expect(isAllowed("(MIT OR CC0-1.0)")).toBe(true);
        expect(isAllowed("(MIT)")).toBe(true);
        expect(isAllowed("(GPL-3.0)")).toBe(false);
    });

    it("tolerates surrounding and inter-term whitespace", () => {
        expect(isAllowed("  MIT  ")).toBe(true);
        // Each split term is trimmed before the lookup, so extra spacing around OR is harmless.
        expect(isAllowed("MIT   OR   Apache-2.0")).toBe(true);
    });
});
