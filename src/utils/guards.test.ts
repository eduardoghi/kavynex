import { describe, expect, it } from "vitest";
import { normalizeString } from "./guards";

describe("guards", () => {
    it("normalizes strings", () => {
        expect(normalizeString("  abc  ")).toBe("abc");
        expect(normalizeString("")).toBe("");
        expect(normalizeString(null)).toBe("");
        expect(normalizeString(undefined)).toBe("");
    });

});