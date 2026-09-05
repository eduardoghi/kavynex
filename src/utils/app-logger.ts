import { parseAppError } from "./app-error";

type LogLevel = "info" | "warn" | "error";

type LogMeta = Record<string, unknown>;

// Where a warning or error goes once the console has it.
type LogSink = (level: LogLevel, scope: string, line: string) => void;

// The backend log file is the only sink that survives the window closing, and it is what
// `README.md` and `TROUBLESHOOTING.md` ask a user to attach to a bug report. Until this existed
// `logError` and `logWarn` reached neither: every one of their call sites wrote to a devtools
// console that a packaged build never opens, so a whole class of caught-and-logged failures left no
// trace anywhere. That cost a live diagnosis, where the one line explaining why the asset scope had
// failed existed and could not be read.
//
// Installed by `installGlobalErrorHandlers` rather than imported here, and that indirection is the
// point. Importing the IPC seam from this module would close a cycle, since `tauri-client` pulls in
// `ipc-schemas`, which logs through here.
let sink: LogSink | null = null;

export function setLogSink(next: LogSink | null): void {
    sink = next;
}

// Flattens what the console gets into one line the file can hold. The error is reduced to its code
// and message rather than serialized whole, because the file is read as text and a nested object
// helps nobody there.
function describeForSink(message: string, error?: unknown, meta?: LogMeta): string {
    const parts = [message];

    if (error !== undefined) {
        const normalized = parseAppError(error);
        parts.push(`error=${normalized.code}: ${normalized.message}`);
    }

    const normalizedMeta = normalizeMeta(meta);

    if (normalizedMeta) {
        try {
            parts.push(JSON.stringify(normalizedMeta));
        } catch {
            // A value that will not serialize is not worth losing the rest of the line over.
            parts.push("(meta could not be serialized)");
        }
    }

    return parts.join(" ");
}

function createPrefix(level: LogLevel, scope: string): string {
    return `[kavynex:${scope}] ${level.toUpperCase()}:`;
}

function normalizeMeta(meta?: LogMeta): LogMeta | undefined {
    if (!meta) {
        return undefined;
    }

    const entries = Object.entries(meta).filter(([, value]) => value !== undefined);

    if (entries.length === 0) {
        return undefined;
    }

    return Object.fromEntries(entries);
}

function writeLog(
    level: LogLevel,
    scope: string,
    message: string,
    error?: unknown,
    meta?: LogMeta
): void {
    const prefix = createPrefix(level, scope);
    const normalizedMeta = normalizeMeta(meta);

    // Warnings and errors also reach the backend log file. `info` stays console-only on purpose,
    // since a file that carries every routine step stops being the thing a bug report can be read
    // from.
    if (sink && level !== "info") {
        sink(level, scope, describeForSink(message, error, meta));
    }

    if (level === "error") {
        // parseAppError always returns a shape for any defined error, so this is the sole
        // normalization step; there is no separate fallback path.
        const normalizedError = error !== undefined ? parseAppError(error) : undefined;

        if (normalizedMeta && normalizedError) {
            console.error(prefix, message, {
                error: normalizedError,
                ...normalizedMeta,
            });
            return;
        }

        if (normalizedError) {
            console.error(prefix, message, {
                error: normalizedError,
            });
            return;
        }

        if (normalizedMeta) {
            console.error(prefix, message, normalizedMeta);
            return;
        }

        console.error(prefix, message);
        return;
    }

    if (level === "warn") {
        if (normalizedMeta) {
            console.warn(prefix, message, normalizedMeta);
            return;
        }

        console.warn(prefix, message);
        return;
    }

    if (normalizedMeta) {
        console.info(prefix, message, normalizedMeta);
        return;
    }

    console.info(prefix, message);
}

export function logInfo(scope: string, message: string, meta?: LogMeta): void {
    writeLog("info", scope, message, undefined, meta);
}

export function logWarn(scope: string, message: string, meta?: LogMeta): void {
    writeLog("warn", scope, message, undefined, meta);
}

export function logError(
    scope: string,
    message: string,
    error?: unknown,
    meta?: LogMeta
): void {
    writeLog("error", scope, message, error, meta);
}