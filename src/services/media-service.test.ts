import { beforeEach, describe, expect, it, vi } from "vitest";
import {
    createMedia,
    deleteMediaWithFileCleanup,
    refreshMediaComments,
    saveMediaProgress,
    setMediaUnwatched,
    setMediaWatched,
} from "./media-service";

vi.mock("../repositories", () => ({
    createMedia: vi.fn(),
    deleteMediaWithArtifacts: vi.fn(),
    listMediaCommentsByMediaId: vi.fn(),
    markMediaAsUnwatched: vi.fn(),
    markMediaAsWatched: vi.fn(),
    updateMediaDuration: vi.fn(),
    updateMediaProgress: vi.fn(),
}));

vi.mock("./media-input-service", () => ({
    validateCreateMediaInput: vi.fn(),
    validateMediaId: vi.fn(),
}));

vi.mock("./channel-input-service", () => ({
    validateChannelId: vi.fn(),
}));

vi.mock("./media-metadata-service", () => ({
    readMediaDurationInSeconds: vi.fn(),
}));

vi.mock("./media-download-service", () => ({
    fetchMediaComments: vi.fn(),
    commentsRefreshRunId: (mediaId: number) => `comments-refresh-${mediaId}`,
}));

vi.mock("../utils/app-logger", () => ({
    logError: vi.fn(),
}));

import {
    createMedia as createMediaInBackend,
    deleteMediaWithArtifacts,
    markMediaAsUnwatched,
    markMediaAsWatched,
    updateMediaDuration,
    updateMediaProgress,
} from "../repositories";
import { validateCreateMediaInput, validateMediaId } from "./media-input-service";
import { readMediaDurationInSeconds } from "./media-metadata-service";
import { fetchMediaComments } from "./media-download-service";
import { logError } from "../utils/app-logger";
import type { CreatedMedia } from "../types/generated/CreatedMedia";
import type { CreateMediaInput } from "./media-input-service";

function localInput(overrides: Partial<CreateMediaInput> = {}): CreateMediaInput {
    return {
        channelId: 10,
        title: "Video A",
        sourceMode: "local",
        sourceValue: "/tmp/a.mp4",
        thumbnailSourcePath: null,
        importMode: "copy",
        libraryPath: "/library",
        publishedAt: "2026-03-31",
        ytDlpRunId: "",
        ytDlpFormatId: "",
        ytDlpYoutubeVideoId: null,
        downloadComments: false,
        downloadLiveChat: false,
        cookiesBrowser: null,
        cookiesPath: null,
        ...overrides,
    };
}

function ytDlpInput(overrides: Partial<CreateMediaInput> = {}): CreateMediaInput {
    return localInput({
        sourceMode: "yt-dlp",
        sourceValue: "https://www.youtube.com/watch?v=abc",
        ytDlpRunId: "run-1",
        ytDlpFormatId: "137+140",
        ytDlpYoutubeVideoId: "abc",
        ...overrides,
    });
}

function created(overrides: Partial<CreatedMedia> = {}): CreatedMedia {
    return {
        id: 55,
        filePath: "video/media_a.mp4",
        thumbnailPath: "thumbnails/thumb_a.jpg",
        mediaType: "video",
        youtubeVideoId: null,
        liveChatFilePath: null,
        isLive: false,
        ...overrides,
    };
}

