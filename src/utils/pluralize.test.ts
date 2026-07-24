import { describe, expect, it } from "vitest";
import { formatCount } from "./pluralize";

describe("formatCount", () => {
    it("keeps the singular noun for a count of one", () => {
        expect(formatCount(1, "item")).toBe("1 item");
    });

    it("adds a trailing s for zero and for more than one", () => {
        expect(formatCount(0, "item")).toBe("0 items");
        expect(formatCount(2, "item")).toBe("2 items");
    });

    it("uses an explicit irregular plural when provided", () => {
        expect(formatCount(1, "entry", "entries")).toBe("1 entry");
        expect(formatCount(3, "entry", "entries")).toBe("3 entries");
    });
});
