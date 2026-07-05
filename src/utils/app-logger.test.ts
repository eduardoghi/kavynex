import { beforeEach, describe, expect, it, vi } from "vitest";
import { APP_ERROR_CODE } from "../constants/error-codes";
import { logError, logInfo, logWarn } from "./app-logger";

describe("app-logger", () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    it("writes info log", () => {
        const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});

        logInfo("test-scope", "hello");

        expect(infoSpy.mock.calls[0]).toStrictEqual(["[kavynex:test-scope] INFO:", "hello"]);
    });

    it("writes info log with meta", () => {
        const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});

        logInfo("test-scope", "hello", {
            id: 7,
        });

        expect(infoSpy.mock.calls[0]).toStrictEqual([
            "[kavynex:test-scope] INFO:",
            "hello",
            {
                id: 7,
            },
        ]);
    });

    it("drops meta entirely when every value is undefined", () => {
        const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});

        logInfo("test-scope", "hello", {
            skipped: undefined,
        });

        expect(infoSpy.mock.calls[0]).toStrictEqual(["[kavynex:test-scope] INFO:", "hello"]);
    });

    it("writes warn log without meta", () => {
        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

        logWarn("test-scope", "warning");

        expect(warnSpy.mock.calls[0]).toStrictEqual(["[kavynex:test-scope] WARN:", "warning"]);
    });

    it("writes warn log with meta", () => {
        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

        logWarn("test-scope", "warning", {
            id: 10,
        });

        expect(warnSpy).toHaveBeenCalledWith(
            "[kavynex:test-scope] WARN:",
            "warning",
            {
                id: 10,
            }
        );
    });

    it("writes error log with parsed error payload", () => {
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

        logError("test-scope", "failure", {
            code: "APP_ERROR",
            message: "boom",
        });

        expect(errorSpy).toHaveBeenCalledWith(
            "[kavynex:test-scope] ERROR:",
            "failure",
            expect.objectContaining({
                error: expect.objectContaining({
                    code: "APP_ERROR",
                    message: "boom",
                }),
            })
        );
    });

    it("writes error log with meta", () => {
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

        logError(
            "test-scope",
            "failure",
            {
                code: "APP_ERROR",
                message: "boom",
            },
            {
                mediaId: 12,
            }
        );

        expect(errorSpy).toHaveBeenCalledWith(
            "[kavynex:test-scope] ERROR:",
            "failure",
            expect.objectContaining({
                error: expect.objectContaining({
                    code: "APP_ERROR",
                    message: "boom",
                }),
                mediaId: 12,
            })
        );
    });

    it("writes error log without error and meta", () => {
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

        logError("test-scope", "failure");

        expect(errorSpy.mock.calls[0]).toStrictEqual(["[kavynex:test-scope] ERROR:", "failure"]);
    });

    it("writes error log with the parsed payload for Error instances", () => {
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

        logError("test-scope", "failure", new Error("boom"));

        expect(errorSpy.mock.calls[0]).toStrictEqual([
            "[kavynex:test-scope] ERROR:",
            "failure",
            {
                error: {
                    code: APP_ERROR_CODE,
                    message: "boom",
                    details: null,
                },
            },
        ]);
    });

    it("writes error log with meta only", () => {
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

        logError("test-scope", "failure", undefined, {
            mediaId: 12,
        });

        expect(errorSpy.mock.calls[0]).toStrictEqual([
            "[kavynex:test-scope] ERROR:",
            "failure",
            {
                mediaId: 12,
            },
        ]);
    });
});