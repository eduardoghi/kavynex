import { beforeEach, describe, expect, it, vi } from "vitest";
import { installGlobalErrorHandlers, reportFatalError } from "./global-error-reporting";
import { TAURI_COMMANDS } from "../constants/tauri-commands";

vi.mock("../lib/tauri-client", () => ({
    invokeVoid: vi.fn(),
}));

vi.mock("./app-logger", () => ({
    logError: vi.fn(),
}));

import { invokeVoid } from "../lib/tauri-client";
import { logError } from "./app-logger";

describe("reportFatalError", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(invokeVoid).mockResolvedValue(undefined);
    });

    it("logs to the console logger and persists via the backend command", () => {
        const error = new Error("boom");

        reportFatalError("window", "Uncaught error reached the window.", error);

        expect(logError).toHaveBeenCalledWith(
            "window",
            "Uncaught error reached the window.",
            error
        );
        expect(invokeVoid).toHaveBeenCalledWith(TAURI_COMMANDS.LOG_FRONTEND_ERROR, {
            scope: "window",
            message: expect.stringContaining("Uncaught error reached the window."),
        });
    });

    it("includes non-Error values in the persisted message", () => {
        reportFatalError("window", "Unhandled promise rejection reached the window.", "raw reason");

        expect(invokeVoid).toHaveBeenCalledWith(TAURI_COMMANDS.LOG_FRONTEND_ERROR, {
            scope: "window",
            message: expect.stringContaining("raw reason"),
        });
    });

    it("persists the trimmed stack for Error instances", () => {
        const error = new Error("boom");
        error.stack = "  stack-trace  ";

        reportFatalError("window", "Crashed.", error);

        expect(invokeVoid).toHaveBeenCalledWith(TAURI_COMMANDS.LOG_FRONTEND_ERROR, {
            scope: "window",
            message: "Crashed. stack-trace",
        });
    });

    it("falls back to name and message when the stack is blank", () => {
        const error = new Error("boom");
        error.stack = "   ";

        reportFatalError("window", "Crashed.", error);

        expect(invokeVoid).toHaveBeenCalledWith(TAURI_COMMANDS.LOG_FRONTEND_ERROR, {
            scope: "window",
            message: "Crashed. Error: boom",
        });
    });

    it("serializes plain objects as JSON in the persisted message", () => {
        reportFatalError("window", "Crashed.", { code: 500 });

        expect(invokeVoid).toHaveBeenCalledWith(TAURI_COMMANDS.LOG_FRONTEND_ERROR, {
            scope: "window",
            message: 'Crashed. {"code":500}',
        });
    });

    it("stringifies primitives without JSON quoting", () => {
        reportFatalError("window", "Crashed.", "raw");

        expect(invokeVoid).toHaveBeenCalledWith(TAURI_COMMANDS.LOG_FRONTEND_ERROR, {
            scope: "window",
            message: "Crashed. raw",
        });
    });

    it("falls back to String() when JSON serialization fails", () => {
        const circular: Record<string, unknown> = {};
        circular.self = circular;

        reportFatalError("window", "Crashed.", circular);

        expect(invokeVoid).toHaveBeenCalledWith(TAURI_COMMANDS.LOG_FRONTEND_ERROR, {
            scope: "window",
            message: "Crashed. [object Object]",
        });
    });

    it("does not throw when persisting fails", () => {
        vi.mocked(invokeVoid).mockRejectedValue(new Error("ipc down"));

        expect(() => {
            reportFatalError("window", "message", new Error("boom"));
        }).not.toThrow();
    });
});

describe("installGlobalErrorHandlers", () => {
    it("registers window handlers only once and forwards events", () => {
        const addEventListenerSpy = vi.spyOn(window, "addEventListener");

        installGlobalErrorHandlers();
        installGlobalErrorHandlers();

        const errorRegistrations = addEventListenerSpy.mock.calls.filter(
            ([eventName]) => eventName === "error"
        );
        const rejectionRegistrations = addEventListenerSpy.mock.calls.filter(
            ([eventName]) => eventName === "unhandledrejection"
        );

        expect(errorRegistrations).toHaveLength(1);
        expect(rejectionRegistrations).toHaveLength(1);

        const errorHandler = errorRegistrations[0][1] as (event: ErrorEvent) => void;
        errorHandler(new ErrorEvent("error", { error: new Error("uncaught") }));

        expect(logError).toHaveBeenCalledWith(
            "window",
            "Uncaught error reached the window.",
            expect.objectContaining({ message: "uncaught" })
        );

        const rejectionHandler = rejectionRegistrations[0][1] as unknown as (event: {
            reason: unknown;
        }) => void;
        rejectionHandler({ reason: "denied" });

        expect(logError).toHaveBeenCalledWith(
            "window",
            "Unhandled promise rejection reached the window.",
            "denied"
        );

        addEventListenerSpy.mockRestore();
    });
});
