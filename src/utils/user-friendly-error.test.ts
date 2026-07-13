import { describe, expect, it } from "vitest";
import { resolveErrorMessage, toUserFriendlyError } from "./user-friendly-error";
import { ClientError } from "./app-error";
import {
    APP_ERROR_CODE,
    CLIENT_ERROR_CODE,
    MEDIA_NOT_FOUND_ERROR_CODE,
    DATABASE_SCHEMA_TOO_NEW_ERROR_CODE,
    INVALID_INPUT_ERROR_CODE,
    INVALID_URL_ERROR_CODE,
    INVALID_RUN_ID_ERROR_CODE,
    INVALID_FORMAT_ID_ERROR_CODE,
    INVALID_DIRECTORY_PATH_ERROR_CODE,
    INVALID_LIBRARY_PATH_ERROR_CODE,
    INVALID_LIBRARY_MIGRATION_ERROR_CODE,
    INVALID_MEDIA_PATH_ERROR_CODE,
    INVALID_THUMBNAIL_PATH_ERROR_CODE,
    INVALID_TEMP_THUMBNAIL_PATH_ERROR_CODE,
    INVALID_SOURCE_MEDIA_ERROR_CODE,
    SOURCE_MEDIA_NOT_FOUND_ERROR_CODE,
    INVALID_SOURCE_THUMBNAIL_ERROR_CODE,
    SOURCE_THUMBNAIL_NOT_FOUND_ERROR_CODE,
    INVALID_THUMBNAIL_FILE_ERROR_CODE,
    THUMBNAIL_NOT_SUPPORTED_FOR_AUDIO_ERROR_CODE,
    CHANNEL_ALREADY_EXISTS_ERROR_CODE,
    INVALID_YOUTUBE_HANDLE_ERROR_CODE,
    INVALID_CHANNEL_NAME_ERROR_CODE,
    INVALID_MEDIA_CREATION_ARGUMENTS_ERROR_CODE,
    MEDIA_IMPORT_FAILED_ERROR_CODE,
    VIDEO_ALREADY_EXISTS_FOR_CHANNEL_ERROR_CODE,
    YT_DLP_NOT_FOUND_ERROR_CODE,
    YT_DLP_METADATA_TIMEOUT_ERROR_CODE,
    YT_DLP_METADATA_FAILED_ERROR_CODE,
    YT_DLP_DOWNLOAD_TIMEOUT_ERROR_CODE,
    YT_DLP_DOWNLOAD_FAILED_ERROR_CODE,
    YT_DLP_DOWNLOAD_CANCELLED_ERROR_CODE,
    YT_DLP_THUMBNAIL_TIMEOUT_ERROR_CODE,
    YT_DLP_THUMBNAIL_FAILED_ERROR_CODE,
    FFMPEG_NOT_FOUND_ERROR_CODE,
    FFMPEG_FAILED_ERROR_CODE,
    FFMPEG_EXEC_FAILED_ERROR_CODE,
    DESTINATION_ALREADY_EXISTS_ERROR_CODE,
    PATH_OUTSIDE_BASE_DIR_ERROR_CODE,
} from "../constants/error-codes";

// The friendly copy IS the observable behavior of this module, so every catalogued
// code is asserted against its exact message. The raw backend message is always
// different from the friendly one so a broken mapping cannot hide behind the
// message fallback.
const GENERIC_BACKEND_MESSAGE = "The operation could not be completed. Check the logs for details.";

