import { describe, expect, it } from "vitest";
import { assertValidEntityId, isValidEntityId } from "./id-validation";

describe("isValidEntityId", () => {
    it("accepts positive integers", () => {
        expect(isValidEntityId(1)).toBe(true);
        expect(isValidEntityId(42)).toBe(true);
    });

    it("rejects zero, negatives, fractions and non-finite values", () => {
        expect(isValidEntityId(0)).toBe(false);
        expect(isValidEntityId(-3)).toBe(false);
        expect(isValidEntityId(1.5)).toBe(false);
        expect(isValidEntityId(Number.NaN)).toBe(false);
        expect(isValidEntityId(Number.POSITIVE_INFINITY)).toBe(false);
    });
});

describe("assertValidEntityId", () => {
    it("throws for negatives, fractions and zero", () => {
        expect(() => assertValidEntityId(-3, "CODE", "bad")).toThrow();
        expect(() => assertValidEntityId(1.5, "CODE", "bad")).toThrow();
        expect(() => assertValidEntityId(0, "CODE", "bad")).toThrow();
    });

    it("does not throw for a positive integer", () => {
        expect(() => assertValidEntityId(7, "CODE", "bad")).not.toThrow();
    });
});
