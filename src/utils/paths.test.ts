import { describe, expect, it } from "vitest";
import { normalizeNonEmptyUniquePaths } from "./paths";

describe("normalizeNonEmptyUniquePaths", () => {
    it("trims values and drops empty/whitespace-only ones", () => {
        expect(normalizeNonEmptyUniquePaths([" a ", "", "  ", "b"])).toEqual(["a", "b"]);
    });

    it("drops null and undefined", () => {
        expect(normalizeNonEmptyUniquePaths(["a", null, undefined, "b"])).toEqual(["a", "b"]);
    });

    it("de-duplicates while preserving first-seen order", () => {
        expect(normalizeNonEmptyUniquePaths(["b", "a", " b ", "a"])).toEqual(["b", "a"]);
    });

    it("returns an empty array for no usable values", () => {
        expect(normalizeNonEmptyUniquePaths([null, "", "   ", undefined])).toEqual([]);
    });
});
