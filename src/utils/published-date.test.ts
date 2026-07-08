import { describe, expect, it } from "vitest";
import {
    applyPublishedAtMask,
    displayDateToIso,
    formatPublishedAtForDisplay,
} from "./published-date";

describe("formatPublishedAtForDisplay", () => {
    it("turns an ISO date into dd/mm/yyyy", () => {
        expect(formatPublishedAtForDisplay("2026-03-31")).toBe("31/03/2026");
    });

    it("returns an empty string for blank input", () => {
        expect(formatPublishedAtForDisplay("")).toBe("");
        expect(formatPublishedAtForDisplay("   ")).toBe("");
    });

    it("passes through a value that is not an ISO date", () => {
        expect(formatPublishedAtForDisplay("31/03/2026")).toBe("31/03/2026");
    });
});

describe("applyPublishedAtMask", () => {
    it("masks digits progressively as dd, dd/mm, dd/mm/yyyy", () => {
        expect(applyPublishedAtMask("3")).toBe("3");
        expect(applyPublishedAtMask("31")).toBe("31");
        expect(applyPublishedAtMask("310")).toBe("31/0");
        expect(applyPublishedAtMask("3103")).toBe("31/03");
        expect(applyPublishedAtMask("31032026")).toBe("31/03/2026");
    });

    it("ignores non-digits and caps at 8 digits", () => {
        expect(applyPublishedAtMask("31/03/2026")).toBe("31/03/2026");
        expect(applyPublishedAtMask("310320269999")).toBe("31/03/2026");
    });
});

describe("displayDateToIso", () => {
    it("converts a complete valid date to ISO", () => {
        expect(displayDateToIso("31/03/2026")).toBe("2026-03-31");
    });

    it("returns an empty string for an incomplete date (e.g. mid-edit)", () => {
        expect(displayDateToIso("31/03/202")).toBe("");
        expect(displayDateToIso("31/03")).toBe("");
        expect(displayDateToIso("")).toBe("");
    });

    it("rejects impossible calendar dates", () => {
        expect(displayDateToIso("31/02/2026")).toBe("");
        expect(displayDateToIso("00/03/2026")).toBe("");
        expect(displayDateToIso("31/13/2026")).toBe("");
    });
});
