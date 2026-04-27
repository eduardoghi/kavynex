import { describe, expect, it } from "vitest";
import { assertNonEmptyString, isNonEmptyString, normalizeString } from "./guards";

describe("guards", () => {
    it("normalizes strings", () => {
        expect(normalizeString("  abc  ")).toBe("abc");
        expect(normalizeString("")).toBe("");
        expect(normalizeString(null)).toBe("");
        expect(normalizeString(undefined)).toBe("");
    });

    it("checks non-empty string", () => {
        expect(isNonEmptyString("abc")).toBe(true);
        expect(isNonEmptyString("   ")).toBe(false);
        expect(isNonEmptyString(null)).toBe(false);
    });

    it("asserts non-empty string", () => {
        expect(assertNonEmptyString("  abc  ", "invalid")).toBe("abc");
    });

    it("throws when asserting empty string", () => {
        expect(() => assertNonEmptyString("   ", "invalid")).toThrow("invalid");
    });
});