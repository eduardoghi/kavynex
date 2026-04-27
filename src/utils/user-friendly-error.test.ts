import { describe, expect, it } from "vitest";
import { resolveErrorMessage, toUserFriendlyError } from "./user-friendly-error";
import {
    INVALID_LIBRARY_MIGRATION_ERROR_CODE,
    INVALID_LIBRARY_PATH_ERROR_CODE,
    INVALID_MEDIA_CREATION_ARGUMENTS_ERROR_CODE,
    YT_DLP_NOT_FOUND_ERROR_CODE,
} from "../constants/error-codes";

describe("toUserFriendlyError", () => {
    it("maps YT_DLP_NOT_FOUND correctly", () => {
        expect(
            toUserFriendlyError({
                code: YT_DLP_NOT_FOUND_ERROR_CODE,
                message: "yt-dlp missing",
            })
        ).toBe(
            "yt-dlp was not found. Install yt-dlp or place the binary in the app tools folder."
        );
    });

    it("maps INVALID_LIBRARY_PATH correctly", () => {
        expect(
            toUserFriendlyError({
                code: INVALID_LIBRARY_PATH_ERROR_CODE,
                message: "library path is empty",
            })
        ).toBe("Configure a valid library folder before continuing.");
    });

    it("maps INVALID_LIBRARY_MIGRATION correctly", () => {
        expect(
            toUserFriendlyError({
                code: INVALID_LIBRARY_MIGRATION_ERROR_CODE,
                message: "new library path cannot be inside the current library path",
            })
        ).toBe("The selected library migration path is not valid.");
    });

    it("maps INVALID_MEDIA_CREATION_ARGUMENTS correctly", () => {
        expect(
            toUserFriendlyError({
                code: INVALID_MEDIA_CREATION_ARGUMENTS_ERROR_CODE,
                message: "Invalid media creation arguments.",
            })
        ).toBe("Invalid media creation arguments.");
    });

    it("maps raw filesystem code correctly", () => {
        expect(
            toUserFriendlyError({
                code: "READ_DIR_FAILED",
                message: "failed to read directory",
            })
        ).toBe("Could not read the selected folder.");
    });

    it("falls back to original message when code is unknown", () => {
        expect(
            toUserFriendlyError({
                code: "SOMETHING_ELSE",
                message: "Custom backend failure",
            })
        ).toBe("Custom backend failure");
    });

    it("falls back to generic unknown error when message is empty", () => {
        expect(
            toUserFriendlyError({
                code: "SOMETHING_ELSE",
                message: "",
            })
        ).toBe("Unknown error.");
    });
});

describe("resolveErrorMessage", () => {
    it("returns friendly mapped message when available", () => {
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

    it("returns fallback when only unknown default message exists", () => {
        expect(resolveErrorMessage(123, "Fallback message")).toBe("Fallback message");
    });

    it("returns parsed raw message when code is unknown but message exists", () => {
        expect(
            resolveErrorMessage(
                {
                    code: "CUSTOM_ERROR",
                    message: "Something custom happened",
                },
                "Fallback message"
            )
        ).toBe("Something custom happened");
    });

    it("maps raw message text even without a raw code mapping", () => {
        expect(
            resolveErrorMessage(
                {
                    code: "SOMETHING_CUSTOM",
                    message: "failed to open directory",
                },
                "Fallback message"
            )
        ).toBe("failed to open directory");
    });
});