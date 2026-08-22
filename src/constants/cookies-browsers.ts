const SUPPORTED_BROWSERS = [
    "brave",
    "chrome",
    "chromium",
    "edge",
    "firefox",
    "opera",
    "safari",
    "vivaldi",
    "whale",
] as const;

export const COOKIES_BROWSER_VALUES = new Set<string>(SUPPORTED_BROWSERS);

// The keyrings yt-dlp accepts after `+` on a Chromium-based browser (Linux only, the cookie
// decryption backend). Compared case-insensitively, stored lowercase, like the backend does.
const SUPPORTED_KEYRINGS = new Set<string>([
    "basictext",
    "gnomekeyring",
    "kwallet",
    "kwallet5",
    "kwallet6",
]);

// Upper bound on the whole selector. A profile can be a path, so it is generous. Mirrors
// MAX_COOKIES_BROWSER_SELECTOR_CHARS in src-tauri/src/services/yt_dlp/cookies.rs.
const MAX_COOKIES_BROWSER_SELECTOR_CHARS = 512;

/**
 * A parsed `--cookies-from-browser` value, `BROWSER[+KEYRING][:PROFILE][::CONTAINER]`.
 *
 * This is the grammar yt-dlp reads (its README, `--cookies-from-browser`), and the backend
 * re-validates the same grammar (`services/yt_dlp/cookies.rs`) before the value can reach an argv.
 * The two copies are kept from drifting apart by `shared/cookies-browser-selector-cases.json`,
 * asserted from both sides. The frontend's copy exists so a profile the user types is refused on
 * screen, rather than dropped silently on the other side and the download run without cookies.
 */
export type CookiesBrowserSelector = {
    browser: string;
    keyring: string | null;
    profile: string | null;
    container: string | null;
};

// Control characters (C0 plus DEL and C1), spelled as escapes rather than pasted, matching how this
// repository writes a codepoint used as data. A newline would also forge a line in the file log.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/;

function isSafeSelectorComponent(value: string): boolean {
    return value !== "" && !value.startsWith("-") && !CONTROL_CHARACTER.test(value);
}

function splitOnce(value: string, separator: string): [string, string | null] {
    const index = value.indexOf(separator);

    if (index === -1) {
        return [value, null];
    }

    return [value.slice(0, index), value.slice(index + separator.length)];
}

export function parseCookiesBrowserSelector(value: string): CookiesBrowserSelector | null {
    const trimmed = value.trim();

    if (
        trimmed === "" ||
        Array.from(trimmed).length > MAX_COOKIES_BROWSER_SELECTOR_CHARS ||
        CONTROL_CHARACTER.test(trimmed)
    ) {
        return null;
    }

    // The split order mirrors yt-dlp's own regex: the container after the first `::`, the profile
    // after the first `:` before it (a Windows path in the profile keeps its drive colon, since only
    // the first one separates), and the keyring after a `+` in the browser part.
    const [head, rawContainer] = splitOnce(trimmed, "::");
    const [browserAndKeyring, rawProfile] = splitOnce(head, ":");
    const [rawBrowser, rawKeyring] = splitOnce(browserAndKeyring, "+");

    const browser = rawBrowser.trim().toLowerCase();

    if (!COOKIES_BROWSER_VALUES.has(browser)) {
        return null;
    }

    let keyring: string | null = null;

    if (rawKeyring !== null) {
        keyring = rawKeyring.trim().toLowerCase();

        if (!SUPPORTED_KEYRINGS.has(keyring)) {
            return null;
        }
    }

    const profile = rawProfile === null ? null : rawProfile.trim();

    if (profile !== null && !isSafeSelectorComponent(profile)) {
        return null;
    }

    const container = rawContainer === null ? null : rawContainer.trim();

    // A container that itself starts with `:` is the `firefox:::x` shape: yt-dlp parses it, as a
    // container literally named `:x`, but nothing a user means is spelled that way.
    if (container !== null && (!isSafeSelectorComponent(container) || container.startsWith(":"))) {
        return null;
    }

    return { browser, keyring, profile, container };
}

function selectorToArgument(selector: CookiesBrowserSelector): string {
    let value = selector.browser;

    if (selector.keyring !== null) {
        value += `+${selector.keyring}`;
    }

    if (selector.profile !== null) {
        value += `:${selector.profile}`;
    }

    if (selector.container !== null) {
        value += `::${selector.container}`;
    }

    return value;
}

/**
 * Normalizes a cookies-from-browser selector to the form handed to yt-dlp, or null. Note the
 * UI-only "manual" option is not a browser and is intentionally rejected here; the add-media
 * form resolves that separately into a cookies file path.
 */
export function normalizeCookiesBrowser(value: string | null | undefined): string | null {
    if (value === null || value === undefined) {
        return null;
    }

    const selector = parseCookiesBrowserSelector(value);

    return selector === null ? null : selectorToArgument(selector);
}

/**
 * Builds the selector the form sends from the browser combo and the optional profile field.
 *
 * The profile field is appended after the browser: a plain value becomes `browser:value`, and a
 * value the user starts with `+` (a keyring, `+gnomekeyring:Default`) is appended as typed so the
 * one field can express the whole grammar without a second control for the rare case. "manual" is
 * not a browser and composes to nothing, as does an empty browser.
 */
export function composeCookiesBrowserSelector(browser: string, profile: string): string {
    const normalizedBrowser = browser.trim().toLowerCase();
    const normalizedProfile = profile.trim();

    if (normalizedBrowser === "" || normalizedBrowser === "manual") {
        return "";
    }

    if (normalizedProfile === "") {
        return normalizedBrowser;
    }

    if (normalizedProfile.startsWith("+")) {
        return `${normalizedBrowser}${normalizedProfile}`;
    }

    return `${normalizedBrowser}:${normalizedProfile}`;
}

/**
 * The form of a selector that may be shown in the terminal preview or written to a log: the
 * browser and keyring kept, the profile and container replaced. A profile is often a path under
 * the user's home directory, and both the terminal and the log are pasted into bug reports. A value
 * that does not parse is fully replaced. Mirrors `redact_cookies_browser_selector` on the backend.
 */
export function redactCookiesBrowserSelector(value: string): string {
    const selector = parseCookiesBrowserSelector(value);

    if (selector === null) {
        return "<redacted>";
    }

    let redacted = selector.browser;

    if (selector.keyring !== null) {
        redacted += `+${selector.keyring}`;
    }

    if (selector.profile !== null) {
        redacted += ":<redacted>";
    }

    if (selector.container !== null) {
        redacted += "::<redacted>";
    }

    return redacted;
}

export const COOKIES_BROWSER_SELECT_OPTIONS = [
    ...SUPPORTED_BROWSERS.map((value) => ({
        value,
        label: value.charAt(0).toUpperCase() + value.slice(1),
    })),
    { value: "manual", label: "Manual cookies file" },
];
