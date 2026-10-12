/**
 * Reduces what the user typed or pasted for a channel to the stored handle, which is `@name` or
 * `channel/`, `c/` or `user/` followed by the identifier.
 *
 * A pasted channel URL keeps only the identifier. The query and fragment (`?si=...` from a share
 * link) and any path after the identifier (the `/videos` of a channel tab) are dropped, the same
 * for the `@` form and the prefixed ones. A bare value with no `@` keeps its slashes, so something
 * that is not a channel at all (another site's URL) still fails validation instead of shrinking to
 * a valid-looking handle. Returns "" when nothing usable is left.
 */
export function normalizeYoutubeHandle(value: string): string {
    const trimmed = value.trim();

    if (!trimmed) {
        return "";
    }

    const withoutUrl = trimmed
        .replace(/^https?:\/\/(www\.)?youtube\.com\//i, "")
        .replace(/^youtube\.com\//i, "")
        .replace(/[?#].*$/s, "")
        .trim();

    if (!withoutUrl) {
        return "";
    }

    const normalizedPathValue = withoutUrl.replace(/\/+$/, "");

    if (!normalizedPathValue) {
        return "";
    }

    if (
        normalizedPathValue.startsWith("channel/") ||
        normalizedPathValue.startsWith("c/") ||
        normalizedPathValue.startsWith("user/")
    ) {
        const [prefix, identifierSegment] = normalizedPathValue.split("/");
        const identifier = (identifierSegment ?? "").trim();

        if (!identifier) {
            return "";
        }

        return `${prefix}/${identifier}`;
    }

    if (
        normalizedPathValue === "channel" ||
        normalizedPathValue === "c" ||
        normalizedPathValue === "user"
    ) {
        return "";
    }

    const baseHandle = normalizedPathValue.startsWith("@")
        ? (normalizedPathValue.split("/")[0] ?? "").slice(1).trim()
        : normalizedPathValue.trim();

    if (!baseHandle) {
        return "";
    }

    return `@${baseHandle}`;
}

/**
 * Builds the YouTube watch URL for a video id, or "" when the id is blank. The id is
 * percent-encoded so it can never break out of the query value. Shared by the player (which
 * derives the "open in YouTube" link) and the media-list "open source" action so both build
 * the URL the same way.
 */
export function buildYoutubeWatchUrl(videoId: string): string {
    const trimmed = videoId.trim();

    if (!trimmed) {
        return "";
    }

    return `https://www.youtube.com/watch?v=${encodeURIComponent(trimmed)}`;
}

export function isValidNormalizedYoutubeHandle(value: string): boolean {
    const normalized = value.trim();

    if (!normalized) {
        return false;
    }

    if (normalized.startsWith("@")) {
        // Not trimmed after the @. "@ chan" is not a handle YouTube has, and stored that way it
        // builds no URL the avatar lookup can use.
        return /^[A-Za-z0-9._-]+$/.test(normalized.slice(1));
    }

    const channelMatch = normalized.match(/^(channel|c|user)\/(.+)$/i);

    if (!channelMatch) {
        return false;
    }

    return (channelMatch[2] ?? "").trim().length > 0;
}