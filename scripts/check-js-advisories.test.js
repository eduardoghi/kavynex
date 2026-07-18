import { describe, expect, it } from "vitest";
import {
    chunk,
    collectPackages,
    isBlockingAdvisory,
    severityOf,
} from "./check-js-advisories.js";

// This gate has no real advisory input on a normal day (the production tree is clean), so - exactly
// as with check-js-licenses.js - these tests are what exercise the severity/withdrawn decision and
// the inventory/pagination plumbing before the day a finding actually lands, which is the moment a
// bug here would either let a high/critical advisory ship or block CI on nothing.

describe("collectPackages", () => {
    it("flattens pnpm's by-license shape into name@version records", () => {
        const byLicense = {
            MIT: [{ name: "a", versions: ["1.0.0"] }],
            "Apache-2.0": [{ name: "b", versions: ["2.0.0", "2.1.0"] }],
        };

        expect(collectPackages(byLicense)).toEqual([
            { name: "a", version: "1.0.0" },
            { name: "b", version: "2.0.0" },
            { name: "b", version: "2.1.0" },
        ]);
    });

    it("de-duplicates a package that appears under more than one license group", () => {
        // pnpm can list the same name@version twice (different resolved licenses across the tree);
        // scanning it once is enough and keeps the batch queries minimal.
        const byLicense = {
            MIT: [{ name: "a", versions: ["1.0.0"] }],
            ISC: [{ name: "a", versions: ["1.0.0"] }],
        };

        expect(collectPackages(byLicense)).toEqual([{ name: "a", version: "1.0.0" }]);
    });

    it("tolerates an entry with no versions array", () => {
        expect(collectPackages({ MIT: [{ name: "a" }] })).toEqual([]);
    });

    it("returns nothing for an empty inventory", () => {
        expect(collectPackages({})).toEqual([]);
    });
});

describe("chunk", () => {
    it("splits into batches of at most the given size", () => {
        expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    });

    it("returns a single batch when everything fits", () => {
        expect(chunk([1, 2], 100)).toEqual([[1, 2]]);
    });

    it("covers every item exactly once across the batches", () => {
        const items = Array.from({ length: 250 }, (_, index) => index);
        const batches = chunk(items, 100);

        expect(batches).toHaveLength(3);
        expect(batches.flat()).toEqual(items);
    });

    it("returns no batches for an empty list", () => {
        expect(chunk([], 100)).toEqual([]);
    });
});

describe("severityOf", () => {
    it("upper-cases a declared severity string", () => {
        expect(severityOf({ database_specific: { severity: "high" } })).toBe("HIGH");
        expect(severityOf({ database_specific: { severity: "Critical" } })).toBe("CRITICAL");
    });

    it("reports UNKNOWN when severity is absent or not a string", () => {
        expect(severityOf({})).toBe("UNKNOWN");
        expect(severityOf({ database_specific: {} })).toBe("UNKNOWN");
        expect(severityOf({ database_specific: { severity: 3 } })).toBe("UNKNOWN");
    });
});

describe("isBlockingAdvisory", () => {
    it("blocks a high or critical advisory", () => {
        expect(isBlockingAdvisory({ database_specific: { severity: "HIGH" } })).toBe(true);
        expect(isBlockingAdvisory({ database_specific: { severity: "critical" } })).toBe(true);
    });

    it("does not block a lower or unknown severity", () => {
        expect(isBlockingAdvisory({ database_specific: { severity: "MODERATE" } })).toBe(false);
        expect(isBlockingAdvisory({ database_specific: { severity: "LOW" } })).toBe(false);
        expect(isBlockingAdvisory({})).toBe(false);
    });

    it("never blocks a withdrawn advisory, even a critical one", () => {
        // A withdrawn advisory was retracted by its publisher; it must not gate a release.
        expect(
            isBlockingAdvisory({
                withdrawn: "2026-01-01T00:00:00Z",
                database_specific: { severity: "CRITICAL" },
            })
        ).toBe(false);
    });
});
