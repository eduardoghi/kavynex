import { createAppError } from "./app-error";

/** True only for a positive integer, which is the shape every database id has. */
export function isValidEntityId(id: number): boolean {
    return Number.isInteger(id) && id > 0;
}

/**
 * Throws a typed error when `id` is not a positive integer, so invalid ids (negatives,
 * fractions, zero, NaN) never reach the backend.
 */
export function assertValidEntityId(id: number, errorCode: string, message: string): void {
    if (!isValidEntityId(id)) {
        throw createAppError(errorCode, message);
    }
}
