// Shared avatar helpers used by the channel list, the comments and the live chat panels.

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
 * The initials an avatar shows when its image is missing, one per word for the first two words
 * ("Foo Bar" is "FB", "Madonna" is "M"), the same for a channel, a commenter and a chat author.
 * A leading "@" is dropped first, so a handle shows its first letter rather than the "@".
 */
export function avatarInitials(name: string): string {
    const words = name.replace(/^@+/, "").trim().split(/\s+/).filter(Boolean).slice(0, 2);

    if (words.length === 0) {
        return "?";
    }

    // The first character, not the first UTF-16 unit, so a name that starts with an emoji shows the
    // emoji rather than half of it.
    return words.map((word) => Array.from(word)[0]?.toUpperCase() ?? "").join("");
}
