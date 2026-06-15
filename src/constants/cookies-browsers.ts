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

export const COOKIES_BROWSER_SELECT_OPTIONS = [
    ...SUPPORTED_BROWSERS.map((value) => ({
        value,
        label: value.charAt(0).toUpperCase() + value.slice(1),
    })),
    { value: "manual", label: "Manual cookies file" },
];
