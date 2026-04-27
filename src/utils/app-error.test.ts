import { describe, expect, it } from "vitest";
import { createAppError, parseAppError } from "./app-error";

describe("parseAppError", () => {
    it("returns direct code and message from plain object", () => {
        expect(
            parseAppError({
                code: "INVALID_INPUT",
                message: "Invalid value",
            })
        ).toEqual({
            code: "INVALID_INPUT",
            message: "Invalid value",
            details: null,
        });
    });

    it("extracts nested error from json string", () => {
        expect(
            parseAppError(
                JSON.stringify({
                    error: JSON.stringify({
                        code: "YT_DLP_NOT_FOUND",
                        message: "yt-dlp missing",
                    }),
                })
            )
        ).toEqual({
            code: "YT_DLP_NOT_FOUND",
            message: "yt-dlp missing",
            details: null,
        });
    });

    it("preserves error.code from native error-like object", () => {
        const error = createAppError("CHANNEL_ALREADY_EXISTS", "Channel already exists");

        expect(parseAppError(error)).toEqual({
            code: "CHANNEL_ALREADY_EXISTS",
            message: "Channel already exists",
            details: null,
        });
    });

    it("reads nested cause from native error", () => {
        const error = new Error("top level") as Error & { cause?: unknown };

        error.cause = {
            code: "VIDEO_ALREADY_EXISTS_FOR_CHANNEL",
            message: "This media is already registered for the selected channel.",
        };

        expect(parseAppError(error)).toEqual({
            code: "VIDEO_ALREADY_EXISTS_FOR_CHANNEL",
            message: "This media is already registered for the selected channel.",
            details: null,
        });
    });

    it("falls back to APP_ERROR when unknown", () => {
        expect(parseAppError(123)).toEqual({
            code: "APP_ERROR",
            message: "Unknown error.",
            details: null,
        });
    });
});