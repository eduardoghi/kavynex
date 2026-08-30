import { describe, expect, it } from "vitest";
import {
    MOTION_PREFERENCES,
    parseMotionPreference,
    resolveReduceMotion,
} from "./motion-preference";

describe("parseMotionPreference", () => {
    it("accepts each known value as itself", () => {
        for (const value of MOTION_PREFERENCES) {
            expect(parseMotionPreference(value)).toBe(value);
        }
    });

    it("falls back to system for anything else", () => {
        // A missing key, a hand-edited entry, a value another build spelled differently. All of
        // them read as "follow the operating system", the one answer that cannot be wrong.
        for (const raw of [null, undefined, "", "on", "off", "REDUCE", 1, {}]) {
            expect(parseMotionPreference(raw)).toBe("system");
        }
    });
});

describe("resolveReduceMotion", () => {
    it("defers to the operating system under the default preference", () => {
        expect(resolveReduceMotion("system", true)).toBe(true);
        expect(resolveReduceMotion("system", false)).toBe(false);
    });

    it("overrides the operating system in either direction", () => {
        expect(resolveReduceMotion("reduce", false)).toBe(true);
        expect(resolveReduceMotion("full", true)).toBe(false);
    });
});
