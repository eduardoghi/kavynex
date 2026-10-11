import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ORPHAN_GRACE_PERIOD_DAYS } from "./library-retention";

describe("ORPHAN_GRACE_PERIOD_DAYS", () => {
    it("is the period the backend applies", () => {
        const shared = JSON.parse(
            readFileSync(resolve(process.cwd(), "shared/orphan-grace-period.json"), "utf-8")
        ) as { orphanGracePeriodDays: number };

        expect(ORPHAN_GRACE_PERIOD_DAYS).toBe(shared.orphanGracePeriodDays);
    });
});
