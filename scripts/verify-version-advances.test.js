import { describe, expect, it } from "vitest";
import { findVersionAdvanceProblem, newestPublishedVersion } from "./verify-version-advances.js";

describe("newestPublishedVersion", () => {
    it("compares tags as versions, not as text", () => {
        expect(newestPublishedVersion(["v1.10.0", "v1.9.0", "v1.7.0"])).toBe("1.10.0");
    });

    it("ignores tags that are not a release version", () => {
        expect(newestPublishedVersion(["nightly", "v1.2.0", "v2.0.0-beta"])).toBe("1.2.0");
    });

    it("is null without any release", () => {
        expect(newestPublishedVersion([])).toBeNull();
    });
});

describe("findVersionAdvanceProblem", () => {
    const published = ["v1.6.0", "v1.7.0"];

    it("accepts one step past the newest release", () => {
        expect(findVersionAdvanceProblem("1.8.0", published)).toBeNull();
        expect(findVersionAdvanceProblem("1.7.1", published)).toBeNull();
        expect(findVersionAdvanceProblem("2.0.0", published)).toBeNull();
    });

    it("refuses a typo, a repeat and a step back", () => {
        expect(findVersionAdvanceProblem("1.70.0", published)).toContain("v1.7.0");
        expect(findVersionAdvanceProblem("1.7.0", published)).not.toBeNull();
        expect(findVersionAdvanceProblem("1.6.1", published)).not.toBeNull();
    });

    it("accepts anything for the first release", () => {
        expect(findVersionAdvanceProblem("0.1.0", [])).toBeNull();
    });
});
