/**
 * Trims each value, drops empties, and de-duplicates while preserving first-seen order.
 * Used to turn a raw list of stored relative paths (media, thumbnails, live chat) into the
 * clean set the backend integrity checks expect.
 */
export function normalizeNonEmptyUniquePaths(
    values: Array<string | null | undefined>
): string[] {
    return [
        ...new Set(values.map((value) => value?.trim() ?? "").filter((value) => value !== "")),
    ];
}
