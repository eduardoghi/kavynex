import { TAURI_COMMANDS } from "../constants/tauri-commands";
import { invokeVoid } from "../lib/tauri-client";
import { logError } from "./app-logger";

function describeError(error: unknown): string {
    if (error instanceof Error) {
        const stack = error.stack?.trim();
        return stack || `${error.name}: ${error.message}`;
    }

    if (typeof error === "object" && error !== null) {
        try {
            return JSON.stringify(error);
        } catch {
            return String(error);
        }
    }

    return String(error);
}

// Logs to the console (devtools) and forwards the error to the backend log file, which is
// the only sink that survives a webview crash and can land in a bug report. Persisting is
// best-effort: a failure here must never throw, or the handlers below would loop.
export function reportFatalError(scope: string, message: string, error: unknown): void {
    logError(scope, message, error);

    void invokeVoid(TAURI_COMMANDS.LOG_FRONTEND_ERROR, {
        scope,
        message: `${message} ${describeError(error)}`,
    }).catch(() => {
        // Already logged to the console above; nothing else can be done.
    });
}

let installed = false;

// Installs window-level handlers so errors that escape React (event handlers, timers,
// unawaited promises) are still recorded. Render crashes are covered separately by the
// root error boundary.
export function installGlobalErrorHandlers(): void {
    if (installed) {
        return;
    }

    installed = true;

    window.addEventListener("error", (event) => {
        reportFatalError(
            "window",
            "Uncaught error reached the window.",
            event.error ?? event.message
        );
    });

    window.addEventListener("unhandledrejection", (event) => {
        reportFatalError("window", "Unhandled promise rejection reached the window.", event.reason);
    });
}
