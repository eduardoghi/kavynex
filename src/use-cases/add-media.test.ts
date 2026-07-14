import { describe, expect, it } from "vitest";
import {
    buildCreateMediaInput,
    buildYtDlpCommandPreview,
    resolveCookiesSource,
    validateAddMediaForm,
    type AddMediaFormFields,
} from "./add-media";

function form(overrides: Partial<AddMediaFormFields> = {}): AddMediaFormFields {
    return {
        sourceMode: "local",
        mediaUrl: "",
        mediaPath: "",
        title: "",
        thumbPath: "",
        mediaType: "video",
        selectedYtDlpFormatId: "",
        selectedYtDlpMediaType: "video",
        resolvedYoutubeVideoId: null,
        publishedAt: "",
        downloadComments: false,
        downloadLiveChat: false,
        cookiesBrowser: "",
        cookiesPath: "",
        isGeneratingThumb: false,
        isLoadingYtDlpFormats: false,
        ...overrides,
    };
}

const notBusy = { isCancellingYtDlp: false, isYtDlpRunning: false };

describe("validateAddMediaForm", () => {
    it("errors when no channel is selected", () => {
        expect(validateAddMediaForm(form(), null, notBusy)).toEqual({
            status: "error",
            message: "Select a channel before adding media.",
        });
    });

    it("skips silently while a preparation or download is in flight", () => {
        expect(
            validateAddMediaForm(form({ isGeneratingThumb: true }), 1, notBusy)
        ).toEqual({ status: "skip" });
        expect(validateAddMediaForm(form(), 1, { ...notBusy, isYtDlpRunning: true })).toEqual({
            status: "skip",
        });
    });

    it("errors when the local source is empty", () => {
        const result = validateAddMediaForm(form({ sourceMode: "local", mediaPath: "  " }), 1, notBusy);
        expect(result).toEqual({
            status: "error",
            message: "Select a media file before continuing.",
        });
    });

    it("errors when the yt-dlp url is empty or no format is chosen", () => {
        expect(validateAddMediaForm(form({ sourceMode: "yt-dlp", mediaUrl: "" }), 1, notBusy)).toEqual({
            status: "error",
            message: "Enter a media URL before continuing.",
        });
        expect(
            validateAddMediaForm(
                form({ sourceMode: "yt-dlp", mediaUrl: "https://youtu.be/x", selectedYtDlpFormatId: "" }),
                1,
                notBusy
            )
        ).toEqual({
            status: "error",
            message: "Load the available formats and choose one before continuing.",
        });
    });

    it("returns ok with the trimmed resolved source", () => {
        expect(
            validateAddMediaForm(form({ sourceMode: "local", mediaPath: "  /a/b.mp4  " }), 1, notBusy)
        ).toEqual({ status: "ok", sourceMode: "local", sourceValue: "/a/b.mp4" });
        expect(
            validateAddMediaForm(
                form({
                    sourceMode: "yt-dlp",
                    mediaUrl: "  https://youtu.be/x ",
                    selectedYtDlpFormatId: "137",
                }),
                1,
                notBusy
            )
        ).toEqual({ status: "ok", sourceMode: "yt-dlp", sourceValue: "https://youtu.be/x" });
    });
});

describe("resolveCookiesSource", () => {
    it("routes a manual selection to the cookies file, never a browser", () => {
        expect(resolveCookiesSource("manual", "  /a/cookies.txt ")).toEqual({
            cookiesBrowser: null,
            cookiesPath: "/a/cookies.txt",
        });
    });

    it("passes a browser through and clears the file path", () => {
        expect(resolveCookiesSource("firefox", "/ignored")).toEqual({
            cookiesBrowser: "firefox",
            cookiesPath: null,
        });
    });

    it("returns nulls when neither is set", () => {
        expect(resolveCookiesSource("", "")).toEqual({ cookiesBrowser: null, cookiesPath: null });
    });
});

describe("buildYtDlpCommandPreview", () => {
    it("never renders the cookies file path (shows a placeholder)", () => {
        expect(
            buildYtDlpCommandPreview("https://youtu.be/x", null, "/home/me/cookies.txt", "137")
        ).toBe("yt-dlp https://youtu.be/x --cookies <file> --format 137");
    });

    it("renders the browser source and omits auth when neither is set", () => {
        expect(buildYtDlpCommandPreview("https://youtu.be/x", "firefox", null, "137")).toBe(
            "yt-dlp https://youtu.be/x --cookies-from-browser firefox --format 137"
        );
        expect(buildYtDlpCommandPreview("https://youtu.be/x", null, null, "137")).toBe(
            "yt-dlp https://youtu.be/x --format 137"
        );
    });
});

describe("buildCreateMediaInput", () => {
    const context = {
        channelId: 7,
        importMode: "copy" as const,
        libraryPath: "/library",
        ytDlpRunId: "",
        ytDlpFormatId: "",
        cookiesBrowser: null,
        cookiesPath: null,
    };

    it("uses local fields and keeps publishedAt for a local import", () => {
        const input = buildCreateMediaInput(
            form({ title: " Local ", mediaType: "audio", publishedAt: " 2026-01-01 ", thumbPath: "t.jpg" }),
            { ...context, sourceMode: "local", sourceValue: "/a/b.m4a" }
        );

        expect(input).toMatchObject({
            channelId: 7,
            title: "Local",
            sourceMode: "local",
            sourceValue: "/a/b.m4a",
            mediaType: "audio",
            publishedAt: "2026-01-01",
            thumbnailSourcePath: "t.jpg",
            ytDlpYoutubeVideoId: null,
        });
    });

    it("uses yt-dlp fields and drops publishedAt for a yt-dlp download", () => {
        const input = buildCreateMediaInput(
            form({
                selectedYtDlpMediaType: "video",
                resolvedYoutubeVideoId: "abc",
                publishedAt: "2026-01-01",
            }),
            {
                ...context,
                sourceMode: "yt-dlp",
                sourceValue: "https://youtu.be/x",
                ytDlpRunId: "run-1",
                ytDlpFormatId: "137",
            }
        );

        expect(input).toMatchObject({
            sourceMode: "yt-dlp",
            mediaType: "video",
            publishedAt: null,
            ytDlpRunId: "run-1",
            ytDlpFormatId: "137",
            ytDlpYoutubeVideoId: "abc",
        });
    });
});
