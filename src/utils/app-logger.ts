import { parseAppError } from "./app-error";

type LogLevel = "info" | "warn" | "error";

type LogMeta = Record<string, unknown>;

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