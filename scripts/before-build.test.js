import { describe, expect, it } from "vitest";
import { planFrontendBuild } from "./before-build.js";

describe("planFrontendBuild", () => {
    it("builds the frontend for an ordinary tauri build", () => {
        expect(planFrontendBuild({}, false)).toEqual({ action: "build" });
        expect(planFrontendBuild({}, true)).toEqual({ action: "build" });
    });

    it("skips the build when the release already made it", () => {
        expect(planFrontendBuild({ KAVYNEX_FRONTEND_PREBUILT: "1" }, true)).toEqual({
            action: "skip",
        });
    });

    it("fails rather than bundle a frontend nobody built", () => {
        expect(planFrontendBuild({ KAVYNEX_FRONTEND_PREBUILT: "1" }, false).action).toBe("fail");
    });

    it("only takes the exact flag value as a reason to skip", () => {
        expect(planFrontendBuild({ KAVYNEX_FRONTEND_PREBUILT: "true" }, true)).toEqual({
            action: "build",
        });
    });
});
