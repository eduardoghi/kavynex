import { describe, expect, it } from "vitest";
import {
    validateChannelId,
    validateCreateMediaInput,
    validateMediaId,
} from "./media-input-service";

describe("validateCreateMediaInput", () => {
    it("normalizes valid local input", () => {
        const result = validateCreateMediaInput({
            channelId: 10,
            title: "  Video A  ",
            sourceMode: "local",
            sourceValue: "  /tmp/video.mp4  ",
            thumbnailSourcePath: "  /tmp/thumb.jpg  ",
            mediaType: "video",
            importMode: "copy",
            libraryPath: "  /library  ",
            publishedAt: "  2026-03-31  ",
            ytDlpRunId: "",
            ytDlpFormatId: "",
            ytDlpYoutubeVideoId: null,
            downloadComments: true,
            downloadLiveChat: true,
            cookiesBrowser: "  EDGE  ",
            cookiesPath: null,
        });

        expect(result).toEqual({
            channelId: 10,
            title: "Video A",
            sourceMode: "local",
            sourceValue: "/tmp/video.mp4",
            thumbnailSourcePath: "/tmp/thumb.jpg",
            mediaType: "video",
            importMode: "copy",
            libraryPath: "/library",
            publishedAt: "2026-03-31",
            ytDlpRunId: "",
            ytDlpFormatId: "",
            ytDlpYoutubeVideoId: null,
            downloadComments: true,
            downloadLiveChat: true,
            cookiesBrowser: "edge",
            cookiesPath: null,
        });
    });

    it("normalizes nullable optional fields", () => {
        const result = validateCreateMediaInput({
            channelId: 10,
            title: "Video A",
            sourceMode: "local",
            sourceValue: "/tmp/video.mp4",
            thumbnailSourcePath: "   ",
            mediaType: "video",
            importMode: "copy",
            libraryPath: "/library",
            publishedAt: "   ",
            ytDlpRunId: "",
            ytDlpFormatId: "",
            ytDlpYoutubeVideoId: "   ",
            downloadComments: false,
            downloadLiveChat: false,
            cookiesBrowser: "   ",
            cookiesPath: null,
        });

        expect(result.thumbnailSourcePath).toBeNull();
        expect(result.publishedAt).toBeNull();
        expect(result.cookiesBrowser).toBeNull();
        expect(result.ytDlpYoutubeVideoId).toBeNull();
    });

    it("trims a resolved yt-dlp youtube video id", () => {
        const result = validateCreateMediaInput({
            channelId: 10,
            title: "Video A",
            sourceMode: "yt-dlp",
            sourceValue: "https://youtube.com/watch?v=123",
            thumbnailSourcePath: null,
            mediaType: "video",
            importMode: "copy",
            libraryPath: "/library",
            publishedAt: null,
            ytDlpRunId: "run-1",
            ytDlpFormatId: "137",
            ytDlpYoutubeVideoId: "  abc123  ",
            downloadComments: false,
            downloadLiveChat: false,
            cookiesBrowser: null,
            cookiesPath: null,
        });

        expect(result.ytDlpYoutubeVideoId).toBe("abc123");
    });

    it("requires valid channel id", () => {
        expect(() =>
            validateCreateMediaInput({
                channelId: 0,
                title: "Video A",
                sourceMode: "local",
                sourceValue: "/tmp/video.mp4",
                thumbnailSourcePath: null,
                mediaType: "video",
                importMode: "copy",
                libraryPath: "/library",
                publishedAt: null,
                ytDlpRunId: "",
                ytDlpFormatId: "",
                ytDlpYoutubeVideoId: null,
                downloadComments: false,
                downloadLiveChat: false,
                cookiesBrowser: null,
                cookiesPath: null,
            })
        ).toThrow("Channel id is invalid.");
    });

    it("requires title", () => {
        expect(() =>
            validateCreateMediaInput({
                channelId: 10,
                title: "   ",
                sourceMode: "local",
                sourceValue: "/tmp/video.mp4",
                thumbnailSourcePath: null,
                mediaType: "video",
                importMode: "copy",
                libraryPath: "/library",
                publishedAt: null,
                ytDlpRunId: "",
                ytDlpFormatId: "",
                ytDlpYoutubeVideoId: null,
                downloadComments: false,
                downloadLiveChat: false,
                cookiesBrowser: null,
                cookiesPath: null,
            })
        ).toThrow("Media title is required.");
    });

    it("requires source value", () => {
        expect(() =>
            validateCreateMediaInput({
                channelId: 10,
                title: "Video A",
                sourceMode: "local",
                sourceValue: "   ",
                thumbnailSourcePath: null,
                mediaType: "video",
                importMode: "copy",
                libraryPath: "/library",
                publishedAt: null,
                ytDlpRunId: "",
                ytDlpFormatId: "",
                ytDlpYoutubeVideoId: null,
                downloadComments: false,
                downloadLiveChat: false,
                cookiesBrowser: null,
                cookiesPath: null,
            })
        ).toThrow("Media source is required.");
    });

    it("requires library path", () => {
        expect(() =>
            validateCreateMediaInput({
                channelId: 10,
                title: "Video A",
                sourceMode: "local",
                sourceValue: "/tmp/video.mp4",
                thumbnailSourcePath: null,
                mediaType: "video",
                importMode: "copy",
                libraryPath: "   ",
                publishedAt: null,
                ytDlpRunId: "",
                ytDlpFormatId: "",
                ytDlpYoutubeVideoId: null,
                downloadComments: false,
                downloadLiveChat: false,
                cookiesBrowser: null,
                cookiesPath: null,
            })
        ).toThrow("Library path is empty.");
    });

    it("requires yt-dlp run id when source mode is yt-dlp", () => {
        expect(() =>
            validateCreateMediaInput({
                channelId: 10,
                title: "Video A",
                sourceMode: "yt-dlp",
                sourceValue: "https://youtube.com/watch?v=123",
                thumbnailSourcePath: null,
                mediaType: "video",
                importMode: "copy",
                libraryPath: "/library",
                publishedAt: null,
                ytDlpRunId: "   ",
                ytDlpFormatId: "137",
                ytDlpYoutubeVideoId: null,
                downloadComments: false,
                downloadLiveChat: false,
                cookiesBrowser: null,
                cookiesPath: null,
            })
        ).toThrow("yt-dlp run id is required.");
    });

    it("requires yt-dlp format id when source mode is yt-dlp", () => {
        expect(() =>
            validateCreateMediaInput({
                channelId: 10,
                title: "Video A",
                sourceMode: "yt-dlp",
                sourceValue: "https://youtube.com/watch?v=123",
                thumbnailSourcePath: null,
                mediaType: "video",
                importMode: "copy",
                libraryPath: "/library",
                publishedAt: null,
                ytDlpRunId: "run-1",
                ytDlpFormatId: "   ",
                ytDlpYoutubeVideoId: null,
                downloadComments: false,
                downloadLiveChat: false,
                cookiesBrowser: null,
                cookiesPath: null,
            })
        ).toThrow("yt-dlp format id is required.");
    });

    it("normalizes valid yt-dlp input", () => {
        const result = validateCreateMediaInput({
            channelId: 10,
            title: "  Video A  ",
            sourceMode: "yt-dlp",
            sourceValue: "  https://youtube.com/watch?v=123  ",
            thumbnailSourcePath: null,
            mediaType: "video",
            importMode: "copy",
            libraryPath: "  /library  ",
            publishedAt: null,
            ytDlpRunId: "  run-1  ",
            ytDlpFormatId: "  137  ",
            ytDlpYoutubeVideoId: "  123  ",
            downloadComments: 1 as unknown as boolean,
            downloadLiveChat: "" as unknown as boolean,
            cookiesBrowser: "  Firefox  ",
            cookiesPath: null,
        });

        expect(result).toEqual({
            channelId: 10,
            title: "Video A",
            sourceMode: "yt-dlp",
            sourceValue: "https://youtube.com/watch?v=123",
            thumbnailSourcePath: null,
            mediaType: "video",
            importMode: "copy",
            libraryPath: "/library",
            publishedAt: null,
            ytDlpRunId: "run-1",
            ytDlpFormatId: "137",
            ytDlpYoutubeVideoId: "123",
            downloadComments: true,
            downloadLiveChat: false,
            cookiesBrowser: "firefox",
            cookiesPath: null,
        });
    });

    it("accepts browsers added in yt-dlp extended list", () => {
        const browsers = ["safari", "vivaldi", "chrome", "chromium", "whale"];

        for (const browser of browsers) {
            const result = validateCreateMediaInput({
                channelId: 10,
                title: "Video A",
                sourceMode: "yt-dlp",
                sourceValue: "https://youtube.com/watch?v=123",
                thumbnailSourcePath: null,
                mediaType: "video",
                importMode: "copy",
                libraryPath: "/library",
                publishedAt: null,
                ytDlpRunId: "run-1",
                ytDlpFormatId: "137",
                ytDlpYoutubeVideoId: null,
                downloadComments: false,
                downloadLiveChat: false,
                cookiesBrowser: browser,
                cookiesPath: null,
            });

            expect(result.cookiesBrowser).toBe(browser);
        }
    });

    it("ignores unsupported cookies browser", () => {
        const result = validateCreateMediaInput({
            channelId: 10,
            title: "Video A",
            sourceMode: "yt-dlp",
            sourceValue: "https://youtube.com/watch?v=123",
            thumbnailSourcePath: null,
            mediaType: "video",
            importMode: "copy",
            libraryPath: "/library",
            publishedAt: null,
            ytDlpRunId: "run-1",
            ytDlpFormatId: "137",
            ytDlpYoutubeVideoId: null,
            downloadComments: false,
            downloadLiveChat: false,
            cookiesBrowser: "internet-explorer",
            cookiesPath: null,
        });

        expect(result.cookiesBrowser).toBeNull();
    });
});

describe("validateMediaId", () => {
    it("accepts valid media id", () => {
        expect(() => validateMediaId(10)).not.toThrow();
    });

    it("rejects invalid media id", () => {
        expect(() => validateMediaId(0)).toThrow("Media id is invalid.");
    });
});

describe("validateChannelId", () => {
    it("accepts valid channel id", () => {
        expect(() => validateChannelId(10)).not.toThrow();
    });

    it("rejects invalid channel id", () => {
        expect(() => validateChannelId(0)).toThrow("Channel id is invalid.");
    });
});
