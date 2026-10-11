import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAddMediaForm } from "./use-add-media-form";

vi.mock("../services/file-dialog-service", () => ({
    pickFile: vi.fn(),
}));

vi.mock("../utils/media-utils", async (importOriginal) => {
    // The extension lists are the real ones, since the picker filters are built from them.
    const actual = await importOriginal<typeof import("../utils/media-utils")>();

    return {
        AUDIO_FILE_EXTENSIONS: actual.AUDIO_FILE_EXTENSIONS,
        VIDEO_FILE_EXTENSIONS: actual.VIDEO_FILE_EXTENSIONS,
        IMAGE_FILE_EXTENSIONS: actual.IMAGE_FILE_EXTENSIONS,
        fileNameFromPath: vi.fn((path: string) => path.split("/").pop() ?? ""),
        isThumbnailFile: vi.fn((path: string) => path.endsWith(".jpg") || path.endsWith(".png")),
        mediaTypeFromFile: vi.fn((path: string) => (path.endsWith(".mp3") ? "audio" : "video")),
    };
});

vi.mock("../utils/error-message", () => ({
    resolveErrorMessage: vi.fn((_error: unknown, fallback: string) => fallback),
}));

vi.mock("../utils/app-logger", () => ({
    logError: vi.fn(),
}));

// A picked image is copied into the preview directory before it is previewed, so the path the form
// hands on is the staged copy's, not the one the dialog returned.
const mockStageManualThumbnail = vi.fn();

vi.mock("../services/thumbnail-service", () => ({
    stageManualThumbnail: (path: string) => mockStageManualThumbnail(path),
}));

const mockSetManualThumbPath = vi.fn().mockResolvedValue(undefined);
const mockGenerateThumbForMedia = vi.fn().mockResolvedValue(undefined);
const mockResetThumbState = vi.fn().mockResolvedValue(undefined);

vi.mock("./use-temp-thumbnail", () => ({
    useTempThumbnail: () => ({
        thumbPath: "",
        isGeneratingThumb: false,
        setManualThumbPath: mockSetManualThumbPath,
        generateThumbForMedia: mockGenerateThumbForMedia,
        resetThumbState: mockResetThumbState,
    }),
}));

const mockSetSelectedYtDlpFormatId = vi.fn();
const mockLoadYtDlpFormats = vi.fn().mockResolvedValue(undefined);
const mockResetYtDlpFormats = vi.fn();

type YtDlpFormatLoaderOptions = {
    getUrl: () => string;
    getCurrentTitle: () => string;
    getCookiesBrowser?: () => string;
    getCookiesPath?: () => string;
    onSuggestedTitle: (value: string) => void;
    onMediaTypeResolved: (value: "video" | "audio") => void;
    onTerminalStart?: (runId: string, header: string) => void;
    onTerminalLog?: (line: string) => void;
    onTerminalStop?: () => void;
};

const mockUseYtDlpFormatLoader = vi.fn((_options: YtDlpFormatLoaderOptions) => ({
    ytDlpFormats: [],
    selectedYtDlpFormatId: "",
    isLoadingYtDlpFormats: false,
    selectedYtDlpMediaType: "video" as const,
    resolvedYoutubeVideoId: null as string | null,
    setSelectedYtDlpFormatId: mockSetSelectedYtDlpFormatId,
    loadYtDlpFormats: mockLoadYtDlpFormats,
    resetYtDlpFormats: mockResetYtDlpFormats,
}));

function latestYtDlpFormatLoaderOptions(): YtDlpFormatLoaderOptions {
    const calls = mockUseYtDlpFormatLoader.mock.calls;
    return calls[calls.length - 1]![0];
}

vi.mock("./use-yt-dlp-format-loader", () => ({
    useYtDlpFormatLoader: (options: YtDlpFormatLoaderOptions) => mockUseYtDlpFormatLoader(options),
}));

import { pickFile } from "../services/file-dialog-service";
import { logError } from "../utils/app-logger";

