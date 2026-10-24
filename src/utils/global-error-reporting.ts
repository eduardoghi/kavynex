import { TAURI_COMMANDS } from "../constants/tauri-commands";
import { invokeVoid } from "../lib/tauri-client";
import { logErrorToConsole, setLogSink } from "./app-logger";

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

// Logs to the console (devtools) and forwards the error, with its stack, to the backend log file,
// which is the only sink that survives a webview crash and can land in a bug report. The console
// half skips the log sink, which would write a second, stackless line for the same error.
// Persisting is best-effort. A failure here must never throw, or the handlers below would loop.
export function reportFatalError(scope: string, message: string, error: unknown): void {
    logErrorToConsole(scope, message, error);

    void invokeVoid(TAURI_COMMANDS.LOG_FRONTEND_ERROR, {
        scope,
        message: `${message} ${describeError(error)}`,
    }).catch(() => {
        // Already logged to the console above, and nothing else can be done.
    });
}

const BENIGN_RESIZE_OBSERVER_MESSAGES = [
    "ResizeObserver loop completed with undelivered notifications.",
    "ResizeObserver loop limit exceeded",
];

export function isBenignResizeObserverError(message: unknown): boolean {
    return (
        typeof message === "string" &&
        BENIGN_RESIZE_OBSERVER_MESSAGES.some((benign) => message.includes(benign))
    );
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

    // Route every `logWarn`/`logError` in the app to the backend log file as well as the console.
    // This lives here rather than inside app-logger so that module never imports the IPC seam,
    // which would close an import cycle through ipc-schemas. See `setLogSink`.
    setLogSink((level, scope, line) => {
        void invokeVoid(TAURI_COMMANDS.LOG_FRONTEND_ERROR, {
            scope,
            message: `[${level}] ${line}`,
        }).catch(() => {
            // Deliberately empty, and it must stay that way. Reporting this failure through
            // `logError` would re-enter this sink and turn a backend that is refusing the command
            // into an unbounded stream of IPC calls. The console already has the original line.
        });
    });

    window.addEventListener("error", (event) => {
        // Chromium reports a ResizeObserver callback that resized what it observes, which Mantine's
        // ScrollArea and the virtualized grids do while a window is resized, as a window error.
        // Nothing failed (the notifications arrive on the next frame), and on the file it buried the
        // errors that matter under one line per resize.
        if (isBenignResizeObserverError(event.message)) {
            return;
        }

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
