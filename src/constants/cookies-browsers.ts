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

/**
 * Normalizes a cookies-from-browser selection to a supported browser name, or null. Note the
 * UI-only "manual" option is not a browser and is intentionally rejected here; the add-media
 * form resolves that separately into a cookies file path.
 */
export function normalizeCookiesBrowser(value: string | null | undefined): string | null {
    const normalized = value?.trim().toLowerCase() ?? "";
    return COOKIES_BROWSER_VALUES.has(normalized) ? normalized : null;
}

export const COOKIES_BROWSER_SELECT_OPTIONS = [
    ...SUPPORTED_BROWSERS.map((value) => ({
        value,
        label: value.charAt(0).toUpperCase() + value.slice(1),
    })),
    { value: "manual", label: "Manual cookies file" },
];
