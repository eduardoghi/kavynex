import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
    composeCookiesBrowserSelector,
    normalizeCookiesBrowser,
    parseCookiesBrowserSelector,
    redactCookiesBrowserSelector,
} from "./cookies-browsers";

type SelectorCases = {
    valid: Array<{ input: string; normalized: string }>;
    invalid: string[];
};

// Parity with the Rust validator (src-tauri/src/services/yt_dlp/cookies.rs), through the one
// fixture both sides read. A value this side lets through has to be one the backend hands to
// yt-dlp, in the same spelling, or the user is told the profile was accepted and then downloads
// without cookies. Add a case to shared/cookies-browser-selector-cases.json and both pick it up.
describe("normalizeCookiesBrowser parity with the shared fixture", () => {
    const cases = JSON.parse(
        readFileSync(resolve(process.cwd(), "shared/cookies-browser-selector-cases.json"), "utf-8")
    ) as SelectorCases;

    it("has a non-trivial fixture", () => {
        expect(cases.valid.length).toBeGreaterThan(5);
        expect(cases.invalid.length).toBeGreaterThan(5);
    });

    it.each(cases.valid)("accepts $input as $normalized", ({ input, normalized }) => {
        expect(normalizeCookiesBrowser(input)).toBe(normalized);
    });

    it.each(cases.invalid.map((value) => [value]))("rejects %j", (value) => {
        expect(normalizeCookiesBrowser(value)).toBeNull();
    });
});

describe("parseCookiesBrowserSelector", () => {
    it("places each part where yt-dlp reads it", () => {
        // Pinned part by part, not only through the round-tripped string, so a swapped split
        // (profile and container traded) cannot hide behind an argument that reads back the same.
        expect(parseCookiesBrowserSelector(" Chromium + KWallet5 : Work Profile :: Work ")).toEqual({
            browser: "chromium",
            keyring: "kwallet5",
            profile: "Work Profile",
            container: "Work",
        });
    });

    it("keeps the drive colon of a Windows profile path inside the profile", () => {
        expect(
            parseCookiesBrowserSelector(
                "chrome:C:\\Users\\me\\AppData\\Local\\Google\\Chrome\\User Data\\Default"
            )
        ).toEqual({
            browser: "chrome",
            keyring: null,
            profile: "C:\\Users\\me\\AppData\\Local\\Google\\Chrome\\User Data\\Default",
            container: null,
        });
    });

    it("returns null for undefined and null inputs through normalize", () => {
        expect(normalizeCookiesBrowser(null)).toBeNull();
        expect(normalizeCookiesBrowser(undefined)).toBeNull();
    });
});

describe("composeCookiesBrowserSelector", () => {
    it("returns the bare browser when no profile is typed", () => {
        expect(composeCookiesBrowserSelector("firefox", "")).toBe("firefox");
        expect(composeCookiesBrowserSelector(" Firefox ", "   ")).toBe("firefox");
    });

    it("appends the profile after a colon", () => {
        expect(composeCookiesBrowserSelector("firefox", " default-release ")).toBe(
            "firefox:default-release"
        );
        expect(composeCookiesBrowserSelector("firefox", "abc.default::Work")).toBe(
            "firefox:abc.default::Work"
        );
    });

    it("appends a keyring value that starts with + as typed", () => {
        // The one field covers the whole grammar: a user on Linux who needs the keyring types
        // `+gnomekeyring:Default` and the browser is joined to it without a second separator.
        expect(composeCookiesBrowserSelector("chromium", "+gnomekeyring:Default")).toBe(
            "chromium+gnomekeyring:Default"
        );
    });

    it("composes to nothing for manual and for no browser", () => {
        // "manual" selects the cookies file and is never a --cookies-from-browser value, and a
        // profile with no browser has nothing to attach to.
        expect(composeCookiesBrowserSelector("manual", "profile")).toBe("");
        expect(composeCookiesBrowserSelector("", "profile")).toBe("");
    });

    it("round-trips through the validator in the spelling yt-dlp reads", () => {
        expect(normalizeCookiesBrowser(composeCookiesBrowserSelector("Firefox", "Work"))).toBe(
            "firefox:Work"
        );
    });
});

describe("redactCookiesBrowserSelector", () => {
    it("keeps a bare browser unchanged", () => {
        expect(redactCookiesBrowserSelector("firefox")).toBe("firefox");
    });

    it("hides the profile and container but keeps browser and keyring", () => {
        expect(
            redactCookiesBrowserSelector("firefox:/home/alice/.mozilla/firefox/abc.default")
        ).toBe("firefox:<redacted>");
        expect(redactCookiesBrowserSelector("firefox::Personal")).toBe("firefox::<redacted>");
        expect(redactCookiesBrowserSelector("chromium+gnomekeyring:Default::Work")).toBe(
            "chromium+gnomekeyring:<redacted>::<redacted>"
        );
    });

    it("replaces a value that does not parse entirely", () => {
        expect(redactCookiesBrowserSelector("netscape:x")).toBe("<redacted>");
        expect(redactCookiesBrowserSelector("")).toBe("<redacted>");
    });
});
