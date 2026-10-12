export function normalizeString(value: string | null | undefined): string {
    return value?.trim() ?? "";
}

// Narrows a Mantine control's `string` onChange value to a known union, falling back when it is
// null/empty or (defensively) an unexpected value. Without this a typo in the control's `data`
// would produce an invalid union member with no compile-time or runtime guard.
export function toUnionValue<T extends string>(
    value: string | null | undefined,
    allowed: readonly T[],
    fallback: T
): T {
    return value != null && (allowed as readonly string[]).includes(value)
        ? (value as T)
        : fallback;
}