const FRIENDLY_MESSAGE_CASES: Array<[code: string, friendlyMessage: string]> = [
    [INVALID_INPUT_ERROR_CODE, "Invalid input."],

    [
        DATABASE_SCHEMA_TOO_NEW_ERROR_CODE,
        "This database was created by a newer version of Kavynex. Update the app and try again.",
    ],
    ["DATABASE_IMPORT_INVALID", "The selected file is not a valid Kavynex database."],

    [INVALID_URL_ERROR_CODE, "Enter a valid media URL."],
    [INVALID_RUN_ID_ERROR_CODE, "The download session is invalid."],
    [INVALID_FORMAT_ID_ERROR_CODE, "Choose a valid format before continuing."],

    [INVALID_DIRECTORY_PATH_ERROR_CODE, "Choose a valid folder."],
    [INVALID_LIBRARY_PATH_ERROR_CODE, "Configure a valid library folder before continuing."],
    [INVALID_LIBRARY_MIGRATION_ERROR_CODE, "The selected library migration path is not valid."],
    [INVALID_MEDIA_PATH_ERROR_CODE, "The selected media item is invalid."],
    [INVALID_THUMBNAIL_PATH_ERROR_CODE, "The selected thumbnail is invalid."],
    [INVALID_TEMP_THUMBNAIL_PATH_ERROR_CODE, "The temporary thumbnail is invalid."],

    [INVALID_SOURCE_MEDIA_ERROR_CODE, "Select a valid media file."],
    [SOURCE_MEDIA_NOT_FOUND_ERROR_CODE, "The selected media file was not found."],
    [INVALID_SOURCE_THUMBNAIL_ERROR_CODE, "Select a valid thumbnail image."],
    [SOURCE_THUMBNAIL_NOT_FOUND_ERROR_CODE, "The selected thumbnail image was not found."],
    [INVALID_THUMBNAIL_FILE_ERROR_CODE, "Choose a valid thumbnail image file."],
    [
        THUMBNAIL_NOT_SUPPORTED_FOR_AUDIO_ERROR_CODE,
        "Automatic thumbnail generation is not available for audio files.",
    ],

    [INVALID_CHANNEL_NAME_ERROR_CODE, "Enter a valid channel name."],
    [INVALID_YOUTUBE_HANDLE_ERROR_CODE, "Enter a valid YouTube handle."],
    [CHANNEL_ALREADY_EXISTS_ERROR_CODE, "A channel with this YouTube handle already exists."],

    [INVALID_MEDIA_CREATION_ARGUMENTS_ERROR_CODE, "Invalid media creation arguments."],
    [MEDIA_IMPORT_FAILED_ERROR_CODE, "The media import failed."],
    [
        VIDEO_ALREADY_EXISTS_FOR_CHANNEL_ERROR_CODE,
        "This media is already registered for the selected channel.",
    ],

    [
        YT_DLP_NOT_FOUND_ERROR_CODE,
        "yt-dlp was not found. Install yt-dlp or place the binary in the app tools folder.",
    ],
    [YT_DLP_METADATA_TIMEOUT_ERROR_CODE, "Timed out while loading media information from yt-dlp."],
    [YT_DLP_METADATA_FAILED_ERROR_CODE, "yt-dlp could not load media information for this URL."],
    [YT_DLP_DOWNLOAD_TIMEOUT_ERROR_CODE, "The media download took too long and was interrupted."],
    [YT_DLP_DOWNLOAD_FAILED_ERROR_CODE, "The media download failed."],
    [YT_DLP_DOWNLOAD_CANCELLED_ERROR_CODE, "The media download was cancelled."],
    [YT_DLP_THUMBNAIL_TIMEOUT_ERROR_CODE, "Timed out while downloading the thumbnail."],
    [YT_DLP_THUMBNAIL_FAILED_ERROR_CODE, "The thumbnail download failed."],

    [
        FFMPEG_NOT_FOUND_ERROR_CODE,
        "ffmpeg was not found. Install ffmpeg or place the binary in the app tools folder.",
    ],
    [FFMPEG_EXEC_FAILED_ERROR_CODE, "ffmpeg could not be started."],
    [FFMPEG_FAILED_ERROR_CODE, "ffmpeg could not process the media file."],

    [DESTINATION_ALREADY_EXISTS_ERROR_CODE, "A file with the same destination already exists."],
    [
        PATH_OUTSIDE_BASE_DIR_ERROR_CODE,
        "The selected file path is outside the allowed library folder.",
    ],

    ["READ_DIR_FAILED", "Could not read the selected folder."],
    ["CREATE_DIR_FAILED", "Could not create the selected folder."],
    ["OPEN_DIR_FAILED", "Could not open the selected folder."],
    ["OPEN_PATH_FAILED", "Could not open the selected path."],
    ["WRITE_FILE_FAILED", "Could not write the file."],
    ["DELETE_FILE_FAILED", "Could not delete the file."],
];

