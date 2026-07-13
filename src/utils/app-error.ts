import {
    APP_ERROR_CODE,
    CLIENT_ERROR_CODE,
    INVALID_INPUT_ERROR_CODE,
    type KnownErrorCode,
} from "../constants/error-codes";

export type AppErrorShape = {
    code: string;
    message: string;
    details?: string | null;
};

const DEFAULT_APP_ERROR: AppErrorShape = {
    code: APP_ERROR_CODE,
    message: "Unknown error.",
    details: null,
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

function tryParseJsonString(value: string): unknown {
    const normalized = value.trim();

    if (!normalized) {
        return null;
    }

    if (
        (normalized.startsWith("{") && normalized.endsWith("}")) ||
        (normalized.startsWith("[") && normalized.endsWith("]"))
    ) {
        try {
            return JSON.parse(normalized);
        } catch {
            return null;
        }
    }

    return null;
}

function normalizeOptionalDetails(value: unknown): string | null {
    if (typeof value !== "string") {
        return null;
    }

    const normalized = value.trim();
    return normalized ? normalized : null;
}

function normalizeDirectAppErrorShape(value: unknown): AppErrorShape | null {
    if (!isRecord(value)) {
        return null;
    }

    const hasCode = typeof value.code === "string" && value.code.trim() !== "";
    const hasMessage = typeof value.message === "string";

    if (!hasCode && !hasMessage) {
        return null;
    }

    return {
        code: hasCode ? String(value.code).trim() : APP_ERROR_CODE,
        message:
            hasMessage && String(value.message).trim() !== ""
                ? String(value.message).trim()
                : "Unknown error.",
        details: normalizeOptionalDetails(value.details),
    };
}

function extractNestedError(value: unknown): AppErrorShape | null {
    if (value == null) {
        return null;
    }

    if (typeof value === "string") {
        const parsed = tryParseJsonString(value);

        if (parsed) {
            const nested = extractNestedError(parsed);

            if (nested) {
                return nested;
            }
        }

        return null;
    }

    if (!isRecord(value)) {
        return null;
    }

    if ("error" in value) {
        const nestedFromError = extractNestedError(value.error);

        if (nestedFromError) {
            return nestedFromError;
        }
    }

    if ("cause" in value) {
        const nestedFromCause = extractNestedError(value.cause);

        if (nestedFromCause) {
            return nestedFromCause;
        }
    }

    if (typeof value.message === "string") {
        const nestedFromMessage = extractNestedError(value.message);

        if (nestedFromMessage) {
            return nestedFromMessage;
        }
    }

    return normalizeDirectAppErrorShape(value);
}

// A user-facing error authored on the frontend. Extends the native Error (so it keeps a stack
// trace and satisfies `instanceof Error` / vitest's `toThrow`) while carrying the dedicated
// CLIENT_ERROR code, which `parseAppError` reads back off the instance. That code is what keeps
// the message from colliding with the backend's deliberately-suppressed APP_ERROR: a
// `ClientError`'s message is resolved and shown verbatim by `resolveFriendlyMessage`, whereas a
// raw runtime Error (a TypeError, a library throw) stays APP_ERROR and degrades to the generic
// message. Throw this - instead of a bare `new Error(...)` - for any message meant for the user.
export class ClientError extends Error {
    readonly code = CLIENT_ERROR_CODE;

    constructor(message: string) {
        super(message);
        this.name = "ClientError";
    }
}

// Restricting the code to the registered union keeps every thrown code in the catalog
// (and in the friendly-message map) instead of drifting into ad-hoc string literals.
export function createAppError(
    code: KnownErrorCode,
    message: string,
    details?: string | null
): AppErrorShape {
    return {
        code: code.trim() || INVALID_INPUT_ERROR_CODE,
        message: message.trim() || "Unknown error.",
        details: details?.trim() || null,
    };
}

export function parseAppError(error: unknown): AppErrorShape {
    const extracted = extractNestedError(error);

    if (extracted) {
        return extracted;
    }

    if (error instanceof Error) {
        return {
            code: APP_ERROR_CODE,
            message: error.message?.trim() || "Unknown error.",
            details: null,
        };
    }

    if (typeof error === "string" && error.trim()) {
        return {
            code: APP_ERROR_CODE,
            message: error.trim(),
            details: null,
        };
    }

    return DEFAULT_APP_ERROR;
}