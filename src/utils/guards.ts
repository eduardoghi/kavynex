export function normalizeString(value: string | null | undefined): string {
    return value?.trim() ?? "";
}

export function isNonEmptyString(value: string | null | undefined): value is string {
    return normalizeString(value) !== "";
}

export function assertNonEmptyString(
    value: string | null | undefined,
    fallbackMessage: string
): string {
    const normalized = normalizeString(value);

    if (!normalized) {
        throw new Error(fallbackMessage);
    }

    return normalized;
}