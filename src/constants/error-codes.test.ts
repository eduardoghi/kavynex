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
// still exists, verbatim, among the backend's codes. Catching a Rust code being renamed or
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
// in Rust, which catches a rename. This is the other direction, and it is deliberately *total*:
// every code error.rs emits is either catalogued with a message of its own, or named below as one
// that falls back on purpose. There is no third outcome, and that is the whole point.
//
// It replaced a hand-listed USER_FACING_BACKEND_CODES: thirty codes asserted not to reach the
// generic line. That list was opt-in on precisely the act it existed to protect. A code added to
// error.rs for a new user-facing refusal was only checked once someone remembered to list it, and
// forgetting to list it degrades in silence exactly the way forgetting the message does. A
// partition has nothing to remember: a new Rust code fails this file until it is classified, and
// classifying it means reading the generic line and deciding whether it is the right answer.
//
// Most codes belong below, and that is not a shortcoming. An unreachable canonicalize failure, a
// temp-directory create that only fails when the disk is full: the generic line plus the backend
// detail is the right answer for those, and a bespoke message for each would be noise the user
// reads instead of a message that matters. What the generic line is NOT for is a failure the user
// caused and can fix, and nothing about a code's shape separates the two, which is why the split
// is declared here rather than inferred.
const INTERNAL_BACKEND_CODES = new Set([
    // Runtime plumbing. Reaching any of these means something failed that has no user-side cause.
    "BLOCKING_TASK_JOIN_FAILED",
    "ASSET_SCOPE_REGISTER_FAILED",
    "YT_DLP_EVENT_EMIT_FAILED",

    // Resolving Tauri's own per-OS directories. A failure here is a broken host, not a wrong click.
    "DATA_DIRECTORY_RESOLVE_FAILED",
    "CACHE_DIRECTORY_RESOLVE_FAILED",
    "CACHE_DIRECTORY_CREATE_FAILED",
    "VIDEO_DIRECTORY_RESOLVE_FAILED",

    // Creating and canonicalizing directories. The user-facing refusals of the library folder
    // (INVALID_LIBRARY_PATH, INVALID_LIBRARY_MIGRATION, LIBRARY_MIGRATION_ALREADY_RUNNING) are
    // catalogued; these are the failures underneath them, where the path was already accepted.
    "CREATE_LIBRARY_DIR_FAILED",
    "CREATE_DEFAULT_LIBRARY_DIR_FAILED",
    "CREATE_NEW_LIBRARY_DIR_FAILED",
    "CANONICALIZE_LIBRARY_PATH_FAILED",
    "CANONICALIZE_DIRECTORY_FAILED",
    "CREATE_DIRECTORY_FAILED",
    "READ_DIR_ENTRY_FAILED",
    "INVALID_SOURCE_DIRECTORY",

    // The containment primitives in utils/path.rs. PATH_OUTSIDE_BASE_DIR is catalogued because a
    // user reaches it by picking a file outside the library; the rest are the internal steps of
    // that same check and say nothing actionable on their own.
    "INVALID_RELATIVE_PATH",
    "PATH_NOT_FOUND",
    "INVALID_TARGET_PATH",
    "CREATE_BASE_DIR_FAILED",
    "CREATE_TARGET_PARENT_FAILED",
    "CANONICALIZE_BASE_DIR_FAILED",
    "CANONICALIZE_TARGET_PATH_FAILED",
    "CANONICALIZE_TARGET_PARENT_FAILED",
    "RELATIVE_PATH_RESOLVE_FAILED",

    // services/filesystem.rs: the atomic copy/replace primitives and the post-download file
    // matching. Every one is an I/O failure mid-operation, where the detail line (the OS error) is
    // the diagnostic and a rephrasing would add nothing.
    "SOURCE_FILE_NOT_FOUND",
    "INVALID_SOURCE_FILE",
    "FILE_OPEN_FAILED",
    "FILE_READ_FAILED",
    "FILE_COPY_FAILED",
    "FILE_RENAME_FAILED",
    "FILE_MOVE_FAILED",
    "SOURCE_FILE_REMOVE_FAILED",
    "SOURCE_METADATA_FAILED",
    "DESTINATION_METADATA_FAILED",
    "INVALID_DESTINATION_PATH",
    "CREATE_DESTINATION_PARENT_FAILED",
    "INVALID_DESTINATION_FILE",
    "DESTINATION_BACKUP_FAILED",
    "DESTINATION_RESTORE_FAILED",
    "MATCHING_FILE_NOT_FOUND",
    "MULTIPLE_MATCHING_FILES_FOUND",

    // Writing into and unlinking from the managed library subdirectories.
    "CREATE_MEDIA_DIR_FAILED",
    "REMOVE_MEDIA_FAILED",
    "CREATE_THUMBNAILS_DIR_FAILED",
    "REMOVE_THUMBNAIL_FAILED",
    // The compression step itself. The two live chat failures a user meets while opening a replay
    // (LIVE_CHAT_FILE_NOT_FOUND / _UNREADABLE) were split out of this code precisely so they could
    // be catalogued; what is left runs during the startup migration, where nothing is watching.
    "LIVE_CHAT_COMPRESS_FAILED",

    // The app cache directory and its scratch subdirectories. Regenerable by construction, so a
    // failure here costs a preview, never data.
    "INVALID_TEMP_DIRECTORY",
    "TEMP_DIRECTORY_READ_FAILED",
    "TEMP_DIRECTORY_ENTRY_READ_FAILED",
    "CREATE_TEMP_THUMBS_DIR_FAILED",
    "CREATE_TEMP_THUMB_ROOT_FAILED",
    "CREATE_TEMP_THUMB_DIR_FAILED",
    "CREATE_TEMP_ROOT_DIR_FAILED",
    "CREATE_TEMP_DIR_FAILED",
    "REMOVE_TEMP_THUMBNAIL_FAILED",

    // Driving the yt-dlp child process. The outcomes a user asked about (not found, cancelled,
    // failed, timed out, format gone, metadata unreadable, could not start, finished without a
    // usable file) are catalogued; these are the mechanics of reading its pipes once it runs.
    "YT_DLP_INVALID_METADATA",
    "YT_DLP_STDOUT_CAPTURE_FAILED",
    "YT_DLP_STDERR_CAPTURE_FAILED",
    "YT_DLP_WAIT_FAILED",
]);

