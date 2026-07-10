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

/**
 * Whether `path` is a filesystem/volume root - a location with no parent directory - rather
 * than a normal folder. Accepting a root as the library folder would make the asset:// scope
 * recursive over the whole drive, so callers must reject it before accepting the selection.
 * Handles POSIX roots ("/"), Windows drive roots ("C:", "C:\", "\\?\C:\"), and UNC share
 * roots ("\\server\share").
 */
export function isFilesystemRootPath(path: string): boolean {
    const trimmed = path.trim();

    if (!trimmed) {
        return false;
    }

    const stripped = trimmed.replace(/[\\/]+$/, "");

    // A POSIX root ("/") or a bare separator strips down to an empty string.
    if (stripped === "") {
        return true;
    }

    // Windows drive root, with or without the extended-length prefix: "C:", "C:\", "\\?\C:\".
    if (/^(?:\\\\\?\\)?[a-zA-Z]:$/.test(stripped)) {
        return true;
    }

    // UNC share root: "\\server\share" (no further path segment after the share name).
    if (/^\\\\[^\\]+\\[^\\]+$/.test(stripped)) {
        return true;
    }

    return false;
}