describe("toUserFriendlyError", () => {
    it("maps every catalogued error code to its exact friendly message", () => {
        for (const [code, friendlyMessage] of FRIENDLY_MESSAGE_CASES) {
            expect(
                toUserFriendlyError({
                    code,
                    message: "raw backend failure",
                })
            ).toBe(friendlyMessage);
        }
    });

    it("maps APP_ERROR to the generic unknown error message", () => {
        expect(
            toUserFriendlyError({
                code: APP_ERROR_CODE,
                message: "raw backend failure",
            })
        ).toBe("Unknown error.");
    });

    it("shows a CLIENT_ERROR message verbatim (a frontend-authored user-facing error)", () => {
        expect(
            toUserFriendlyError({
                code: CLIENT_ERROR_CODE,
                message: "The selected folder must be empty before it can be used as the library folder.",
            })
        ).toBe("The selected folder must be empty before it can be used as the library folder.");
    });

    it("falls back to the unknown message for a CLIENT_ERROR with a blank message", () => {
        expect(
            toUserFriendlyError({
                code: CLIENT_ERROR_CODE,
                message: "   ",
            })
        ).toBe("Unknown error.");
    });

    it("maps MEDIA_NOT_FOUND to its friendly message", () => {
        expect(
            toUserFriendlyError({
                code: MEDIA_NOT_FOUND_ERROR_CODE,
                message: "the media no longer exists",
            })
        ).toBe("This media no longer exists. It may have been removed while the operation was running.");
    });

    it("returns a thrown ClientError's message rather than the caller fallback", () => {
        expect(
            resolveErrorMessage(
                new ClientError("Please choose a valid .txt cookies file."),
                "Failed to select cookies file."
            )
        ).toBe("Please choose a valid .txt cookies file.");
    });

    it("maps YT_DLP_NOT_FOUND correctly", () => {
        expect(
            toUserFriendlyError({
                code: YT_DLP_NOT_FOUND_ERROR_CODE,
                message: "yt-dlp missing",
            })
        ).toBe(
            "yt-dlp was not found. Install yt-dlp or place the binary in the app tools folder."
        );
    });

    it("maps INVALID_LIBRARY_PATH correctly", () => {
        expect(
            toUserFriendlyError({
                code: INVALID_LIBRARY_PATH_ERROR_CODE,
                message: "library path is empty",
            })
        ).toBe("Configure a valid library folder before continuing.");
    });

    it("maps INVALID_LIBRARY_MIGRATION correctly", () => {
        expect(
            toUserFriendlyError({
                code: INVALID_LIBRARY_MIGRATION_ERROR_CODE,
                message: "new library path cannot be inside the current library path",
            })
        ).toBe("The selected library migration path is not valid.");
    });

    it("maps INVALID_MEDIA_CREATION_ARGUMENTS correctly", () => {
        expect(
            toUserFriendlyError({
                code: INVALID_MEDIA_CREATION_ARGUMENTS_ERROR_CODE,
                message: "Invalid media creation arguments.",
            })
        ).toBe("Invalid media creation arguments.");
    });

    it("maps raw filesystem code correctly", () => {
        expect(
            toUserFriendlyError({
                code: "READ_DIR_FAILED",
                message: "failed to read directory",
            })
        ).toBe("Could not read the selected folder.");
    });

    it("degrades an uncatalogued backend code to a generic message with the raw text kept in details", () => {
        expect(
            toUserFriendlyError({
                code: "SOMETHING_ELSE",
                message: "Custom backend failure",
            })
        ).toBe(`${GENERIC_BACKEND_MESSAGE}\n\nDetails: Custom backend failure`);
    });

    it("shows only the generic message for an uncatalogued backend code with no message", () => {
        expect(
            toUserFriendlyError({
                code: "SOMETHING_ELSE",
                message: "",
            })
        ).toBe(GENERIC_BACKEND_MESSAGE);
    });

    it("appends details to a mapped friendly message", () => {
        expect(
            toUserFriendlyError({
                code: "READ_DIR_FAILED",
                message: "failed to read directory",
                details: "Permission denied on /media/library",
            })
        ).toBe(
            "Could not read the selected folder.\n\nDetails: Permission denied on /media/library"
        );
    });

    it("folds the raw message and details together for an uncatalogued backend code", () => {
        expect(
            toUserFriendlyError({
                code: "SOMETHING_ELSE",
                message: "Custom backend failure",
                details: "socket closed unexpectedly",
            })
        ).toBe(
            `${GENERIC_BACKEND_MESSAGE}\n\nDetails: Custom backend failure - socket closed unexpectedly`
        );
    });

    it("still passes through the raw message for a non-backend-shaped code", () => {
        // A lowercase / non-SCREAMING_SNAKE code is never produced by the backend, so the raw
        // message is the best available human text and is shown as-is.
        expect(
            toUserFriendlyError({
                code: "custom-thing",
                message: "Custom backend failure",
            })
        ).toBe("Custom backend failure");
    });

    it("does not append details when the resolved message is the unknown default", () => {
        expect(
            toUserFriendlyError({
                code: APP_ERROR_CODE,
                message: "raw backend failure",
                details: "socket closed unexpectedly",
            })
        ).toBe("Unknown error.");
    });

    it("does not append details that equal the resolved message ignoring case", () => {
        expect(
            toUserFriendlyError({
                code: "READ_DIR_FAILED",
                message: "failed to read directory",
                details: "COULD NOT READ THE SELECTED FOLDER.",
            })
        ).toBe("Could not read the selected folder.");
    });

    it("does not append details that start with the resolved message", () => {
        expect(
            toUserFriendlyError({
                code: "READ_DIR_FAILED",
                message: "failed to read directory",
                details: "Could not read the selected folder. The path no longer exists.",
            })
        ).toBe("Could not read the selected folder.");
    });

    it("appends details that merely contain the resolved message later on", () => {
        expect(
            toUserFriendlyError({
                code: "READ_DIR_FAILED",
                message: "failed to read directory",
                details: "OS said: could not read the selected folder.",
            })
        ).toBe(
            "Could not read the selected folder.\n\nDetails: OS said: could not read the selected folder."
        );
    });
});