// Passed as the backend message so the two outcomes can be told apart: a catalogued code answers
// with its own line and must never quote this, while an internal one falls back and folds it into
// the details block.
const RAW_BACKEND_TEXT = "raw internal backend text";

describe("every backend error code is classified", () => {
    const rustCodes = [...extractRustErrorCodes(readFileSync(errorRsPath, "utf-8"))];

    // Derived rather than written out, so the assertions below survive a rewording of the fallback.
    // The code cannot collide with a real one: error.rs has no variant named for this test.
    const genericFallback = toUserFriendlyError({
        code: "SYNTHETIC_UNCATALOGUED_CODE_FOR_THIS_TEST",
        message: "",
    });

    it("finds a sane number of codes in error.rs (regression guard for the extraction regex)", () => {
        expect(rustCodes.length).toBeGreaterThan(100);
    });

    it("derives a generic fallback rather than a real message", () => {
        // Guards the probe itself: if this synthetic code ever resolved to something specific,
        // every assertion below would pass while checking nothing.
        expect(genericFallback).toContain("check the app log file");
    });

    it.each(rustCodes)("resolves %s the way its classification says it does", (code) => {
        const message = toUserFriendlyError({ code, message: RAW_BACKEND_TEXT });

        if (INTERNAL_BACKEND_CODES.has(code)) {
            expect(message).toContain(genericFallback);
            return;
        }

        // A failure here for a code just added to error.rs is the check working: either write it a
        // message in utils/user-friendly-error.ts, or add it to INTERNAL_BACKEND_CODES above,
        // having decided that "check the app log file" is the right thing to tell the user.
        expect(message).not.toContain(genericFallback);
        // The raw backend message can carry a local path or an internal failure reason, so a
        // catalogued code answers in its own words rather than passing it through.
        expect(message).not.toContain(RAW_BACKEND_TEXT);
    });

    it("does not name a code that has since gained a friendly message", () => {
        // The anti-rot half. Cataloguing a code without removing it here would leave this file
        // asserting a fallback that no longer happens, which is how a stale list starts.
        for (const code of INTERNAL_BACKEND_CODES) {
            const message = toUserFriendlyError({ code, message: "" });

            expect(
                message,
                `${code} now has a friendly message; drop it from INTERNAL_BACKEND_CODES`
            ).toBe(genericFallback);
        }
    });

    it("does not name a code error.rs no longer emits", () => {
        const emitted = new Set(rustCodes);

        for (const code of INTERNAL_BACKEND_CODES) {
            expect(emitted.has(code), `${code} is not emitted by error.rs`).toBe(true);
        }
    });
});
