import { describe, expect, it } from "vitest";
import { createAppError, parseAppError } from "./app-error";
import type { KnownErrorCode } from "../constants/error-codes";

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

    it("trims code, message and details from plain object", () => {
        expect(
            parseAppError({
                code: "  INVALID_INPUT  ",
                message: "  Invalid value  ",
                details: "  field is required  ",
            })
        ).toEqual({
            code: "INVALID_INPUT",
            message: "Invalid value",
            details: "field is required",
        });
    });

    it("falls back to APP_ERROR code when code is blank", () => {
        expect(
            parseAppError({
                code: "   ",
                message: "Invalid value",
            })
        ).toEqual({
            code: "APP_ERROR",
            message: "Invalid value",
            details: null,
        });
    });

    it("falls back to APP_ERROR code when code is not a string", () => {
        expect(
            parseAppError({
                code: 42,
                message: "Invalid value",
            })
        ).toEqual({
            code: "APP_ERROR",
            message: "Invalid value",
            details: null,
        });
    });

    it("uses APP_ERROR code when only a message is present", () => {
        expect(
            parseAppError({
                message: "just a message",
            })
        ).toEqual({
            code: "APP_ERROR",
            message: "just a message",
            details: null,
        });
    });

    it("defaults the message when only a code is present", () => {
        expect(
            parseAppError({
                code: "CUSTOM_CODE",
            })
        ).toEqual({
            code: "CUSTOM_CODE",
            message: "Unknown error.",
            details: null,
        });
    });

    it("defaults the message when it is blank", () => {
        expect(
            parseAppError({
                code: "CUSTOM_CODE",
                message: "   ",
            })
        ).toEqual({
            code: "CUSTOM_CODE",
            message: "Unknown error.",
            details: null,
        });
    });

    it("returns the default shape for object without code or message", () => {
        expect(parseAppError({ foo: "bar" })).toEqual({
            code: "APP_ERROR",
            message: "Unknown error.",
            details: null,
        });
    });

    it("normalizes blank details to null", () => {
        expect(
            parseAppError({
                code: "INVALID_INPUT",
                message: "Invalid value",
                details: "   ",
            })
        ).toEqual({
            code: "INVALID_INPUT",
            message: "Invalid value",
            details: null,
        });
    });

    it("normalizes non-string details to null", () => {
        expect(
            parseAppError({
                code: "INVALID_INPUT",
                message: "Invalid value",
                details: 42,
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

    it("extracts nested error from json string with surrounding whitespace", () => {
        expect(
            parseAppError(
                `  ${JSON.stringify({
                    code: "YT_DLP_NOT_FOUND",
                    message: "yt-dlp missing",
                })}  `
            )
        ).toEqual({
            code: "YT_DLP_NOT_FOUND",
            message: "yt-dlp missing",
            details: null,
        });
    });

    it("treats a malformed json object string as a plain message", () => {
        expect(parseAppError("{not valid json}")).toEqual({
            code: "APP_ERROR",
            message: "{not valid json}",
            details: null,
        });
    });

    it("treats a json array string as a plain message", () => {
        expect(parseAppError('[{"code":"IGNORED","message":"ignored"}]')).toEqual({
            code: "APP_ERROR",
            message: '[{"code":"IGNORED","message":"ignored"}]',
            details: null,
        });
    });

    it("prefers the nested error key over the cause key", () => {
        expect(
            parseAppError({
                error: { code: "FROM_ERROR", message: "from error" },
                cause: { code: "FROM_CAUSE", message: "from cause" },
            })
        ).toEqual({
            code: "FROM_ERROR",
            message: "from error",
            details: null,
        });
    });

    it("falls back to the direct shape when the error key is not parseable", () => {
        expect(
            parseAppError({
                error: "not an app error",
                code: "DIRECT_CODE",
                message: "direct message",
            })
        ).toEqual({
            code: "DIRECT_CODE",
            message: "direct message",
            details: null,
        });
    });

    it("falls back to the direct shape when the cause key is not parseable", () => {
        expect(
            parseAppError({
                cause: 42,
                code: "DIRECT_CODE",
                message: "direct message",
            })
        ).toEqual({
            code: "DIRECT_CODE",
            message: "direct message",
            details: null,
        });
    });

    it("extracts a nested error embedded in the message as json", () => {
        expect(
            parseAppError({
                message: JSON.stringify({
                    code: "NESTED_CODE",
                    message: "nested message",
                }),
            })
        ).toEqual({
            code: "NESTED_CODE",
            message: "nested message",
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

    it("uses the message of a native error", () => {
        expect(parseAppError(new Error("boom"))).toEqual({
            code: "APP_ERROR",
            message: "boom",
            details: null,
        });
    });

    it("defaults the message of a native error without message", () => {
        expect(parseAppError(new Error(""))).toEqual({
            code: "APP_ERROR",
            message: "Unknown error.",
            details: null,
        });
    });

    it("handles an Error instance whose message is not a string", () => {
        // Exercises the instanceof Error fallback in parseAppError, which is only
        // reachable when the message property does not hold a string.
        const error = Object.create(Error.prototype, {
            message: { value: undefined },
        });

        expect(parseAppError(error)).toEqual({
            code: "APP_ERROR",
            message: "Unknown error.",
            details: null,
        });
    });

    it("wraps a plain string as the message, trimmed", () => {
        expect(parseAppError("  something failed  ")).toEqual({
            code: "APP_ERROR",
            message: "something failed",
            details: null,
        });
    });

    it("falls back to the default shape for a whitespace-only string", () => {
        expect(parseAppError("   ")).toEqual({
            code: "APP_ERROR",
            message: "Unknown error.",
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

    it("falls back to the default shape for null and undefined", () => {
        const expected = {
            code: "APP_ERROR",
            message: "Unknown error.",
            details: null,
        };

        expect(parseAppError(null)).toEqual(expected);
        expect(parseAppError(undefined)).toEqual(expected);
    });
});

describe("createAppError", () => {
    it("trims code, message and details", () => {
        expect(
            createAppError("  INVALID_URL  " as KnownErrorCode, "  bad url  ", "  not http  ")
        ).toEqual({
            code: "INVALID_URL",
            message: "bad url",
            details: "not http",
        });
    });

    it("defaults a blank code to INVALID_INPUT", () => {
        expect(createAppError("   " as KnownErrorCode, "bad url")).toEqual({
            code: "INVALID_INPUT",
            message: "bad url",
            details: null,
        });
    });

    it("defaults a blank message to the unknown error message", () => {
        expect(createAppError("INVALID_URL", "   ")).toEqual({
            code: "INVALID_URL",
            message: "Unknown error.",
            details: null,
        });
    });

    it("normalizes blank details to null", () => {
        expect(createAppError("INVALID_URL", "bad url", "   ")).toEqual({
            code: "INVALID_URL",
            message: "bad url",
            details: null,
        });
    });

    it("defaults omitted details to null", () => {
        expect(createAppError("INVALID_URL", "bad url")).toEqual({
            code: "INVALID_URL",
            message: "bad url",
            details: null,
        });
    });
});
