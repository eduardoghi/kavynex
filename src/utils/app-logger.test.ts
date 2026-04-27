import { beforeEach, describe, expect, it, vi } from "vitest";
import { logError, logInfo, logWarn } from "./app-logger";

describe("app-logger", () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    it("writes info log", () => {
        const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});

        logInfo("test-scope", "hello");

        expect(infoSpy).toHaveBeenCalledWith("[kavynex:test-scope] INFO:", "hello");
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
});