describe("media-service", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(readMediaDurationInSeconds).mockResolvedValue(null);
    });

    // The orchestration these tests used to cover (the duplicate pre-check, the artifact
    // preparation, the crash marker, the insert and the failure cleanup) is not in this module any
    // more. It runs in `services::media_creation` on the Rust side, and its ordering and refusals are
    // tested there. What is left here is the request this module hands over and the best-effort steps
    // it runs afterwards, so that is what is asserted.

    it("hands the whole request to the backend in one call", async () => {
        const input = ytDlpInput();
        vi.mocked(validateCreateMediaInput).mockReturnValueOnce(input);
        vi.mocked(createMediaInBackend).mockResolvedValueOnce(created({ youtubeVideoId: "abc" }));

        await expect(createMedia(input)).resolves.toMatchObject({ id: 55 });

        // Every field the creation needs, and nothing this side invented. `downloadComments` stays
        // here because the comment backup runs after the row lands, not inside the creation.
        expect(createMediaInBackend).toHaveBeenCalledWith({
            channelId: 10,
            title: "Video A",
            sourceMode: "yt-dlp",
            sourceValue: "https://www.youtube.com/watch?v=abc",
            thumbnailSourcePath: null,
            importMode: "copy",
            publishedAt: "2026-03-31",
            ytDlpRunId: "run-1",
            ytDlpFormatId: "137+140",
            ytDlpYoutubeVideoId: "abc",
            downloadLiveChat: false,
            cookiesBrowser: null,
            cookiesPath: null,
        });
    });

    it("sends the normalized input rather than the raw one", async () => {
        // validateCreateMediaInput trims and normalizes; sending the caller's object instead would
        // put padded values on the wire, where they would be validated in one form and stored in
        // another.
        const raw = localInput({ title: "  Video A  " });
        const normalized = localInput({ title: "Video A" });

        vi.mocked(validateCreateMediaInput).mockReturnValueOnce(normalized);
        vi.mocked(createMediaInBackend).mockResolvedValueOnce(created());

        await createMedia(raw);

        expect(validateCreateMediaInput).toHaveBeenCalledWith(raw);
        expect(createMediaInBackend).toHaveBeenCalledWith(
            expect.objectContaining({ title: "Video A" })
        );
    });

    it("does not create anything when validation rejects the input", async () => {
        vi.mocked(validateCreateMediaInput).mockImplementationOnce(() => {
            throw new Error("Media title is required.");
        });

        await expect(createMedia(localInput())).rejects.toThrow("Media title is required.");
        expect(createMediaInBackend).not.toHaveBeenCalled();
    });

    it("propagates a backend failure without cleaning anything up itself", async () => {
        // The failure unwinds inside the backend, artifacts and all, so this side must not attempt
        // its own cleanup. Doing so was what made the sequence a distributed transaction.
        const input = ytDlpInput();
        vi.mocked(validateCreateMediaInput).mockReturnValueOnce(input);
        vi.mocked(createMediaInBackend).mockRejectedValueOnce(
            new Error("this media is already registered for the selected channel")
        );

        await expect(createMedia(input)).rejects.toThrow("already registered");
        expect(updateMediaDuration).not.toHaveBeenCalled();
        expect(fetchMediaComments).not.toHaveBeenCalled();
    });

    it("measures the created media and stores the duration afterwards", async () => {
        const input = localInput();
        vi.mocked(validateCreateMediaInput).mockReturnValueOnce(input);
        vi.mocked(createMediaInBackend).mockResolvedValueOnce(created());
        vi.mocked(readMediaDurationInSeconds).mockResolvedValueOnce(125);

        await createMedia(input);

        // Probed at the stored path the backend answered with, not at the source the user picked.
        expect(readMediaDurationInSeconds).toHaveBeenCalledWith(
            "video/media_a.mp4",
            "/library",
            "video"
        );
        expect(updateMediaDuration).toHaveBeenCalledWith(55, 125);
    });

    it("skips the duration write when the file could not be measured", async () => {
        // A probe that cannot read the file resolves null, which is the ordinary outcome for an
        // exotic container. Writing it back would cost a round trip to store what the column
        // already holds.
        const input = localInput();
        vi.mocked(validateCreateMediaInput).mockReturnValueOnce(input);
        vi.mocked(createMediaInBackend).mockResolvedValueOnce(created());
        vi.mocked(readMediaDurationInSeconds).mockResolvedValueOnce(null);

        await createMedia(input);

        expect(updateMediaDuration).not.toHaveBeenCalled();
    });

    it("still reports the created media when the duration step fails", async () => {
        // The media is registered by then, so a failed measurement is a card without a runtime.
        // never a failed import, and never something the user is shown an error for.
        const input = localInput();
        vi.mocked(validateCreateMediaInput).mockReturnValueOnce(input);
        vi.mocked(createMediaInBackend).mockResolvedValueOnce(created());
        vi.mocked(readMediaDurationInSeconds).mockRejectedValueOnce(new Error("decode failed"));

        await expect(createMedia(input)).resolves.toMatchObject({ id: 55 });

        expect(logError).toHaveBeenCalledWith(
            "media-service",
            expect.stringContaining("duration"),
            expect.anything(),
            { mediaId: 55 }
        );
    });

    it("has the backend fetch and store the comments of a yt-dlp media when asked", async () => {
        const input = ytDlpInput({ downloadComments: true });
        vi.mocked(validateCreateMediaInput).mockReturnValueOnce(input);
        vi.mocked(createMediaInBackend).mockResolvedValueOnce(created({ youtubeVideoId: "abc" }));
        vi.mocked(fetchMediaComments).mockResolvedValueOnce({ fetched: 3, stored: 3 });

        const messages: string[] = [];
        await createMedia(input, { onProgress: (message) => void messages.push(message) });

        // The video id comes off the created media rather than the request. For a yt-dlp source the
        // backend resolved it from the download, which is the authoritative one.
        expect(fetchMediaComments).toHaveBeenCalledWith(55, "abc", null, null, undefined);
        expect(messages).toContain("Comments saved: 3");
    });

    it("tells the caller when the comment backup failed", async () => {
        // The media stays registered. The outcome is what lets the add-media flow say so once its
        // modal, the only other place the failure shows, has closed.
        const input = ytDlpInput({ downloadComments: true });
        vi.mocked(validateCreateMediaInput).mockReturnValueOnce(input);
        vi.mocked(createMediaInBackend).mockResolvedValueOnce(created({ youtubeVideoId: "abc" }));
        vi.mocked(fetchMediaComments).mockRejectedValueOnce({
            code: "YT_DLP_COMMENTS_FAILED",
            message: "rate limited",
        });

        await expect(createMedia(input)).resolves.toEqual({ id: 55, comments: "failed" });
    });

    it("says no comments came back when the fetch returned none", async () => {
        const input = ytDlpInput({ downloadComments: true });
        vi.mocked(validateCreateMediaInput).mockReturnValueOnce(input);
        vi.mocked(createMediaInBackend).mockResolvedValueOnce(created({ youtubeVideoId: "abc" }));
        vi.mocked(fetchMediaComments).mockResolvedValueOnce({ fetched: 0, stored: 0 });

        const messages: string[] = [];
        await createMedia(input, { onProgress: (message) => void messages.push(message) });

        expect(messages).toContain("No public comments were returned for this media.");
    });

    it("registers the comment backup under the run id it was given and says while it runs", async () => {
        const input = ytDlpInput({ downloadComments: true });
        vi.mocked(validateCreateMediaInput).mockReturnValueOnce(input);
        vi.mocked(createMediaInBackend).mockResolvedValueOnce(created({ youtubeVideoId: "abc" }));

        const fetching: boolean[] = [];
        const onCommentsFetchChange = vi.fn((value: boolean) => void fetching.push(value));
        vi.mocked(fetchMediaComments).mockImplementationOnce(async () => {
            // Still running here, which is when the caller's Cancel has to reach it.
            expect(fetching).toEqual([true]);
            return { fetched: 0, stored: 0 };
        });

        await createMedia(input, { commentsRunId: "comments-run", onCommentsFetchChange });

        expect(fetchMediaComments).toHaveBeenCalledWith(55, "abc", null, null, "comments-run");
        expect(fetching).toEqual([true, false]);
    });

    it("keeps the media and says so when the user skips the comments", async () => {
        const input = ytDlpInput({ downloadComments: true });
        vi.mocked(validateCreateMediaInput).mockReturnValueOnce(input);
        vi.mocked(createMediaInBackend).mockResolvedValueOnce(created({ youtubeVideoId: "abc" }));
        vi.mocked(fetchMediaComments).mockRejectedValueOnce({
            code: "YT_DLP_DOWNLOAD_CANCELLED",
            message: "yt-dlp download cancelled",
        });

        const messages: string[] = [];
        const onCommentsFetchChange = vi.fn();
        await expect(
            createMedia(input, {
                onProgress: (message) => void messages.push(message),
                onCommentsFetchChange,
            })
        ).resolves.toEqual({ id: 55, comments: "skipped" });

        expect(messages).toContain("Comments skipped. The media was added without them.");
        expect(messages).not.toContain("Failed to fetch comments. Import will continue without them.");
        expect(onCommentsFetchChange).toHaveBeenLastCalledWith(false);
        // Asked for, so not a failure worth a log entry.
        expect(logError).not.toHaveBeenCalled();
    });

    it("skips the comment backup when the user turned it off", async () => {
        const input = ytDlpInput({ downloadComments: false });
        vi.mocked(validateCreateMediaInput).mockReturnValueOnce(input);
        vi.mocked(createMediaInBackend).mockResolvedValueOnce(created({ youtubeVideoId: "abc" }));

        await createMedia(input);

        expect(fetchMediaComments).not.toHaveBeenCalled();
    });

    it("does not fetch comments for a local import", async () => {
        const input = localInput({ downloadComments: true });
        vi.mocked(validateCreateMediaInput).mockReturnValueOnce(input);
        vi.mocked(createMediaInBackend).mockResolvedValueOnce(created());

        await createMedia(input);

        expect(fetchMediaComments).not.toHaveBeenCalled();
    });

    it("still reports the created media when the comment backup fails", async () => {
        const input = ytDlpInput({ downloadComments: true });
        vi.mocked(validateCreateMediaInput).mockReturnValueOnce(input);
        vi.mocked(createMediaInBackend).mockResolvedValueOnce(created({ youtubeVideoId: "abc" }));
        vi.mocked(fetchMediaComments).mockRejectedValueOnce(new Error("extraction incomplete"));

        await expect(createMedia(input)).resolves.toMatchObject({ id: 55 });
    });

    it("reports progress around the creation", async () => {
        const input = ytDlpInput({ downloadComments: false, downloadLiveChat: true });
        vi.mocked(validateCreateMediaInput).mockReturnValueOnce(input);
        vi.mocked(createMediaInBackend).mockResolvedValueOnce(
            created({ liveChatFilePath: "live_chat/a.live_chat.json.gz" })
        );

        const messages: string[] = [];
        await createMedia(input, { onProgress: (message) => void messages.push(message) });

        // Comments before live chat, matching the order the two steps run in. The terminal reads
        // as a transcript of the run, so the sequence is part of what is asserted, not just the set.
        expect(messages).toEqual([
            "Registering media in local library...",
            "Media registered successfully.",
            "Skipping comments because the user disabled them.",
            "Live chat replay saved successfully.",
        ]);
    });

    it("says so when a live chat replay was asked for but not found", async () => {
        const input = ytDlpInput({ downloadComments: false, downloadLiveChat: true });
        vi.mocked(validateCreateMediaInput).mockReturnValueOnce(input);
        vi.mocked(createMediaInBackend).mockResolvedValueOnce(created({ liveChatFilePath: null }));

        const messages: string[] = [];
        await createMedia(input, { onProgress: (message) => void messages.push(message) });

        expect(messages).toContain("Live chat replay was not found for this media.");
    });

    it("deletes media through the atomic backend command without logging when nothing failed", async () => {
        vi.mocked(validateMediaId).mockImplementationOnce(() => {});
        vi.mocked(deleteMediaWithArtifacts).mockResolvedValueOnce({
            deleted_paths: ["video/a.mp4", "thumbnails/a.jpg"],
            skipped_shared_paths: [],
            failed_paths: [],
        });

        await expect(deleteMediaWithFileCleanup(10)).resolves.toBe(0);

        expect(validateMediaId).toHaveBeenCalledWith(10);
        expect(deleteMediaWithArtifacts).toHaveBeenCalledWith(10);
        expect(logError).not.toHaveBeenCalled();
    });

    it("logs an orphan warning when the backend reports files it could not delete", async () => {
        vi.mocked(validateMediaId).mockImplementationOnce(() => {});
        vi.mocked(deleteMediaWithArtifacts).mockResolvedValueOnce({
            deleted_paths: [],
            skipped_shared_paths: [],
            failed_paths: ["video/a.mp4"],
        });

        await expect(deleteMediaWithFileCleanup(10)).resolves.toBe(1);

        expect(logError).toHaveBeenCalledWith(
            "media-service",
            expect.stringContaining("orphaned"),
            null,
            { mediaId: 10, failedPaths: ["video/a.mp4"] }
        );
    });

    it("rejects an invalid media id without calling the repository", async () => {
        vi.mocked(validateMediaId).mockImplementationOnce(() => {
            throw new Error("Media id is invalid.");
        });

        await expect(deleteMediaWithFileCleanup(0)).rejects.toThrow("Media id is invalid.");

        expect(deleteMediaWithArtifacts).not.toHaveBeenCalled();
    });

    it("marks media as watched and returns the persisted timestamp", async () => {
        vi.mocked(validateMediaId).mockImplementationOnce(() => {});
        vi.mocked(markMediaAsWatched).mockResolvedValueOnce("2026-07-11 12:00:00");

        const watchedAt = await setMediaWatched(10);

        expect(validateMediaId).toHaveBeenCalledWith(10);
        expect(markMediaAsWatched).toHaveBeenCalledWith(10);
        expect(watchedAt).toBe("2026-07-11 12:00:00");
    });

    it("refreshes comments through the backend", async () => {
        vi.mocked(validateMediaId).mockImplementationOnce(() => {});
        vi.mocked(fetchMediaComments).mockResolvedValueOnce({ fetched: 1, stored: 1 });

        const result = await refreshMediaComments(10, "abc", "edge");

        expect(fetchMediaComments).toHaveBeenCalledWith(
            10,
            "abc",
            "edge",
            null,
            "comments-refresh-10"
        );
        expect(result).toEqual({ updated: true, totalComments: 1 });
    });

    it("reports what the media holds after the merge rather than what the refresh fetched", async () => {
        // The merge keeps comments saved earlier that this fetch no longer found, so the stored
        // count is larger than the fetched one. Reporting the fetched count would put a number on
        // the card that the player's own list contradicts.
        vi.mocked(validateMediaId).mockImplementationOnce(() => {});
        vi.mocked(fetchMediaComments).mockResolvedValueOnce({ fetched: 1, stored: 4800 });

        const result = await refreshMediaComments(10, "abc", null);

        expect(result).toEqual({ updated: true, totalComments: 4800 });
    });

    it("reports no update when the refresh returns none", async () => {
        // A genuinely empty result is not an error. The backend has already recorded it without
        // touching the saved comments, so this only has to tell the caller nothing changed.
        vi.mocked(validateMediaId).mockImplementationOnce(() => {});
        vi.mocked(fetchMediaComments).mockResolvedValueOnce({ fetched: 0, stored: 12 });

        const result = await refreshMediaComments(10, "abc", null);

        expect(result).toEqual({ updated: false, totalComments: 0 });
    });

    it("propagates a real fetch failure from refresh", async () => {
        vi.mocked(validateMediaId).mockImplementationOnce(() => {});
        vi.mocked(fetchMediaComments).mockRejectedValueOnce(new Error("extraction incomplete"));

        await expect(refreshMediaComments(10, "abc", null)).rejects.toThrow(
            "extraction incomplete"
        );
    });

    it("marks media as unwatched", async () => {
        vi.mocked(validateMediaId).mockImplementationOnce(() => {});
        vi.mocked(markMediaAsUnwatched).mockResolvedValueOnce(undefined);

        await setMediaUnwatched(10);

        expect(validateMediaId).toHaveBeenCalledWith(10);
        expect(markMediaAsUnwatched).toHaveBeenCalledWith(10);
    });

    it("saves media progress with sanitized integer value", async () => {
        vi.mocked(validateMediaId).mockImplementationOnce(() => {});
        vi.mocked(updateMediaProgress).mockResolvedValueOnce(undefined);

        await saveMediaProgress(10, 42.9);

        expect(validateMediaId).toHaveBeenCalledWith(10);
        expect(updateMediaProgress).toHaveBeenCalledWith(10, 42);
    });

    it("saves media progress with minimum zero", async () => {
        vi.mocked(validateMediaId).mockImplementationOnce(() => {});
        vi.mocked(updateMediaProgress).mockResolvedValueOnce(undefined);

        await saveMediaProgress(10, -15);

        expect(validateMediaId).toHaveBeenCalledWith(10);
        expect(updateMediaProgress).toHaveBeenCalledWith(10, 0);
    });
});
