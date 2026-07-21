import { describe, expect, it } from "vitest";
import {
    chunk,
    collectPackages,
    cvss3BaseScore,
    isBlockingAdvisory,
    severityFromCvssScore,
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

// A network-worst-case RCE vector, whose CVSS 3.1 base score is a documented 9.8 (CRITICAL). Used
// to pin the calculator against a known value rather than trusting the formula transcription.
const RCE_VECTOR = "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H";

describe("cvss3BaseScore", () => {
    it("computes the documented base score for a known vector", () => {
        expect(cvss3BaseScore(RCE_VECTOR)).toBe(9.8);
        // A scope-changed, lower-impact vector (CVSS 3.0 spelling) still parses.
        expect(cvss3BaseScore("CVSS:3.0/AV:N/AC:H/PR:L/UI:R/S:C/C:L/I:L/A:N")).toBeGreaterThan(0);
    });

    it("returns null for anything that is not a CVSS 3.x base vector", () => {
        // A v2 vector, a (future) v4 vector, a vector missing a required metric, an unknown metric
        // value, and non-strings all yield null so the caller fails closed rather than guessing.
        expect(cvss3BaseScore("AV:N/AC:L/Au:N/C:P/I:P/A:P")).toBeNull();
        expect(cvss3BaseScore("CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H")).toBeNull();
        expect(cvss3BaseScore("CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H")).toBeNull();
        expect(cvss3BaseScore("CVSS:3.1/AV:X/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H")).toBeNull();
        expect(cvss3BaseScore("")).toBeNull();
        expect(cvss3BaseScore(undefined)).toBeNull();
    });
});

describe("severityFromCvssScore", () => {
    it("maps a score to its GHSA/OSV band at the boundaries", () => {
        expect(severityFromCvssScore(9.0)).toBe("CRITICAL");
        expect(severityFromCvssScore(8.9)).toBe("HIGH");
        expect(severityFromCvssScore(7.0)).toBe("HIGH");
        expect(severityFromCvssScore(6.9)).toBe("MODERATE");
        expect(severityFromCvssScore(4.0)).toBe("MODERATE");
        expect(severityFromCvssScore(3.9)).toBe("LOW");
        expect(severityFromCvssScore(0)).toBe("NONE");
    });
});

describe("severityOf", () => {
    it("upper-cases a declared severity string", () => {
        expect(severityOf({ database_specific: { severity: "high" } })).toBe("HIGH");
        expect(severityOf({ database_specific: { severity: "Critical" } })).toBe("CRITICAL");
    });

    it("falls back to the top-level CVSS vector when there is no declared severity", () => {
        // The exact gap this closes: an advisory carrying its severity only as a CVSS vector in the
        // top-level `severity` array, with no database_specific.severity, must still be classified
        // rather than read as UNKNOWN.
        expect(
            severityOf({
                severity: [{ type: "CVSS_V3", score: RCE_VECTOR }],
            })
        ).toBe("CRITICAL");
    });

    it("reports UNKNOWN only when neither a label nor a parseable CVSS vector is present", () => {
        expect(severityOf({})).toBe("UNKNOWN");
        expect(severityOf({ database_specific: {} })).toBe("UNKNOWN");
        expect(severityOf({ database_specific: { severity: 3 } })).toBe("UNKNOWN");
        expect(severityOf({ severity: [{ type: "CVSS_V2", score: "AV:N/AC:L/Au:N/C:P/I:P/A:P" }] })).toBe(
            "UNKNOWN"
        );
    });
});

describe("isBlockingAdvisory", () => {
    it("blocks a high or critical advisory", () => {
        expect(isBlockingAdvisory({ database_specific: { severity: "HIGH" } })).toBe(true);
        expect(isBlockingAdvisory({ database_specific: { severity: "critical" } })).toBe(true);
    });

    it("blocks a high/critical advisory declared only via a CVSS vector", () => {
        expect(isBlockingAdvisory({ severity: [{ type: "CVSS_V3", score: RCE_VECTOR }] })).toBe(true);
    });

    it("does not block a lower severity", () => {
        expect(isBlockingAdvisory({ database_specific: { severity: "MODERATE" } })).toBe(false);
        expect(isBlockingAdvisory({ database_specific: { severity: "LOW" } })).toBe(false);
    });

    it("fails closed on an advisory whose severity cannot be determined", () => {
        // The whole point of the fix: a live advisory with no usable severity signal must block
        // (surface for a human) rather than pass silently the way a bare database_specific lookup
        // would let it.
        expect(isBlockingAdvisory({})).toBe(true);
        expect(isBlockingAdvisory({ database_specific: { severity: 3 } })).toBe(true);
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
