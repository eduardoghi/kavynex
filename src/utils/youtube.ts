export function normalizeYoutubeHandle(value: string): string {
    const trimmed = value.trim();

    if (!trimmed) {
        return "";
    }

    const withoutUrl = trimmed
        .replace(/^https?:\/\/(www\.)?youtube\.com\//i, "")
        .replace(/^youtube\.com\//i, "")
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
        const [prefix, ...rest] = normalizedPathValue.split("/");
        const identifier = rest.join("/").trim();

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
        ? normalizedPathValue.slice(1).trim()
        : normalizedPathValue.trim();

    if (!baseHandle) {
        return "";
    }

    return `@${baseHandle}`;
}

export function isValidNormalizedYoutubeHandle(value: string): boolean {
    const normalized = value.trim();

    if (!normalized) {
        return false;
    }

    if (normalized.startsWith("@")) {
        const handle = normalized.slice(1).trim();
        return /^[A-Za-z0-9._-]+$/.test(handle);
    }

    const channelMatch = normalized.match(/^(channel|c|user)\/(.+)$/i);

    if (!channelMatch) {
        return false;
    }

    return channelMatch[2].trim().length > 0;
}