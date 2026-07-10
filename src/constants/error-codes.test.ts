import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { KNOWN_ERROR_CODES } from "./error-codes";

// error-codes.ts is a hand-maintained mirror of a curated subset of the Rust
// `AppErrorCode` enum in src-tauri/src/error.rs. It does not (and is not meant to) mirror
// every backend code: most of the ~110 backend codes are internal failure reasons that
// never need frontend-specific handling and simply fall back to the generic error message.
// It also declares a handful of frontend-only codes for validation that happens purely in
// the UI before a backend call is ever made (e.g. duplicate-channel checks), which have no
// backend counterpart at all.
//
// What we *can* verify automatically is that every code the frontend does claim to mirror
// still exists, verbatim, among the backend's codes - catching a Rust code being renamed or
// removed without updating the TS side.
const testFileDir = dirname(fileURLToPath(import.meta.url));
const errorRsPath = resolve(testFileDir, "../../src-tauri/src/error.rs");

// Client-side-only codes: validated in the frontend before a backend call is made, so they
// are never returned by src-tauri/src/error.rs and have no backend code to mirror.
const FRONTEND_ONLY_ERROR_CODES = new Set([
    "CHANNEL_ALREADY_EXISTS",
    "INVALID_YOUTUBE_HANDLE",
    "INVALID_CHANNEL_NAME",
    "INVALID_CHANNEL_ID",
    "INVALID_MEDIA_CREATION_ARGUMENTS",
    "MEDIA_IMPORT_FAILED",
    "VIDEO_ALREADY_EXISTS_FOR_CHANNEL",
    "INVALID_MEDIA_TITLE",
    "MEDIA_WITHOUT_YOUTUBE_SOURCE",
    "INVALID_YOUTUBE_COMMENTS_PAYLOAD",
    "YOUTUBE_COMMENTS_EMPTY_REFRESH",
]);

function extractRustErrorCodes(source: string): Set<string> {
    const asStrMatch = source.match(
        /pub fn as_str\(self\) -> &'static str \{\s*match self \{([\s\S]*?)\n\s*\}\s*\n\s*\}/
    );

    if (!asStrMatch) {
        throw new Error("Could not locate the `as_str` match block in error.rs");
    }

    const matchBody = asStrMatch[1];
    const codePattern = /Self::\w+\s*=>\s*"([A-Z0-9_]+)"/g;
    const codes = new Set<string>();

    for (const match of matchBody.matchAll(codePattern)) {
        codes.add(match[1]);
    }

    return codes;
}

describe("error codes stay in sync with the backend", () => {
    const rustCodes = extractRustErrorCodes(readFileSync(errorRsPath, "utf-8"));

    it("finds a sane number of codes in error.rs (regression guard for the extraction regex)", () => {
        expect(rustCodes.size).toBeGreaterThan(50);
    });

    it.each(
        KNOWN_ERROR_CODES.filter((code) => !FRONTEND_ONLY_ERROR_CODES.has(code))
    )("mirrors the backend code for %s", (code) => {
        expect(rustCodes.has(code)).toBe(true);
    });

    it("does not list a frontend-only code that the backend has started emitting", () => {
        // If this fails, the backend now emits one of these codes for real: drop it from
        // FRONTEND_ONLY_ERROR_CODES and let the mirroring check above cover it instead.
        for (const code of FRONTEND_ONLY_ERROR_CODES) {
            expect(rustCodes.has(code)).toBe(false);
        }
    });
});