describe("resolveErrorMessage", () => {
    it("returns friendly mapped message when available", () => {
        expect(
            resolveErrorMessage(
                {
                    code: "READ_DIR_FAILED",
                    message: "failed to read directory",
                },
                "Fallback message"
            )
        ).toBe("Could not read the selected folder.");
    });

    it("returns the resolved message with details instead of the fallback", () => {
        expect(
            resolveErrorMessage(
                {
                    code: "READ_DIR_FAILED",
                    message: "failed to read directory",
                    details: "Disk is offline",
                },
                "Fallback message"
            )
        ).toBe("Could not read the selected folder.\n\nDetails: Disk is offline");
    });

    it("returns fallback when only unknown default message exists", () => {
        expect(resolveErrorMessage(123, "Fallback message")).toBe("Fallback message");
    });

    it("returns fallback when the error resolves to the default even with details", () => {
        expect(
            resolveErrorMessage(
                {
                    code: APP_ERROR_CODE,
                    message: "raw backend failure",
                    details: "socket closed unexpectedly",
                },
                "Fallback message"
            )
        ).toBe("Fallback message");
    });

    it("trims the fallback message", () => {
        expect(resolveErrorMessage(123, "  Fallback message  ")).toBe("Fallback message");
    });

    it("returns the generic unknown error when the fallback is blank", () => {
        expect(resolveErrorMessage(123, "   ")).toBe("Unknown error.");
    });

    it("returns the generic message (not the fallback) for an uncatalogued backend code", () => {
        expect(
            resolveErrorMessage(
                {
                    code: "CUSTOM_ERROR",
                    message: "Something custom happened",
                },
                "Fallback message"
            )
        ).toBe(`${GENERIC_BACKEND_MESSAGE}\n\nDetails: Something custom happened`);
    });

    it("keeps the raw backend message in the details of the generic fallback", () => {
        expect(
            resolveErrorMessage(
                {
                    code: "SOMETHING_CUSTOM",
                    message: "failed to open directory",
                },
                "Fallback message"
            )
        ).toBe(`${GENERIC_BACKEND_MESSAGE}\n\nDetails: failed to open directory`);
    });
});
