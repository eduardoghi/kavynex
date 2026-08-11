import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { KNOWN_ERROR_CODES } from "./error-codes";
import { toUserFriendlyError } from "../utils/user-friendly-error";

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
//
// Several codes that used to be frontend-only are NOT listed here because the backend now
// emits them too, so they must mirror a real backend code (validated by the check below):
// - CHANNEL_ALREADY_EXISTS / VIDEO_ALREADY_EXISTS_FOR_CHANNEL: frontend pre-check AND a
//   backend constraint violation (the duplicate-insert race).
// - INVALID_CHANNEL_NAME / INVALID_YOUTUBE_HANDLE / INVALID_MEDIA_TITLE /
//   INVALID_MEDIA_CREATION_ARGUMENTS: frontend validation for fast UX AND backend validation
//   at the command boundary (utils::validation), since the backend is the durable trust
//   boundary.
// INVALID_CHANNEL_ID stays frontend-only: channel ids reach the backend as a typed i64, so
// there is no backend code that rejects an invalid one.
// CLIENT_ERROR tags a user-facing error authored purely on the frontend (utils/app-error.ts's
// ClientError), so it has no backend counterpart in error.rs.
const FRONTEND_ONLY_ERROR_CODES = new Set([
    "CLIENT_ERROR",
    "INVALID_CHANNEL_ID",
    "MEDIA_IMPORT_FAILED",
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

    const matchBody = asStrMatch[1]!;
    const codePattern = /Self::\w+\s*=>\s*"([A-Z0-9_]+)"/g;
    const codes = new Set<string>();

    for (const match of matchBody.matchAll(codePattern)) {
        codes.add(match[1]!);
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

// The checks above run frontend -> backend: every code the frontend claims to mirror still exists
// in Rust, which catches a rename. This is the other direction, and it is the one that was missing.
//
// It is deliberately not "every backend code needs a message". Most of the ~125 do not: an
// unreachable canonicalize failure is exactly what GENERIC_BACKEND_ERROR_MESSAGE is for. What the
// generic line is *not* for is a failure the user caused and can fix, and there is nothing about a
// code's shape that distinguishes the two - so the distinction is declared here. A code added to
// error.rs for a new user-facing refusal, and not catalogued, degrades in silence to "check the app
// log file", which is how the six added alongside this test went unnoticed.
//
// Adding to this list is the deliberate act; the payoff is that forgetting the message is not.
const USER_FACING_BACKEND_CODES = [
    // Local import and the FFmpeg thumbnail preview: the user picked a file Kavynex does not take.
    "UNSUPPORTED_MEDIA_EXTENSION",
    // The yt-dlp add flow.
    "INVALID_URL",
    "INVALID_FORMAT_ID",
    "YT_DLP_NOT_FOUND",
    "YT_DLP_SELECTED_FORMAT_NOT_FOUND",
    "YT_DLP_RUN_ALREADY_ACTIVE",
    "TOO_MANY_CONCURRENT_YT_DLP_RUNS",
    "YT_DLP_DOWNLOAD_FAILED",
    "YT_DLP_DOWNLOAD_CANCELLED",
    "YT_DLP_DOWNLOAD_TIMEOUT",
    "FFMPEG_NOT_FOUND",
    // Channel and media writes the user drives directly.
    "CHANNEL_ALREADY_EXISTS",
    "VIDEO_ALREADY_EXISTS_FOR_CHANNEL",
    "INVALID_CHANNEL_NAME",
    "INVALID_YOUTUBE_HANDLE",
    "CHANNEL_NOT_FOUND",
    "MEDIA_NOT_FOUND",
    // The library folder, and files that moved out from under it.
    "INVALID_LIBRARY_PATH",
    "INVALID_LIBRARY_MIGRATION",
    "ASSET_SCOPE_RESTART_REQUIRED",
    "MEDIA_FILE_NOT_FOUND",
    "LIVE_CHAT_FILE_NOT_FOUND",
    "LIVE_CHAT_FILE_UNREADABLE",
    "TOO_MANY_CONCURRENT_LIVE_CHAT_READS",
    "THUMBNAIL_NOT_SUPPORTED_FOR_AUDIO",
    "INVALID_THUMBNAIL_FILE",
    // Settings > Database. These reach the user at the worst moment there is - the recovery flow
    // after the database failed to open - so the generic line is least acceptable here.
    "DATABASE_SCHEMA_TOO_NEW",
    "NO_DATABASE_BACKUP_AVAILABLE",
    "NO_DATABASE_IMPORT_TO_UNDO",
    "DATABASE_ALREADY_OPEN",
] as const;

describe("every user-facing backend code has a friendly message", () => {
    it.each(USER_FACING_BACKEND_CODES)("does not fall back to the generic line for %s", (code) => {
        const message = toUserFriendlyError({ code, message: "raw internal backend text" });

        expect(message).not.toContain("check the app log file");
        expect(message).not.toContain("raw internal backend text");
    });

    it("still lists a code the backend actually emits", () => {
        // Guards the list itself: a code renamed in error.rs would otherwise sit here forever,
        // asserting a friendly message for something nothing can produce.
        const rustCodes = extractRustErrorCodes(readFileSync(errorRsPath, "utf-8"));

        for (const code of USER_FACING_BACKEND_CODES) {
            expect(rustCodes.has(code), `${code} is not emitted by error.rs`).toBe(true);
        }
    });
});