describe("useAddMediaForm", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockSetManualThumbPath.mockResolvedValue(undefined);
        mockGenerateThumbForMedia.mockResolvedValue(undefined);
        mockResetThumbState.mockResolvedValue(undefined);
        mockLoadYtDlpFormats.mockResolvedValue(undefined);
    });

    it("starts with expected defaults", () => {
        const { result } = renderHook(() => useAddMediaForm());

        expect(result.current.sourceMode).toBe("local");
        expect(result.current.mediaUrl).toBe("");
        expect(result.current.title).toBe("");
        expect(result.current.mediaPath).toBe("");
        expect(result.current.mediaType).toBe("video");
        expect(result.current.publishedAt).toBe("");
        expect(result.current.downloadComments).toBe(true);
        expect(result.current.downloadLiveChat).toBe(true);
        expect(result.current.cookiesBrowser).toBe("");
        expect(result.current.cookiesPath).toBe("");
        expect(result.current.resolvedYoutubeVideoId).toBeNull();
    });

    it("exposes the youtube video id resolved by the format loader", () => {
        mockUseYtDlpFormatLoader.mockReturnValueOnce({
            ytDlpFormats: [],
            selectedYtDlpFormatId: "",
            isLoadingYtDlpFormats: false,
            selectedYtDlpMediaType: "video",
            resolvedYoutubeVideoId: "abc123",
            setSelectedYtDlpFormatId: mockSetSelectedYtDlpFormatId,
            loadYtDlpFormats: mockLoadYtDlpFormats,
            resetYtDlpFormats: mockResetYtDlpFormats,
        });

        const { result } = renderHook(() => useAddMediaForm());

        expect(result.current.resolvedYoutubeVideoId).toBe("abc123");
    });

    it("offers only the media types the library accepts in the media picker", async () => {
        vi.mocked(pickFile).mockResolvedValueOnce("/tmp/video.mp4");

        const { result } = renderHook(() => useAddMediaForm());

        await act(async () => {
            await result.current.pickMediaViaDialog();
        });

        const filters = vi.mocked(pickFile).mock.calls[0]?.[0]?.filters ?? [];
        const extensions = filters.flatMap((filter) => filter.extensions);
        expect(extensions).toContain("mp4");
        expect(extensions).toContain("opus");
        expect(extensions).not.toContain("txt");
    });

    it("offers only text files in the cookies picker and only images in the thumbnail picker", async () => {
        vi.mocked(pickFile).mockResolvedValueOnce(null).mockResolvedValueOnce(null);

        const { result } = renderHook(() => useAddMediaForm());

        await act(async () => {
            await result.current.pickCookiesFileViaDialog();
        });
        await act(async () => {
            await result.current.pickThumbViaDialog();
        });

        const [cookiesCall, thumbnailCall] = vi.mocked(pickFile).mock.calls;
        expect(cookiesCall?.[0]?.filters?.flatMap((filter) => filter.extensions)).toEqual(["txt"]);
        expect(thumbnailCall?.[0]?.filters?.flatMap((filter) => filter.extensions)).toEqual([
            "png",
            "jpg",
            "jpeg",
            "webp",
            "bmp",
            "avif",
        ]);
    });

    it("changes source mode", async () => {
        const { result } = renderHook(() => useAddMediaForm());

        await act(async () => {
            await result.current.setSourceMode("yt-dlp");
        });

        expect(result.current.sourceMode).toBe("yt-dlp");
    });

    it("switches back and forth between source modes based on the latest state", async () => {
        const { result } = renderHook(() => useAddMediaForm());

        await act(async () => {
            await result.current.setSourceMode("yt-dlp");
        });
        expect(result.current.sourceMode).toBe("yt-dlp");

        await act(async () => {
            await result.current.setSourceMode("local");
        });
        expect(result.current.sourceMode).toBe("local");
    });

    it("ignores setSourceMode when the mode is unchanged", async () => {
        const { result } = renderHook(() => useAddMediaForm());

        act(() => {
            result.current.setMediaUrl("kept");
        });

        await act(async () => {
            await result.current.setSourceMode("local");
        });

        expect(mockResetYtDlpFormats).not.toHaveBeenCalled();
        expect(mockResetThumbState).not.toHaveBeenCalled();
        expect(result.current.mediaUrl).toBe("kept");
    });

    it("resets download and cookies options when source mode changes", async () => {
        const { result } = renderHook(() => useAddMediaForm());

        act(() => {
            result.current.setDownloadComments(false);
            result.current.setDownloadLiveChat(false);
            result.current.setCookiesBrowser("edge");
        });

        await act(async () => {
            await result.current.setSourceMode("yt-dlp");
        });

        expect(result.current.downloadComments).toBe(true);
        expect(result.current.downloadLiveChat).toBe(true);
        expect(result.current.cookiesBrowser).toBe("");
        expect(result.current.cookiesPath).toBe("");
        expect(mockResetThumbState).toHaveBeenCalled();
    });

    it("updates media url and title", () => {
        const { result } = renderHook(() => useAddMediaForm());

        act(() => {
            result.current.setMediaUrl("https://youtube.com/watch?v=abc");
            result.current.setTitle("Test title");
            result.current.setPublishedAt("2026-03-31");
        });

        expect(result.current.mediaUrl).toBe("https://youtube.com/watch?v=abc");
        expect(result.current.title).toBe("Test title");
        expect(result.current.publishedAt).toBe("2026-03-31");
    });

    it("resets yt-dlp related state when the media url changes in yt-dlp mode", async () => {
        const { result } = renderHook(() => useAddMediaForm());

        await act(async () => {
            await result.current.setSourceMode("yt-dlp");
        });

        act(() => {
            result.current.setPublishedAt("2026-01-01");
        });

        mockResetYtDlpFormats.mockClear();

        act(() => {
            result.current.setMediaUrl("https://youtube.com/watch?v=xyz");
        });

        expect(result.current.mediaUrl).toBe("https://youtube.com/watch?v=xyz");
        expect(result.current.publishedAt).toBe("");
        expect(result.current.mediaType).toBe("video");
        expect(mockResetYtDlpFormats).toHaveBeenCalled();
    });

    it("does not reset yt-dlp state when the media url changes in local mode", () => {
        const { result } = renderHook(() => useAddMediaForm());

        act(() => {
            result.current.setMediaUrl("https://youtube.com/watch?v=xyz");
        });

        expect(mockResetYtDlpFormats).not.toHaveBeenCalled();
    });

    it("picks media through dialog", async () => {
        vi.mocked(pickFile).mockResolvedValueOnce("/tmp/video.mp4");

        const { result } = renderHook(() => useAddMediaForm());

        await act(async () => {
            await result.current.pickMediaViaDialog();
        });

        expect(result.current.mediaPath).toBe("/tmp/video.mp4");
        expect(result.current.mediaType).toBe("video");
        expect(result.current.title).toBe("video");
    });

    it("ignores empty media selection from dialog", async () => {
        vi.mocked(pickFile).mockResolvedValueOnce(null);

        const { result } = renderHook(() => useAddMediaForm());

        await act(async () => {
            await result.current.pickMediaViaDialog();
        });

        expect(result.current.mediaPath).toBe("");
    });

    it("preserves an already-set title when picking new media", async () => {
        vi.mocked(pickFile).mockResolvedValueOnce("/tmp/other-video.mp4");

        const { result } = renderHook(() => useAddMediaForm());

        act(() => {
            result.current.setTitle("My custom title");
        });

        await act(async () => {
            await result.current.pickMediaViaDialog();
        });

        expect(result.current.title).toBe("My custom title");
        expect(result.current.mediaPath).toBe("/tmp/other-video.mp4");
    });

    it("replaces a title taken from the previous file when another file is picked", async () => {
        vi.mocked(pickFile)
            .mockResolvedValueOnce("/tmp/Episode 01.mp4")
            .mockResolvedValueOnce("/tmp/Episode 02.mp4");

        const { result } = renderHook(() => useAddMediaForm());

        await act(async () => {
            await result.current.pickMediaViaDialog();
        });

        expect(result.current.title).toBe("Episode 01");

        await act(async () => {
            await result.current.pickMediaViaDialog();
        });

        expect(result.current.title).toBe("Episode 02");
    });

    it("keeps a title typed over the file name when another file is picked", async () => {
        vi.mocked(pickFile)
            .mockResolvedValueOnce("/tmp/Episode 01.mp4")
            .mockResolvedValueOnce("/tmp/Episode 02.mp4");

        const { result } = renderHook(() => useAddMediaForm());

        await act(async () => {
            await result.current.pickMediaViaDialog();
        });

        act(() => {
            result.current.setTitle("Pilot");
        });

        await act(async () => {
            await result.current.pickMediaViaDialog();
        });

        expect(result.current.title).toBe("Pilot");
    });

    it("clears a title suggested for the previous URL when the URL changes", async () => {
        const { result } = renderHook(() => useAddMediaForm());

        await act(async () => {
            await result.current.setSourceMode("yt-dlp");
        });

        act(() => {
            result.current.setMediaUrl("https://www.youtube.com/watch?v=first");
        });

        act(() => {
            latestYtDlpFormatLoaderOptions().onSuggestedTitle("First video");
        });

        // While the title is the suggested one, the loader may replace it with the next URL's.
        expect(latestYtDlpFormatLoaderOptions().getCurrentTitle()).toBe("");

        act(() => {
            result.current.setMediaUrl("https://www.youtube.com/watch?v=second");
        });

        expect(result.current.title).toBe("");
    });

    it("keeps a typed title when the URL changes", async () => {
        const { result } = renderHook(() => useAddMediaForm());

        await act(async () => {
            await result.current.setSourceMode("yt-dlp");
        });

        act(() => {
            result.current.setTitle("My title");
        });

        act(() => {
            result.current.setMediaUrl("https://www.youtube.com/watch?v=second");
        });

        expect(result.current.title).toBe("My title");
        expect(latestYtDlpFormatLoaderOptions().getCurrentTitle()).toBe("My title");
    });

    it("falls back to Untitled when the selected file has no derivable name", async () => {
        vi.mocked(pickFile).mockResolvedValueOnce("/tmp/");

        const { result } = renderHook(() => useAddMediaForm());

        await act(async () => {
            await result.current.pickMediaViaDialog();
        });

        expect(result.current.title).toBe("Untitled");
    });

    it("picks thumbnail through dialog and previews the staged copy", async () => {
        // The staged copy is what the preview must point at. It lives in a directory the asset
        // protocol already serves, which is what replaced granting the user's own file. It is also
        // flagged as a temp file, so the hook that owns it will delete it.
        vi.mocked(pickFile).mockResolvedValueOnce("/tmp/thumb.jpg");
        mockStageManualThumbnail.mockResolvedValueOnce("/cache/thumbs-temp/picked_abc.jpg");

        const { result } = renderHook(() => useAddMediaForm());

        await act(async () => {
            await result.current.pickThumbViaDialog();
        });

        expect(pickFile).toHaveBeenCalled();
        expect(mockStageManualThumbnail).toHaveBeenCalledWith("/tmp/thumb.jpg");
        expect(mockSetManualThumbPath).toHaveBeenCalledWith(
            "/cache/thumbs-temp/picked_abc.jpg",
            true
        );
    });

    it("keeps the picked thumbnail when staging it fails", async () => {
        // Staging is an optimization of where the preview reads from, not of what gets imported, so
        // its failure must not lose the selection. The import still persists the right image, only
        // the preview is missing. The path is flagged as not-ours so nothing later tries to delete
        // a file in the user's own pictures folder.
        vi.mocked(pickFile).mockResolvedValueOnce("/tmp/thumb.jpg");
        mockStageManualThumbnail.mockRejectedValueOnce(new Error("cache is read-only"));

        const { result } = renderHook(() => useAddMediaForm());

        await act(async () => {
            await result.current.pickThumbViaDialog();
        });

        expect(mockSetManualThumbPath).toHaveBeenCalledWith("/tmp/thumb.jpg", false);
        expect(logError).toHaveBeenCalled();
    });

    it("says so when the thumbnail picked is not an image the app accepts", async () => {
        vi.mocked(pickFile).mockResolvedValueOnce("/tmp/thumb.gif");
        const onError = vi.fn();

        const { result } = renderHook(() => useAddMediaForm({ onError }));

        await act(async () => {
            await result.current.pickThumbViaDialog();
        });

        expect(mockSetManualThumbPath).not.toHaveBeenCalled();
        expect(onError).toHaveBeenCalledTimes(1);
    });

    it("ignores empty thumbnail selection from dialog", async () => {
        vi.mocked(pickFile).mockResolvedValueOnce(null);

        const { result } = renderHook(() => useAddMediaForm());

        await act(async () => {
            await result.current.pickThumbViaDialog();
        });

        expect(mockSetManualThumbPath).not.toHaveBeenCalled();
    });

    it("reports dialog error when thumbnail picker fails", async () => {
        const onError = vi.fn();
        vi.mocked(pickFile).mockRejectedValueOnce(new Error("boom"));

        const { result } = renderHook(() =>
            useAddMediaForm({
                onError,
            })
        );

        await act(async () => {
            await result.current.pickThumbViaDialog();
        });

        expect(onError).toHaveBeenCalledWith("Failed to select thumbnail image.");
    });

    it("normalizes cookies browser input (trim, lowercase, validated against the supported list)", () => {
        const { result } = renderHook(() => useAddMediaForm());

        act(() => {
            result.current.setCookiesBrowser("  Edge  ");
        });
        expect(result.current.cookiesBrowser).toBe("edge");

        act(() => {
            result.current.setCookiesBrowser("not-a-real-browser");
        });
        expect(result.current.cookiesBrowser).toBe("");
        expect(mockResetYtDlpFormats).toHaveBeenCalled();
    });

    it("hands the format loader the browser with the profile appended", () => {
        // The combo keeps the bare browser (it renders that value) and the profile lives in its
        // own field; what the loader and the download receive is the composed selector yt-dlp
        // reads, so a typed profile has to show up here or the probe runs on the default profile.
        const { result } = renderHook(() => useAddMediaForm());

        act(() => {
            result.current.setCookiesBrowser("firefox");
            result.current.setCookiesBrowserProfile("  default-release ");
        });

        expect(result.current.cookiesBrowser).toBe("firefox");
        expect(result.current.cookiesBrowserProfile).toBe("  default-release ");
        expect(latestYtDlpFormatLoaderOptions().getCookiesBrowser?.()).toBe(
            "firefox:default-release"
        );
        // A keyring typed with its leading `+` joins the browser without a second separator.
        act(() => {
            result.current.setCookiesBrowser("chromium");
            result.current.setCookiesBrowserProfile("+gnomekeyring:Default");
        });
        expect(latestYtDlpFormatLoaderOptions().getCookiesBrowser?.()).toBe(
            "chromium+gnomekeyring:Default"
        );
        // Typing a profile invalidates the formats loaded for the previous cookies.
        expect(mockResetYtDlpFormats).toHaveBeenCalled();
    });

    it("drops the profile when the browser is cleared or switched to manual, keeps it across browsers", () => {
        const { result } = renderHook(() => useAddMediaForm());

        act(() => {
            result.current.setCookiesBrowser("firefox");
            result.current.setCookiesBrowserProfile("Work");
        });

        // Switching browsers keeps the profile: a user comparing two browsers with a profile of
        // the same name should not have to retype it.
        act(() => {
            result.current.setCookiesBrowser("edge");
        });
        expect(result.current.cookiesBrowserProfile).toBe("Work");

        // Clearing the combo drops it, so it cannot ride along silently with the next choice.
        act(() => {
            result.current.setCookiesBrowser("");
        });
        expect(result.current.cookiesBrowserProfile).toBe("");

        // The manual cookies file has no browser to attach a profile to.
        act(() => {
            result.current.setCookiesBrowser("firefox");
            result.current.setCookiesBrowserProfile("Work");
            result.current.setCookiesBrowser("manual");
        });
        expect(result.current.cookiesBrowserProfile).toBe("");
        expect(latestYtDlpFormatLoaderOptions().getCookiesBrowser?.()).toBe("");
    });

    it("refuses to load formats when the profile does not form a usable selector", async () => {
        // The service layer would drop an invalid selector and probe without cookies, and the
        // formats that came back would not be the ones the chosen profile can see. Refusing here
        // is what tells the user instead of silently downgrading the request.
        const onError = vi.fn();
        const { result } = renderHook(() => useAddMediaForm({ onError }));

        act(() => {
            result.current.setMediaUrl("https://youtube.com/watch?v=abc");
            result.current.setCookiesBrowser("firefox");
            result.current.setCookiesBrowserProfile("-not-a-profile");
        });

        await act(async () => {
            await result.current.loadYtDlpFormats();
        });

        expect(mockLoadYtDlpFormats).not.toHaveBeenCalled();
        expect(onError).toHaveBeenCalledWith("Failed to load yt-dlp formats.");
        expect(logError).toHaveBeenCalledWith(
            "add-media-form",
            "Failed to load yt-dlp formats.",
            expect.any(Error),
            // The profile is deliberately absent from the details. It is often a path under
            // the user's home directory, and this context reaches the file log.
            {
                mediaUrl: "https://youtube.com/watch?v=abc",
                cookiesBrowser: "firefox",
                cookiesPath: "",
            }
        );
    });

    it("keeps the cookies path when switching to manual mode but clears it otherwise", () => {
        const { result } = renderHook(() => useAddMediaForm());

        act(() => {
            result.current.setCookiesPath("/tmp/cookies.txt");
            result.current.setCookiesBrowser("manual");
        });
        expect(result.current.cookiesPath).toBe("/tmp/cookies.txt");
        expect(result.current.cookiesBrowser).toBe("manual");

        act(() => {
            result.current.setCookiesBrowser("edge");
        });
        expect(result.current.cookiesPath).toBe("");
    });

    it("trims the cookies path", () => {
        const { result } = renderHook(() => useAddMediaForm());

        act(() => {
            result.current.setCookiesPath("  /tmp/cookies.txt  ");
        });

        expect(result.current.cookiesPath).toBe("/tmp/cookies.txt");
    });

    it("picks a valid cookies text file through the dialog", async () => {
        vi.mocked(pickFile).mockResolvedValueOnce("/tmp/cookies.TXT");

        const { result } = renderHook(() => useAddMediaForm());

        await act(async () => {
            await result.current.pickCookiesFileViaDialog();
        });

        expect(result.current.cookiesBrowser).toBe("manual");
        expect(result.current.cookiesPath).toBe("/tmp/cookies.TXT");
        expect(mockResetYtDlpFormats).toHaveBeenCalled();
    });

    it("rejects a cookies file without a .txt extension", async () => {
        const onError = vi.fn();
        vi.mocked(pickFile).mockResolvedValueOnce("/tmp/cookies.json");

        const { result } = renderHook(() =>
            useAddMediaForm({
                onError,
            })
        );

        await act(async () => {
            await result.current.pickCookiesFileViaDialog();
        });

        expect(onError).toHaveBeenCalledWith("Failed to select cookies file.");
        expect(result.current.cookiesBrowser).toBe("");
        expect(result.current.cookiesPath).toBe("");
    });

    it("ignores empty cookies file selection", async () => {
        vi.mocked(pickFile).mockResolvedValueOnce(null);

        const { result } = renderHook(() => useAddMediaForm());

        await act(async () => {
            await result.current.pickCookiesFileViaDialog();
        });

        expect(result.current.cookiesBrowser).toBe("");
        expect(mockResetYtDlpFormats).not.toHaveBeenCalled();
    });

    it("clears the cookies path", () => {
        const { result } = renderHook(() => useAddMediaForm());

        act(() => {
            result.current.setCookiesPath("/tmp/cookies.txt");
        });
        mockResetYtDlpFormats.mockClear();

        act(() => {
            result.current.clearCookiesPath();
        });

        expect(result.current.cookiesPath).toBe("");
        expect(mockResetYtDlpFormats).toHaveBeenCalled();
    });

    it("passes yt-dlp cookies getters that respect manual mode", () => {
        const { result } = renderHook(() => useAddMediaForm());

        act(() => {
            result.current.setCookiesBrowser("edge");
        });

        let options = latestYtDlpFormatLoaderOptions();
        expect(options.getCookiesBrowser?.()).toBe("edge");
        expect(options.getCookiesPath?.()).toBe("");

        act(() => {
            result.current.setCookiesBrowser("manual");
            result.current.setCookiesPath("/tmp/cookies.txt");
        });

        options = latestYtDlpFormatLoaderOptions();
        expect(options.getCookiesBrowser?.()).toBe("");
        expect(options.getCookiesPath?.()).toBe("/tmp/cookies.txt");
    });

    it("applies yt-dlp suggested title and media type through the format loader callbacks", () => {
        const { result } = renderHook(() => useAddMediaForm());

        const options = latestYtDlpFormatLoaderOptions();

        act(() => {
            options.onSuggestedTitle("Suggested Title");
            options.onMediaTypeResolved("audio");
        });

        expect(result.current.title).toBe("Suggested Title");
        expect(result.current.mediaType).toBe("audio");
    });

    it("resets form", async () => {
        const { result } = renderHook(() => useAddMediaForm());

        act(() => {
            result.current.setMediaUrl("https://youtube.com/watch?v=abc");
            result.current.setTitle("Test");
        });

        await act(async () => {
            await result.current.resetForm();
        });

        expect(result.current.sourceMode).toBe("local");
        expect(result.current.mediaUrl).toBe("");
        expect(result.current.title).toBe("");
        expect(result.current.mediaPath).toBe("");
        expect(result.current.mediaType).toBe("video");
        expect(result.current.publishedAt).toBe("");
    });

    it("reports yt-dlp format loading error through onError", async () => {
        const onError = vi.fn();
        mockLoadYtDlpFormats.mockRejectedValueOnce(new Error("boom"));

        const { result } = renderHook(() =>
            useAddMediaForm({
                onError,
            })
        );

        await act(async () => {
            await result.current.loadYtDlpFormats();
        });

        expect(onError).toHaveBeenCalledWith("Failed to load yt-dlp formats.");
    });

    it("treats a cancelled format listing as the outcome asked for, not an error", async () => {
        const onError = vi.fn();
        mockLoadYtDlpFormats.mockRejectedValueOnce({
            code: "YT_DLP_DOWNLOAD_CANCELLED",
            message: "yt-dlp format listing cancelled",
        });

        const { result } = renderHook(() => useAddMediaForm({ onError }));

        await act(async () => {
            await result.current.loadYtDlpFormats();
        });

        expect(onError).not.toHaveBeenCalled();
        expect(logError).not.toHaveBeenCalled();
    });

    it("reports yt-dlp format loading error with contextual details", async () => {
        mockLoadYtDlpFormats.mockRejectedValueOnce(new Error("boom"));

        const { result } = renderHook(() => useAddMediaForm());

        act(() => {
            result.current.setMediaUrl("  https://youtube.com/watch?v=abc  ");
            result.current.setCookiesBrowser("edge");
        });

        await act(async () => {
            await result.current.loadYtDlpFormats();
        });

        expect(logError).toHaveBeenCalledWith(
            "add-media-form",
            "Failed to load yt-dlp formats.",
            expect.any(Error),
            {
                mediaUrl: "https://youtube.com/watch?v=abc",
                cookiesBrowser: "edge",
                cookiesPath: "",
            }
        );
    });

    it("reports dialog error when media picker fails", async () => {
        const onError = vi.fn();
        vi.mocked(pickFile).mockRejectedValueOnce(new Error("boom"));

        const { result } = renderHook(() =>
            useAddMediaForm({
                onError,
            })
        );

        await act(async () => {
            await result.current.pickMediaViaDialog();
        });

        expect(onError).toHaveBeenCalledWith("Failed to select media file.");
    });

    it("does not throw when reporting an error without an onError callback", async () => {
        vi.mocked(pickFile).mockRejectedValueOnce(new Error("boom"));

        const { result } = renderHook(() => useAddMediaForm());

        await act(async () => {
            await result.current.pickMediaViaDialog();
        });

        expect(logError).toHaveBeenCalledWith(
            "add-media-form",
            "Failed to select media file.",
            expect.any(Error),
            undefined
        );
    });

    it("uses the latest onError callback across re-renders", async () => {
        vi.mocked(pickFile).mockRejectedValueOnce(new Error("boom"));

        const { result, rerender } = renderHook(
            ({ onError }: { onError?: (message: string) => void }) => useAddMediaForm({ onError }),
            { initialProps: { onError: undefined as ((message: string) => void) | undefined } }
        );

        const updatedOnError = vi.fn();
        rerender({ onError: updatedOnError });

        await act(async () => {
            await result.current.pickMediaViaDialog();
        });

        expect(updatedOnError).toHaveBeenCalledWith("Failed to select media file.");
    });

    it("uses the latest onError callback for cookies file errors across re-renders", async () => {
        vi.mocked(pickFile).mockRejectedValueOnce(new Error("boom"));

        const { result, rerender } = renderHook(
            ({ onError }: { onError?: (message: string) => void }) => useAddMediaForm({ onError }),
            { initialProps: { onError: undefined as ((message: string) => void) | undefined } }
        );

        const updatedOnError = vi.fn();
        rerender({ onError: updatedOnError });

        await act(async () => {
            await result.current.pickCookiesFileViaDialog();
        });

        expect(updatedOnError).toHaveBeenCalledWith("Failed to select cookies file.");
    });

    function createYtDlpTerminalMock() {
        return {
            startManualSession: vi.fn(),
            appendManualLog: vi.fn(),
            markStopped: vi.fn(),
            resetYtDlpState: vi.fn(),
        };
    }

    it("clears yt-dlp terminal state when switching source mode", async () => {
        const ytDlpTerminal = createYtDlpTerminalMock();
        const { result } = renderHook(() => useAddMediaForm({ ytDlpTerminal }));

        await act(async () => {
            await result.current.setSourceMode("yt-dlp");
        });

        expect(ytDlpTerminal.resetYtDlpState).toHaveBeenCalledWith(true);
    });

    it("clears yt-dlp terminal state when resetting the form", async () => {
        const ytDlpTerminal = createYtDlpTerminalMock();
        const { result } = renderHook(() => useAddMediaForm({ ytDlpTerminal }));

        await act(async () => {
            await result.current.resetForm();
        });

        expect(ytDlpTerminal.resetYtDlpState).toHaveBeenCalledWith(true);
    });

    it("clears yt-dlp terminal state after picking a cookies file", async () => {
        const ytDlpTerminal = createYtDlpTerminalMock();
        vi.mocked(pickFile).mockResolvedValueOnce("/tmp/cookies.txt");

        const { result } = renderHook(() => useAddMediaForm({ ytDlpTerminal }));

        await act(async () => {
            await result.current.pickCookiesFileViaDialog();
        });

        expect(ytDlpTerminal.resetYtDlpState).toHaveBeenCalledWith(true);
    });

    it("clears yt-dlp terminal state when the media url changes in yt-dlp mode", async () => {
        const ytDlpTerminal = createYtDlpTerminalMock();
        const { result } = renderHook(() => useAddMediaForm({ ytDlpTerminal }));

        await act(async () => {
            await result.current.setSourceMode("yt-dlp");
        });
        ytDlpTerminal.resetYtDlpState.mockClear();

        act(() => {
            result.current.setMediaUrl("https://youtube.com/watch?v=abc");
        });

        expect(ytDlpTerminal.resetYtDlpState).toHaveBeenCalledWith(true);
    });

    it("hands the format loader getters that keep their identity and read the latest values", () => {
        const { result } = renderHook(() => useAddMediaForm());
        const firstOptions = latestYtDlpFormatLoaderOptions();

        act(() => {
            result.current.setMediaUrl("https://youtube.com/watch?v=abc");
            result.current.setTitle("Typed title");
        });

        const lastOptions = latestYtDlpFormatLoaderOptions();
        expect(lastOptions.getUrl).toBe(firstOptions.getUrl);
        expect(lastOptions.getCurrentTitle).toBe(firstOptions.getCurrentTitle);
        expect(firstOptions.getUrl()).toBe("https://youtube.com/watch?v=abc");
        expect(firstOptions.getCurrentTitle()).toBe("Typed title");
    });

    it("keeps its yt-dlp callbacks when the terminal object is rebuilt with the same functions", () => {
        const ytDlpTerminal = createYtDlpTerminalMock();
        const { result, rerender } = renderHook(
            ({ terminal }: { terminal: ReturnType<typeof createYtDlpTerminalMock> }) =>
                useAddMediaForm({ ytDlpTerminal: terminal }),
            { initialProps: { terminal: ytDlpTerminal } }
        );
        const firstClearCookiesPath = result.current.clearCookiesPath;

        rerender({ terminal: { ...ytDlpTerminal } });

        expect(result.current.clearCookiesPath).toBe(firstClearCookiesPath);
    });

    it("uses the latest ytDlpTerminal across re-renders for cookie and reset actions", () => {
        const { result, rerender } = renderHook(
            ({ ytDlpTerminal }: { ytDlpTerminal?: ReturnType<typeof createYtDlpTerminalMock> }) =>
                useAddMediaForm({ ytDlpTerminal }),
            {
                initialProps: {
                    ytDlpTerminal: undefined as ReturnType<typeof createYtDlpTerminalMock> | undefined,
                },
            }
        );

        const ytDlpTerminal = createYtDlpTerminalMock();
        rerender({ ytDlpTerminal });

        act(() => {
            result.current.setCookiesBrowser("edge");
        });
        expect(ytDlpTerminal.resetYtDlpState).toHaveBeenCalledWith(true);

        ytDlpTerminal.resetYtDlpState.mockClear();
        act(() => {
            result.current.setCookiesPath("/tmp/cookies.txt");
        });
        expect(ytDlpTerminal.resetYtDlpState).toHaveBeenCalledWith(true);

        ytDlpTerminal.resetYtDlpState.mockClear();
        act(() => {
            result.current.clearCookiesPath();
        });
        expect(ytDlpTerminal.resetYtDlpState).toHaveBeenCalledWith(true);
    });
});