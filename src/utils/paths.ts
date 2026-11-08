/**
 * Whether `path` is a filesystem/volume root. A location with no parent directory, rather
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

    // UNC share root. "\\server\share" (no further path segment after the share name).
    if (/^\\\\[^\\]+\\[^\\]+$/.test(stripped)) {
        return true;
    }

    return false;
}

/**
 * The path as a user would write it. Windows extended-length paths are what the backend
 * canonicalizes to, but the prefix is noise to a user, so a stored path is prettied for display only
 * and never for anything sent back.
 */
export function displayWindowsPath(path: string): string {
    return stripWindowsExtendedPrefix(path.trim());
}

export function normalizePathSeparators(value: string): string {
    return value.replace(/\\/g, "/");
}

// Removes the Windows extended-length prefix (\\?\ or the slash-normalized //?/ form,
// including the UNC variants) so the path handed to convertFileSrc matches the asset
// protocol scope authorized on the backend. On non-Windows paths this is a no-op.
export function stripWindowsExtendedPrefix(value: string): string {
    const uncMatch = value.match(/^[\\/]{2}\?[\\/]UNC[\\/](.*)$/i);

    if (uncMatch) {
        return `\\\\${uncMatch[1]}`;
    }

    const match = value.match(/^[\\/]{2}\?[\\/](.*)$/);

    if (match) {
        return match[1] ?? value;
    }

    return value;
}

// The last component of a path, a file's or a folder's name, whichever separator it uses.
export function fileNameFromPath(path: string): string {
    const normalized = normalizePathSeparators(path.trim());

    if (!normalized) {
        return "";
    }

    const parts = normalized.split("/").filter(Boolean);

    return parts[parts.length - 1] ?? "";
}
