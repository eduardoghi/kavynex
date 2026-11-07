import { describe, expect, it } from "vitest";
import { formatNumber } from "./number-format";

describe("formatNumber", () => {
    it("groups thousands the English way whatever the system's language", () => {
        expect(formatNumber(1204)).toBe("1,204");
        expect(formatNumber(1234567)).toBe("1,234,567");
        expect(formatNumber(12)).toBe("12");
    });
});
