// Shared avatar helpers used by the comments and live chat panels.

/**
 * Returns a usable avatar image source, or undefined when the value is empty or not a
 * remote http(s) URL (so SafeAvatar falls back to initials).
 */
export function resolveAvatarSrc(value: string | null): string | undefined {
    const normalized = value?.trim() ?? "";

    if (!normalized) {
        return undefined;
    }

    if (/^https?:\/\//i.test(normalized)) {
        return normalized;
    }

    return undefined;
}

/**
 * Builds up-to-two-letter initials from an author name (leading "@" stripped).
 */
export function avatarInitials(authorName: string): string {
    const cleaned = authorName.replace(/^@+/, "").trim();

    if (!cleaned) {
        return "?";
    }

    return cleaned.slice(0, 2).toUpperCase();
}
