import { describe, expect, it } from "vitest";
import { resolveErrorMessage, toUserFriendlyError } from "./error-message";

describe("error-message bridge", () => {
    it("re-exports resolveErrorMessage", () => {
        expect(
            resolveErrorMessage(
                {
                    code: "READ_DIR_FAILED",
                    message: "failed to read directory",
                },
                "Fallback message"
            )
        ).toBe("Could not read the selected folder.");
    });

    it("re-exports toUserFriendlyError", () => {
        expect(
            toUserFriendlyError({
                code: "CUSTOM_ERROR",
                message: "Something custom happened",
            })
        ).toBe("Something custom happened");
    });
});