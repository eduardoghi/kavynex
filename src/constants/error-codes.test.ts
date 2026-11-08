import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { FRONTEND_ONLY_ERROR_CODES } from "./error-codes";
import { toUserFriendlyError } from "../utils/user-friendly-error";

// Every code the backend emits, read from the union ts-rs generates from the Rust enum
// (src/types/generated/AppErrorCode.ts). A Rust test holds that union to the codes the backend
// actually sends, and CI fails when the generated file is stale, so this is the backend's own list
// rather than a second reading of error.rs.
//
// error-codes.ts mirrors only a curated subset of it, the codes the frontend handles by name, and
// its `satisfies` clause already fails `tsc` for one that is not in the union or declared
// frontend-only. What a type cannot say is below.
const BACKEND_ERROR_CODES: readonly string[] = readFileSync(
    resolve(process.cwd(), "src/types/generated/AppErrorCode.ts"),
    "utf-8"
)
    .split('"')
    .filter((_, index) => index % 2 === 1);

describe("error codes stay in sync with the backend", () => {
    it("reads the backend's codes (a guard for the reading itself)", () => {
        expect(BACKEND_ERROR_CODES.length).toBeGreaterThan(100);
        expect(BACKEND_ERROR_CODES).toContain("APP_ERROR");
    });

    it("does not list a frontend-only code that the backend has started emitting", () => {
        // If this fails, the backend now emits one of these codes for real. Drop it from
        // FRONTEND_ONLY_ERROR_CODES (error-codes.ts), and the type check covers it from then on.
        const emitted = new Set(BACKEND_ERROR_CODES);

        for (const code of FRONTEND_ONLY_ERROR_CODES) {
            expect(emitted.has(code), code).toBe(false);
        }
    });
});

// The type check runs frontend -> backend. Every code the frontend claims to mirror is in the union,
// which catches a rename. This is the other direction, and it is deliberately *total*.
// Every code error.rs emits is either catalogued with a message of its own, or named below as one
// that falls back on purpose. There is no third outcome, and that is the whole point.
//
// A hand-listed set of user-facing codes would be opt-in on precisely the act it exists to
// protect. A code added to error.rs for a new user-facing refusal would only be checked once
// someone remembered to list it, and forgetting to list it degrades in silence exactly the way
// forgetting the message does. A
// partition has nothing to remember. A new Rust code fails this file until it is classified, and
// classifying it means reading the generic line and deciding whether it is the right answer.
//
// Most codes belong below, and that is not a shortcoming. An unreachable canonicalize failure, a
// temp-directory create that only fails when the disk is full. The generic line plus the backend
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

    // Creating and canonicalizing directories. The user-facing refusals of the library folder
    // (INVALID_LIBRARY_PATH, INVALID_LIBRARY_MIGRATION, LIBRARY_MIGRATION_ALREADY_RUNNING) are
    // catalogued. These are the failures underneath them, where the path was already accepted.
    "CREATE_LIBRARY_DIR_FAILED",
    "CREATE_NEW_LIBRARY_DIR_FAILED",
    "CANONICALIZE_LIBRARY_PATH_FAILED",
    "CANONICALIZE_DIRECTORY_FAILED",
    "CREATE_DIRECTORY_FAILED",
    "READ_DIR_ENTRY_FAILED",
    "INVALID_SOURCE_DIRECTORY",

    // The containment primitives in utils/path.rs. PATH_OUTSIDE_BASE_DIR is catalogued because a
    // user reaches it by picking a file outside the library. The rest are the internal steps of
    // that same check and say nothing actionable on their own.
    "INVALID_RELATIVE_PATH",
    "PATH_NOT_FOUND",
    "INVALID_TARGET_PATH",
    "CREATE_TARGET_PARENT_FAILED",
    "CANONICALIZE_BASE_DIR_FAILED",
    "CANONICALIZE_TARGET_PATH_FAILED",
    "CANONICALIZE_TARGET_PARENT_FAILED",
    "RELATIVE_PATH_RESOLVE_FAILED",

    // services/filesystem/. The atomic copy/replace primitives and the post-download file
    // matching. Every one is an I/O failure mid-operation, where the detail line (the OS error) is
    // the diagnostic and a rephrasing would add nothing.
    "INVALID_SOURCE_FILE",
    "FILE_OPEN_FAILED",
    "FILE_READ_FAILED",
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
    "CREATE_THUMBNAILS_DIR_FAILED",
    "REMOVE_THUMBNAIL_FAILED",
    // The compression step itself. The two live chat failures a user meets while opening a replay
    // (LIVE_CHAT_FILE_NOT_FOUND / _UNREADABLE) were split out of this code precisely so they could
    // be catalogued. What is left runs during the startup migration, where nothing is watching.
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
    // usable file) are catalogued. These are the mechanics of reading its pipes once it runs.
    "YT_DLP_INVALID_METADATA",
    "YT_DLP_STDOUT_CAPTURE_FAILED",
    "YT_DLP_STDERR_CAPTURE_FAILED",
    "YT_DLP_WAIT_FAILED",
]);

// Passed as the backend message so the two outcomes can be told apart. A catalogued code answers
// with its own line and must never quote this, while an internal one falls back and folds it into
// the details block.
const RAW_BACKEND_TEXT = "raw internal backend text";

describe("every backend error code is classified", () => {
    // Derived rather than written out, so the assertions below survive a rewording of the fallback.
    // The code cannot collide with a real one. error.rs has no variant named for this test.
    const genericFallback = toUserFriendlyError({
        code: "SYNTHETIC_UNCATALOGUED_CODE_FOR_THIS_TEST",
        message: "",
    });

    it("derives a generic fallback rather than a real message", () => {
        // Guards the probe itself. If this synthetic code ever resolved to something specific,
        // every assertion below would pass while checking nothing.
        expect(genericFallback).toContain("check the app log file");
    });

    it.each(BACKEND_ERROR_CODES)("resolves %s the way its classification says it does", (code) => {
        const message = toUserFriendlyError({ code, message: RAW_BACKEND_TEXT });

        if (INTERNAL_BACKEND_CODES.has(code)) {
            expect(message).toContain(genericFallback);
            return;
        }

        // A failure here for a code just added to error.rs is the check working. Either write it a
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

    it("does not name a code the backend no longer emits", () => {
        const emitted = new Set(BACKEND_ERROR_CODES);

        for (const code of INTERNAL_BACKEND_CODES) {
            expect(emitted.has(code), `${code} is not emitted by the backend`).toBe(true);
        }
    });
});
