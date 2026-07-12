import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useYtDlpFormatLoader } from "./use-yt-dlp-format-loader";

vi.mock("../services/media-download-service", () => ({
    listYtDlpFormats: vi.fn(),
}));

import { listYtDlpFormats } from "../services/media-download-service";
import type { YtDlpFormat, YtDlpFormatsResult } from "../types/media";

function makeFormat(overrides: Partial<YtDlpFormat> = {}): YtDlpFormat {
    return {
        format_id: "fmt",
        display_name: "unused-input-label",
        ext: "mp4",
        media_type: "video",
        has_video: true,
        has_audio: false,
        filesize_bytes: null,
        height: null,
        abr: null,
        tbr: null,
        vcodec: null,
        protocol: null,
        ...overrides,
    };
}

function resultWithFormats(
    formats: YtDlpFormat[],
    overrides: Partial<YtDlpFormatsResult> = {}
): YtDlpFormatsResult {
    return {
        suggested_title: "",
        youtube_video_id: null,
        terminal_logs: [],
        formats,
        ...overrides,
    };
}

type LoaderOverrides = {
    getUrl?: () => string;
    getCurrentTitle?: () => string;
    getCookiesBrowser?: () => string;
    getCookiesPath?: () => string;
};

function renderLoader(overrides: LoaderOverrides = {}) {
    const onSuggestedTitle = vi.fn();
    const onMediaTypeResolved = vi.fn();
    const onTerminalStart = vi.fn();
    const onTerminalLog = vi.fn();
    const onTerminalStop = vi.fn();

    const rendered = renderHook(() =>
        useYtDlpFormatLoader({
            getUrl: overrides.getUrl ?? (() => "https://youtube.com/watch?v=abc"),
            getCurrentTitle: overrides.getCurrentTitle ?? (() => ""),
            getCookiesBrowser: overrides.getCookiesBrowser,
            getCookiesPath: overrides.getCookiesPath,
            onSuggestedTitle,
            onMediaTypeResolved,
            onTerminalStart,
            onTerminalLog,
            onTerminalStop,
        })
    );

    return {
        ...rendered,
        onSuggestedTitle,
        onMediaTypeResolved,
        onTerminalStart,
        onTerminalLog,
        onTerminalStop,
    };
}

async function loadFormats(
    result: ReturnType<typeof renderLoader>["result"],
    formats: YtDlpFormat[],
    overrides: Partial<YtDlpFormatsResult> = {}
): Promise<void> {
    vi.mocked(listYtDlpFormats).mockResolvedValueOnce(resultWithFormats(formats, overrides));

    await act(async () => {
        await result.current.loadYtDlpFormats();
    });
}

describe("useYtDlpFormatLoader", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("starts with empty state", () => {
        const { result } = renderHook(() =>
            useYtDlpFormatLoader({
                getUrl: () => "",
                getCurrentTitle: () => "",
                onSuggestedTitle: vi.fn(),
                onMediaTypeResolved: vi.fn(),
            })
        );

        expect(result.current.ytDlpFormats).toEqual([]);
        expect(result.current.selectedYtDlpFormatId).toBe("");
        expect(result.current.isLoadingYtDlpFormats).toBe(false);
        expect(result.current.selectedYtDlpMediaType).toBe("video");
        expect(result.current.resolvedYoutubeVideoId).toBeNull();
    });

    it("resolves the youtube video id from the format metadata response", async () => {
        vi.mocked(listYtDlpFormats).mockResolvedValueOnce({
            suggested_title: "",
            youtube_video_id: "  abc123  ",
            terminal_logs: [],
            formats: [],
        });

        const { result } = renderHook(() =>
            useYtDlpFormatLoader({
                getUrl: () => "https://youtube.com/watch?v=abc123",
                getCurrentTitle: () => "",
                onSuggestedTitle: vi.fn(),
                onMediaTypeResolved: vi.fn(),
            })
        );

        await act(async () => {
            await result.current.loadYtDlpFormats();
        });

        expect(result.current.resolvedYoutubeVideoId).toBe("abc123");
    });

    it("treats a missing or blank resolved youtube video id as null", async () => {
        vi.mocked(listYtDlpFormats).mockResolvedValueOnce({
            suggested_title: "",
            youtube_video_id: "   ",
            terminal_logs: [],
            formats: [],
        });

        const { result } = renderHook(() =>
            useYtDlpFormatLoader({
                getUrl: () => "https://vimeo.com/1",
                getCurrentTitle: () => "",
                onSuggestedTitle: vi.fn(),
                onMediaTypeResolved: vi.fn(),
            })
        );

        await act(async () => {
            await result.current.loadYtDlpFormats();
        });

        expect(result.current.resolvedYoutubeVideoId).toBeNull();
    });

    it("clears the resolved youtube video id on reset", async () => {
        vi.mocked(listYtDlpFormats).mockResolvedValueOnce({
            suggested_title: "",
            youtube_video_id: "abc123",
            terminal_logs: [],
            formats: [],
        });

        const { result } = renderHook(() =>
            useYtDlpFormatLoader({
                getUrl: () => "https://youtube.com/watch?v=abc123",
                getCurrentTitle: () => "",
                onSuggestedTitle: vi.fn(),
                onMediaTypeResolved: vi.fn(),
            })
        );

        await act(async () => {
            await result.current.loadYtDlpFormats();
        });
        expect(result.current.resolvedYoutubeVideoId).toBe("abc123");

        act(() => {
            result.current.resetYtDlpFormats();
        });

        expect(result.current.resolvedYoutubeVideoId).toBeNull();
    });

    it("clears the resolved youtube video id when format loading fails", async () => {
        vi.mocked(listYtDlpFormats).mockResolvedValueOnce({
            suggested_title: "",
            youtube_video_id: "abc123",
            terminal_logs: [],
            formats: [],
        });

        const { result } = renderHook(() =>
            useYtDlpFormatLoader({
                getUrl: () => "https://youtube.com/watch?v=abc123",
                getCurrentTitle: () => "",
                onSuggestedTitle: vi.fn(),
                onMediaTypeResolved: vi.fn(),
            })
        );

        await act(async () => {
            await result.current.loadYtDlpFormats();
        });
        expect(result.current.resolvedYoutubeVideoId).toBe("abc123");

        vi.mocked(listYtDlpFormats).mockRejectedValueOnce(new Error("boom"));

        await act(async () => {
            await expect(result.current.loadYtDlpFormats()).rejects.toThrow("boom");
        });

        expect(result.current.resolvedYoutubeVideoId).toBeNull();
    });

    it("loads formats and selects best candidate", async () => {
        const onSuggestedTitle = vi.fn();
        const onMediaTypeResolved = vi.fn();

        vi.mocked(listYtDlpFormats).mockResolvedValueOnce({
            suggested_title: "Video A",
            youtube_video_id: null,
            terminal_logs: [],
            formats: [
                {
                    format_id: "audio-only",
                    display_name: "Audio only",
                    ext: "m4a",
                    media_type: "audio",
                    has_video: false,
                    has_audio: true,
                    filesize_bytes: 1000,
                    height: null,
                    abr: 128,
                    tbr: null,
                    vcodec: null,
                    protocol: null,
                },
                {
                    format_id: "best",
                    display_name: "1080p",
                    ext: "mp4",
                    media_type: "video",
                    has_video: true,
                    has_audio: true,
                    filesize_bytes: 2000,
                    height: 1080,
                    abr: null,
                    tbr: 2500,
                    vcodec: "avc1",
                    protocol: "https",
                },
            ],
        });

        const { result } = renderHook(() =>
            useYtDlpFormatLoader({
                getUrl: () => "https://youtube.com/watch?v=abc",
                getCurrentTitle: () => "",
                onSuggestedTitle,
                onMediaTypeResolved,
            })
        );

        await act(async () => {
            await result.current.loadYtDlpFormats();
        });

        expect(result.current.ytDlpFormats).toHaveLength(2);
        expect(result.current.selectedYtDlpFormatId).toBe("best");
        expect(result.current.selectedYtDlpMediaType).toBe("video");
        expect(onSuggestedTitle).toHaveBeenCalledWith("Video A");
        expect(onMediaTypeResolved).toHaveBeenCalledWith("video");
    });

    it("resets state", () => {
        const onMediaTypeResolved = vi.fn();

        const { result } = renderHook(() =>
            useYtDlpFormatLoader({
                getUrl: () => "",
                getCurrentTitle: () => "",
                onSuggestedTitle: vi.fn(),
                onMediaTypeResolved,
            })
        );

        act(() => {
            result.current.resetYtDlpFormats();
        });

        expect(result.current.ytDlpFormats).toEqual([]);
        expect(result.current.selectedYtDlpFormatId).toBe("");
        expect(result.current.isLoadingYtDlpFormats).toBe(false);
        expect(onMediaTypeResolved).toHaveBeenCalledWith("video");
    });

    it("resets media type to video when url is empty", async () => {
        const onMediaTypeResolved = vi.fn();

        const { result } = renderHook(() =>
            useYtDlpFormatLoader({
                getUrl: () => "",
                getCurrentTitle: () => "",
                onSuggestedTitle: vi.fn(),
                onMediaTypeResolved,
            })
        );

        await act(async () => {
            await result.current.loadYtDlpFormats();
        });

        expect(onMediaTypeResolved).toHaveBeenCalledWith("video");
        expect(result.current.selectedYtDlpFormatId).toBe("");
    });

    it("resets media type to video when format loading fails", async () => {
        const onMediaTypeResolved = vi.fn();
        const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

        vi.mocked(listYtDlpFormats).mockRejectedValueOnce(new Error("boom"));

        const { result } = renderHook(() =>
            useYtDlpFormatLoader({
                getUrl: () => "https://youtube.com/watch?v=abc",
                getCurrentTitle: () => "",
                onSuggestedTitle: vi.fn(),
                onMediaTypeResolved,
            })
        );

        await expect(
            act(async () => {
                await result.current.loadYtDlpFormats();
            })
        ).rejects.toThrow("boom");

        expect(result.current.ytDlpFormats).toEqual([]);
        expect(result.current.selectedYtDlpFormatId).toBe("");
        expect(onMediaTypeResolved).toHaveBeenCalledWith("video");

        consoleErrorSpy.mockRestore();
    });

    it("resets media type to video when selected format becomes empty", () => {
        const onMediaTypeResolved = vi.fn();

        const { result } = renderHook(() =>
            useYtDlpFormatLoader({
                getUrl: () => "",
                getCurrentTitle: () => "",
                onSuggestedTitle: vi.fn(),
                onMediaTypeResolved,
            })
        );

        act(() => {
            result.current.setSelectedYtDlpFormatId("");
        });

        expect(onMediaTypeResolved).toHaveBeenCalledWith("video");
    });

    it("discards a stale format response after a reset mid-load", async () => {
        // Hold the response so a reset can happen while the load is in flight.
        let resolveFormats: (value: YtDlpFormatsResult) => void = () => {};
        vi.mocked(listYtDlpFormats).mockReturnValueOnce(
            new Promise<YtDlpFormatsResult>((resolve) => {
                resolveFormats = resolve;
            })
        );

        const { result } = renderHook(() =>
            useYtDlpFormatLoader({
                getUrl: () => "https://youtube.com/watch?v=a",
                getCurrentTitle: () => "",
                onSuggestedTitle: vi.fn(),
                onMediaTypeResolved: vi.fn(),
            })
        );

        let loadPromise: Promise<void> = Promise.resolve();
        act(() => {
            loadPromise = result.current.loadYtDlpFormats();
        });

        // Editing the URL resets the state and must invalidate the in-flight load.
        act(() => {
            result.current.resetYtDlpFormats();
        });

        // The stale response for the old URL finally arrives.
        await act(async () => {
            resolveFormats({
                suggested_title: "",
                youtube_video_id: null,
                terminal_logs: [],
                formats: [
                    {
                        format_id: "best",
                        display_name: "1080p",
                        ext: "mp4",
                        media_type: "video",
                        has_video: true,
                        has_audio: true,
                        filesize_bytes: 2000,
                        height: 1080,
                        abr: null,
                        tbr: 2500,
                        vcodec: "avc1",
                        protocol: "https",
                    },
                ],
            });
            await loadPromise;
        });

        // It must not repopulate the cleared formats/selection (which feed the download).
        expect(result.current.ytDlpFormats).toEqual([]);
        expect(result.current.selectedYtDlpFormatId).toBe("");
    });
});

describe("useYtDlpFormatLoader - display label formatting", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("builds a full native label with codec, integer bitrate, drc suffix and m3u8 protocol", async () => {
        const { result } = renderLoader();

        await loadFormats(result, [
            makeFormat({
                format_id: "137-DRC",
                has_video: true,
                has_audio: true,
                height: 720,
                ext: "mp4",
                vcodec: "avc1.640028",
                tbr: 1500,
                protocol: "m3u8-native",
            }),
        ]);

        expect(result.current.ytDlpFormats).toHaveLength(1);
        expect(result.current.ytDlpFormats[0].format_id).toBe("137-DRC");
        expect(result.current.ytDlpFormats[0].display_name).toBe(
            "Native · 720p · MP4 · AVC (H.264) · 1500 kbps · DRC · M3U8"
        );
    });

    it("builds merged/video-only/audio-only labels with ext fallback, decimal bitrate and dash protocol", async () => {
        const { result } = renderLoader();

        await loadFormats(result, [
            makeFormat({
                format_id: "248",
                has_video: true,
                has_audio: false,
                height: 480,
                ext: "webm",
                vcodec: "av01.0.05M.08",
                tbr: 750.5,
                protocol: "dash-multi",
                filesize_bytes: 300000,
            }),
            makeFormat({
                format_id: "140",
                has_video: false,
                has_audio: true,
                ext: "m4a",
                abr: 128,
                filesize_bytes: 50000,
            }),
        ]);

        expect(result.current.ytDlpFormats.map((format) => format.format_id)).toEqual([
            "248+140",
            "248",
            "140",
        ]);

        const merged = result.current.ytDlpFormats[0];
        expect(merged.display_name).toBe("Merged · 480p · WEBM · AV1 · 750.5 kbps · DASH");
        expect(merged.ext).toBe("webm");
        expect(merged.media_type).toBe("video");
        expect(merged.has_video).toBe(true);
        expect(merged.has_audio).toBe(true);
        expect(merged.filesize_bytes).toBe(350000);
        expect(merged.height).toBe(480);
        expect(merged.abr).toBe(128);
        expect(merged.tbr).toBe(750.5);
        expect(merged.vcodec).toBe("av01.0.05M.08");
        expect(merged.protocol).toBe("dash-multi");

        expect(result.current.ytDlpFormats[1].display_name).toBe(
            "Video only · 480p · WEBM · AV1 · 750.5 kbps · DASH"
        );
        expect(result.current.ytDlpFormats[2].display_name).toBe(
            "Audio only · M4A · 128 kbps"
        );
    });

    it("builds an audio-only label using its own ext when there is no video to merge with", async () => {
        const { result } = renderLoader();

        await loadFormats(result, [
            makeFormat({
                format_id: "171",
                has_video: false,
                has_audio: true,
                ext: "opus",
                abr: 64.5,
                protocol: null,
            }),
        ]);

        expect(result.current.ytDlpFormats[0].display_name).toBe("Audio only · OPUS · 64.5 kbps");
    });

    it("omits the abr segment for an audio-only format with zero bitrate", async () => {
        const { result } = renderLoader();

        await loadFormats(result, [
            makeFormat({
                format_id: "wav1",
                has_video: false,
                has_audio: true,
                ext: "wav",
                abr: 0,
            }),
        ]);

        expect(result.current.ytDlpFormats[0].display_name).toBe("Audio only · WAV");
    });

    it.each([
        ["avc1.640028", "AVC (H.264)"],
        ["av01.0.05M.08", "AV1"],
        ["vp9.2", "VP9"],
        ["hev1.1.6.L93.B0", "HEVC (H.265)"],
        ["hvc1.1.6.L93.B0", "HEVC (H.265)"],
    ])("maps vcodec %s to codec label %s", async (vcodec, expectedLabel) => {
        const { result } = renderLoader();

        await loadFormats(result, [
            makeFormat({ format_id: "x", has_video: true, has_audio: true, vcodec }),
        ]);

        expect(result.current.ytDlpFormats[0].display_name).toBe(
            `Native · Unknown · MP4 · ${expectedLabel}`
        );
    });

    it.each([["none"], [null]])(
        "omits the codec segment when vcodec is %s",
        async (vcodec) => {
            const { result } = renderLoader();

            await loadFormats(result, [
                makeFormat({ format_id: "x", has_video: true, has_audio: true, vcodec }),
            ]);

            expect(result.current.ytDlpFormats[0].display_name).toBe("Native · Unknown · MP4");
        }
    );

    it("falls back to the raw trimmed vcodec when it does not match a known codec prefix", async () => {
        const { result } = renderLoader();

        await loadFormats(result, [
            makeFormat({
                format_id: "x",
                has_video: true,
                has_audio: true,
                vcodec: "  MP4A.40.2 ",
            }),
        ]);

        expect(result.current.ytDlpFormats[0].display_name).toBe(
            "Native · Unknown · MP4 · MP4A.40.2"
        );
    });

    it.each([
        ["HTTP", "HTTPS"],
        ["https", "HTTPS"],
        ["hls-m3u8-live", "M3U8"],
        ["mpd-dash-1", "DASH"],
        ["rtmp", "RTMP"],
        ["httpss", "HTTPSS"],
    ])("maps protocol %s to %s", async (protocol, expectedLabel) => {
        const { result } = renderLoader();

        await loadFormats(result, [
            makeFormat({ format_id: "x", has_video: true, has_audio: true, protocol }),
        ]);

        expect(result.current.ytDlpFormats[0].display_name).toBe(
            `Native · Unknown · MP4 · ${expectedLabel}`
        );
    });

    it.each([[""], [null], ["   "]])(
        "omits the protocol segment when protocol is %s",
        async (protocol) => {
            const { result } = renderLoader();

            await loadFormats(result, [
                makeFormat({ format_id: "x", has_video: true, has_audio: true, protocol }),
            ]);

            expect(result.current.ytDlpFormats[0].display_name).toBe("Native · Unknown · MP4");
        }
    );

    it.each([["137-drc"], ["137-DRC"]])(
        "appends DRC for format id %s regardless of case",
        async (formatId) => {
            const { result } = renderLoader();

            await loadFormats(result, [
                makeFormat({ format_id: formatId, has_video: true, has_audio: true }),
            ]);

            expect(result.current.ytDlpFormats[0].display_name).toBe("Native · Unknown · MP4 · DRC");
        }
    );

    it.each([["137drc"], ["drc-137"]])(
        "does not append DRC when the id does not end with -drc for %s",
        async (formatId) => {
            const { result } = renderLoader();

            await loadFormats(result, [
                makeFormat({ format_id: formatId, has_video: true, has_audio: true }),
            ]);

            expect(result.current.ytDlpFormats[0].display_name).toBe("Native · Unknown · MP4");
        }
    );

    it("treats a height of exactly zero as unknown resolution, not 0p", async () => {
        const { result } = renderLoader();

        await loadFormats(result, [
            makeFormat({ format_id: "x", has_video: true, has_audio: true, height: 0 }),
        ]);

        expect(result.current.ytDlpFormats[0].display_name).toContain("Unknown");
        expect(result.current.ytDlpFormats[0].display_name).not.toContain("0p");
    });

    it("renders the smallest positive resolution as 1p", async () => {
        const { result } = renderLoader();

        await loadFormats(result, [
            makeFormat({ format_id: "x", has_video: true, has_audio: true, height: 1 }),
        ]);

        expect(result.current.ytDlpFormats[0].display_name).toBe("Native · 1p · MP4");
    });

    it.each([[""], ["   "]])("falls back to BIN for ext %s", async (ext) => {
        const { result } = renderLoader();

        await loadFormats(result, [
            makeFormat({ format_id: "x", has_video: true, has_audio: true, ext }),
        ]);

        expect(result.current.ytDlpFormats[0].display_name).toBe("Native · Unknown · BIN");
    });

    it("uppercases a mixed-case ext", async () => {
        const { result } = renderLoader();

        await loadFormats(result, [
            makeFormat({ format_id: "x", has_video: true, has_audio: true, ext: "Mp4" }),
        ]);

        expect(result.current.ytDlpFormats[0].display_name).toBe("Native · Unknown · MP4");
    });
});

describe("useYtDlpFormatLoader - merge eligibility and duplicate removal", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("does not create a merged format when the preferred audio has a blank id, and drops the blank-id audio entry", async () => {
        const { result } = renderLoader();

        await loadFormats(result, [
            makeFormat({ format_id: "v1", has_video: true, has_audio: false, height: 360 }),
            makeFormat({
                format_id: "   ",
                has_video: false,
                has_audio: true,
                ext: "m4a",
                abr: 128,
            }),
        ]);

        expect(result.current.ytDlpFormats).toHaveLength(1);
        expect(result.current.ytDlpFormats[0].format_id).toBe("v1");
        expect(
            result.current.ytDlpFormats.some((format) => format.format_id.includes("+"))
        ).toBe(false);
    });

    it("falls back to mp4 when both the video and preferred audio ext are blank", async () => {
        const { result } = renderLoader();

        await loadFormats(result, [
            makeFormat({ format_id: "v1", has_video: true, has_audio: false, ext: "" }),
            makeFormat({ format_id: "a1", has_video: false, has_audio: true, ext: "", abr: 64 }),
        ]);

        const merged = result.current.ytDlpFormats.find((f) => f.format_id === "v1+a1");
        expect(merged?.ext).toBe("mp4");
    });

    it("falls back to the preferred audio ext when the video ext is blank", async () => {
        const { result } = renderLoader();

        await loadFormats(result, [
            makeFormat({ format_id: "v1", has_video: true, has_audio: false, ext: "" }),
            makeFormat({
                format_id: "a1",
                has_video: false,
                has_audio: true,
                ext: "opus",
                abr: 64,
            }),
        ]);

        const merged = result.current.ytDlpFormats.find((f) => f.format_id === "v1+a1");
        expect(merged?.ext).toBe("opus");
    });

    it("sets a null merged filesize when both source filesizes are zero or null", async () => {
        const { result } = renderLoader();

        await loadFormats(result, [
            makeFormat({
                format_id: "v1",
                has_video: true,
                has_audio: false,
                filesize_bytes: null,
            }),
            makeFormat({
                format_id: "a1",
                has_video: false,
                has_audio: true,
                abr: 64,
                filesize_bytes: null,
            }),
        ]);

        const merged = result.current.ytDlpFormats.find((f) => f.format_id === "v1+a1");
        expect(merged?.filesize_bytes).toBeNull();
    });

    it("removes a duplicate format id, keeping the one preferred by the audio comparator", async () => {
        const { result } = renderLoader();

        await loadFormats(result, [
            makeFormat({
                format_id: "dup1",
                has_video: false,
                has_audio: true,
                ext: "webm",
                abr: 50,
            }),
            makeFormat({
                format_id: "dup1",
                has_video: false,
                has_audio: true,
                ext: "webm",
                abr: 100,
            }),
        ]);

        const dupEntries = result.current.ytDlpFormats.filter((f) => f.format_id === "dup1");
        expect(dupEntries).toHaveLength(1);
        expect(dupEntries[0].display_name).toContain("100 kbps");
    });

    it("keeps the higher-resolution duplicate video-only format id (compareVideoPreference ordering)", async () => {
        const { result } = renderLoader();

        await loadFormats(result, [
            makeFormat({
                format_id: "dup-video",
                has_video: true,
                has_audio: false,
                height: 240,
            }),
            makeFormat({
                format_id: "dup-video",
                has_video: true,
                has_audio: false,
                height: 1080,
            }),
        ]);

        const dupEntries = result.current.ytDlpFormats.filter(
            (f) => f.format_id === "dup-video"
        );
        expect(dupEntries).toHaveLength(1);
        expect(dupEntries[0].height).toBe(1080);
    });

    it("keeps the higher-tbr duplicate video-only format id when resolution ties", async () => {
        const { result } = renderLoader();

        await loadFormats(result, [
            makeFormat({
                format_id: "dup-video-tbr",
                has_video: true,
                has_audio: false,
                height: 480,
                tbr: 500,
            }),
            makeFormat({
                format_id: "dup-video-tbr",
                has_video: true,
                has_audio: false,
                height: 480,
                tbr: 5000,
            }),
        ]);

        const dupEntries = result.current.ytDlpFormats.filter(
            (f) => f.format_id === "dup-video-tbr"
        );
        expect(dupEntries).toHaveLength(1);
        expect(dupEntries[0].tbr).toBe(5000);
    });

    it("keeps the larger duplicate video-only format id when resolution and tbr tie", async () => {
        const { result } = renderLoader();

        await loadFormats(result, [
            makeFormat({
                format_id: "dup-video-size",
                has_video: true,
                has_audio: false,
                height: 480,
                tbr: 500,
                filesize_bytes: 100,
            }),
            makeFormat({
                format_id: "dup-video-size",
                has_video: true,
                has_audio: false,
                height: 480,
                tbr: 500,
                filesize_bytes: 90000,
            }),
        ]);

        const dupEntries = result.current.ytDlpFormats.filter(
            (f) => f.format_id === "dup-video-size"
        );
        expect(dupEntries).toHaveLength(1);
        expect(dupEntries[0].filesize_bytes).toBe(90000);
    });
});

describe("useYtDlpFormatLoader - preferred audio selection (compareAudioPreference)", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("prefers an m4a audio candidate over one with higher abr/filesize", async () => {
        const { result } = renderLoader();

        await loadFormats(result, [
            makeFormat({ format_id: "v1", has_video: true, has_audio: false, height: 480 }),
            makeFormat({
                format_id: "low-m4a",
                has_video: false,
                has_audio: true,
                ext: "m4a",
                abr: 32,
                filesize_bytes: 100,
            }),
            makeFormat({
                format_id: "hi-other",
                has_video: false,
                has_audio: true,
                ext: "webm",
                abr: 320,
                filesize_bytes: 900000,
            }),
        ]);

        expect(
            result.current.ytDlpFormats.some((f) => f.format_id === "v1+low-m4a")
        ).toBe(true);
    });

    it("prefers higher abr over higher filesize when the m4a boost ties", async () => {
        const { result } = renderLoader();

        await loadFormats(result, [
            makeFormat({ format_id: "v1", has_video: true, has_audio: false, height: 480 }),
            makeFormat({
                format_id: "abr-lo",
                has_video: false,
                has_audio: true,
                ext: "webm",
                abr: 64,
                filesize_bytes: 9000,
            }),
            makeFormat({
                format_id: "abr-hi",
                has_video: false,
                has_audio: true,
                ext: "webm",
                abr: 192,
                filesize_bytes: 100,
            }),
        ]);

        expect(result.current.ytDlpFormats.some((f) => f.format_id === "v1+abr-hi")).toBe(true);
    });

    it("prefers higher filesize when the m4a boost and abr tie", async () => {
        const { result } = renderLoader();

        await loadFormats(result, [
            makeFormat({ format_id: "v1", has_video: true, has_audio: false, height: 480 }),
            makeFormat({
                format_id: "size-lo",
                has_video: false,
                has_audio: true,
                ext: "webm",
                abr: 128,
                filesize_bytes: 100,
            }),
            makeFormat({
                format_id: "size-hi",
                has_video: false,
                has_audio: true,
                ext: "webm",
                abr: 128,
                filesize_bytes: 9000,
            }),
        ]);

        expect(result.current.ytDlpFormats.some((f) => f.format_id === "v1+size-hi")).toBe(true);
    });

    it("breaks a full tie using a numeric-aware id comparison", async () => {
        const { result } = renderLoader();

        await loadFormats(result, [
            makeFormat({ format_id: "v1", has_video: true, has_audio: false, height: 480 }),
            makeFormat({
                format_id: "id10",
                has_video: false,
                has_audio: true,
                ext: "webm",
                abr: 128,
                filesize_bytes: 100,
            }),
            makeFormat({
                format_id: "id2",
                has_video: false,
                has_audio: true,
                ext: "webm",
                abr: 128,
                filesize_bytes: 100,
            }),
        ]);

        expect(result.current.ytDlpFormats.some((f) => f.format_id === "v1+id2")).toBe(true);
    });
});

describe("useYtDlpFormatLoader - final display ordering (compareDisplayOrder)", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("orders categories as merged, then native, then video-only, then audio-only", async () => {
        const { result } = renderLoader();

        await loadFormats(result, [
            makeFormat({ format_id: "audio1", has_video: false, has_audio: true, ext: "m4a", abr: 64 }),
            makeFormat({ format_id: "video1", has_video: true, has_audio: false, height: 240 }),
            makeFormat({ format_id: "native1", has_video: true, has_audio: true, height: 1080 }),
        ]);

        const ids = result.current.ytDlpFormats.map((f) => f.format_id);
        expect(ids).toEqual(["video1+audio1", "native1", "video1", "audio1"]);
    });

    it("orders same-rank formats by resolution, then abr, then bitrate, then filesize, then a numeric id", async () => {
        const { result } = renderLoader();

        // All are native (same sort_rank) so every remaining tie-break level in
        // compareDisplayOrder gets exercised in a single deterministic chain: each
        // pair below ties on every earlier criterion and differs only on the next one.
        await loadFormats(result, [
            makeFormat({ format_id: "i10", has_video: true, has_audio: true, height: 100, abr: 10, tbr: 100, filesize_bytes: 100 }),
            makeFormat({ format_id: "d-hi-tbr", has_video: true, has_audio: true, height: 480, abr: 100, tbr: 5000 }),
            makeFormat({ format_id: "i2", has_video: true, has_audio: true, height: 100, abr: 10, tbr: 100, filesize_bytes: 100 }),
            makeFormat({ format_id: "n-hi-res", has_video: true, has_audio: true, height: 1080 }),
            makeFormat({ format_id: "f-lo-size", has_video: true, has_audio: true, height: 240, abr: 50, tbr: 500, filesize_bytes: 1000 }),
            makeFormat({ format_id: "b-lo-abr", has_video: true, has_audio: true, height: 720, abr: 50 }),
            makeFormat({ format_id: "d-lo-tbr", has_video: true, has_audio: true, height: 480, abr: 100, tbr: 1000 }),
            makeFormat({ format_id: "f-hi-size", has_video: true, has_audio: true, height: 240, abr: 50, tbr: 500, filesize_bytes: 90000 }),
            makeFormat({ format_id: "b-hi-abr", has_video: true, has_audio: true, height: 720, abr: 200 }),
        ]);

        const ids = result.current.ytDlpFormats.map((f) => f.format_id);
        expect(ids).toEqual([
            "n-hi-res",
            "b-hi-abr",
            "b-lo-abr",
            "d-hi-tbr",
            "d-lo-tbr",
            "f-hi-size",
            "f-lo-size",
            "i2",
            "i10",
        ]);
    });
});

describe("useYtDlpFormatLoader - inferPreferredFormatId", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("prefers a merged format id over a native one when both exist", async () => {
        const { result } = renderLoader();

        await loadFormats(result, [
            makeFormat({ format_id: "native1", has_video: true, has_audio: true, height: 1080 }),
            makeFormat({ format_id: "v1", has_video: true, has_audio: false, height: 480 }),
            makeFormat({ format_id: "a1", has_video: false, has_audio: true, ext: "m4a", abr: 128 }),
        ]);

        expect(result.current.selectedYtDlpFormatId).toBe("v1+a1");
    });

    it("prefers the native format id when no merged format is available", async () => {
        const { result } = renderLoader();

        await loadFormats(result, [
            makeFormat({ format_id: "native-only", has_video: true, has_audio: true, height: 720 }),
        ]);

        expect(result.current.selectedYtDlpFormatId).toBe("native-only");
    });

    it("falls back to the first format id when neither merged nor native formats exist", async () => {
        const { result } = renderLoader();

        await loadFormats(result, [
            makeFormat({ format_id: "vo-2nd", has_video: true, has_audio: false, height: 240 }),
            makeFormat({ format_id: "vo-1st", has_video: true, has_audio: false, height: 1080 }),
        ]);

        expect(result.current.selectedYtDlpFormatId).toBe("vo-1st");
    });

    it("returns an empty selection and logs it when no formats are returned", async () => {
        const { result, onTerminalLog } = renderLoader();

        await loadFormats(result, []);

        expect(result.current.selectedYtDlpFormatId).toBe("");
        expect(onTerminalLog).toHaveBeenCalledWith("No compatible formats were returned.");
    });
});

describe("useYtDlpFormatLoader - inferSelectedMediaType", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("resolves the media type from the selected format after loading", async () => {
        const { result, onMediaTypeResolved } = renderLoader();

        await loadFormats(result, [
            makeFormat({
                format_id: "a1",
                media_type: "audio",
                has_video: false,
                has_audio: true,
                ext: "m4a",
                abr: 128,
            }),
        ]);

        expect(result.current.selectedYtDlpMediaType).toBe("audio");
        expect(onMediaTypeResolved).toHaveBeenCalledWith("audio");
    });

    it("falls back to the first format's media type when the selection does not match any format", async () => {
        const { result, onMediaTypeResolved } = renderLoader();

        await loadFormats(result, [
            makeFormat({
                format_id: "a1",
                media_type: "audio",
                has_video: false,
                has_audio: true,
                ext: "m4a",
                abr: 128,
            }),
        ]);

        onMediaTypeResolved.mockClear();

        act(() => {
            result.current.setSelectedYtDlpFormatId("does-not-exist");
        });

        expect(onMediaTypeResolved).toHaveBeenCalledWith("audio");
    });

    it("defaults to video when there are no formats and the selection is unknown", () => {
        const { result, onMediaTypeResolved } = renderLoader();

        act(() => {
            result.current.setSelectedYtDlpFormatId("missing");
        });

        expect(onMediaTypeResolved).toHaveBeenCalledWith("video");
    });
});

describe("useYtDlpFormatLoader - setSelectedYtDlpFormatId trimming", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("trims the stored selected format id", () => {
        const { result } = renderLoader();

        act(() => {
            result.current.setSelectedYtDlpFormatId("  raw-id  ");
        });

        expect(result.current.selectedYtDlpFormatId).toBe("raw-id");
    });
});

describe("useYtDlpFormatLoader - command building", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("prefers --cookies with a path over --cookies-from-browser when both are set", async () => {
        const { result, onTerminalStart } = renderLoader({
            getCookiesPath: () => "  /home/user/cookies.txt  ",
            getCookiesBrowser: () => "chrome",
        });

        await loadFormats(result, []);

        // The terminal preview redacts the cookies path so it is not leaked in the UI or a
        // pasted bug report...
        expect(onTerminalStart).toHaveBeenCalledWith(
            "format-loader",
            "yt-dlp -v --ignore-config --no-playlist --dump-single-json --no-warnings --cookies <redacted> https://youtube.com/watch?v=abc"
        );
        // ...but the real path is still handed to the backend command.
        expect(listYtDlpFormats).toHaveBeenCalledWith(
            "https://youtube.com/watch?v=abc",
            "chrome",
            "/home/user/cookies.txt"
        );
    });

    it("uses --cookies-from-browser when no cookies path is given", async () => {
        const { result, onTerminalStart } = renderLoader({
            getCookiesBrowser: () => "  firefox  ",
        });

        await loadFormats(result, []);

        expect(onTerminalStart).toHaveBeenCalledWith(
            "format-loader",
            "yt-dlp -v --ignore-config --no-playlist --dump-single-json --no-warnings --cookies-from-browser firefox https://youtube.com/watch?v=abc"
        );
        expect(listYtDlpFormats).toHaveBeenCalledWith(
            "https://youtube.com/watch?v=abc",
            "firefox",
            null
        );
    });

    it("omits cookie flags entirely when neither is provided", async () => {
        const { result, onTerminalStart } = renderLoader();

        await loadFormats(result, []);

        expect(onTerminalStart).toHaveBeenCalledWith(
            "format-loader",
            "yt-dlp -v --ignore-config --no-playlist --dump-single-json --no-warnings https://youtube.com/watch?v=abc"
        );
        expect(listYtDlpFormats).toHaveBeenCalledWith(
            "https://youtube.com/watch?v=abc",
            null,
            null
        );
    });

    it("trims surrounding whitespace from the url before issuing the request", async () => {
        const { result } = renderLoader({
            getUrl: () => "  https://youtube.com/watch?v=abc  ",
        });

        await loadFormats(result, []);

        expect(listYtDlpFormats).toHaveBeenCalledWith(
            "https://youtube.com/watch?v=abc",
            null,
            null
        );
    });

    it("logs 'Loading formats...' as soon as the load starts", async () => {
        const { result, onTerminalLog } = renderLoader();

        await loadFormats(result, []);

        expect(onTerminalLog.mock.calls[0]).toEqual(["Loading formats..."]);
    });

    it("ignores a second concurrent load call while one is already in flight", async () => {
        let resolveFormats: (value: YtDlpFormatsResult) => void = () => {};
        vi.mocked(listYtDlpFormats).mockReturnValueOnce(
            new Promise<YtDlpFormatsResult>((resolve) => {
                resolveFormats = resolve;
            })
        );

        const { result } = renderLoader();

        let firstPromise: Promise<void> = Promise.resolve();
        act(() => {
            firstPromise = result.current.loadYtDlpFormats();
        });

        expect(result.current.isLoadingYtDlpFormats).toBe(true);

        let secondPromise: Promise<void> = Promise.resolve();
        act(() => {
            secondPromise = result.current.loadYtDlpFormats();
        });

        expect(listYtDlpFormats).toHaveBeenCalledTimes(1);

        await act(async () => {
            resolveFormats(resultWithFormats([]));
            await firstPromise;
            await secondPromise;
        });

        expect(result.current.isLoadingYtDlpFormats).toBe(false);
    });
});

describe("useYtDlpFormatLoader - result handling and logging", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("logs each terminal log line from the response, then the loaded count and selection", async () => {
        const { result, onTerminalLog } = renderLoader();

        await loadFormats(
            result,
            [makeFormat({ format_id: "abc123", has_video: true, has_audio: true, height: 480 })],
            { terminal_logs: ["probing url", "found 1 format"] }
        );

        expect(onTerminalLog.mock.calls.map((call) => call[0])).toEqual([
            "Loading formats...",
            "probing url",
            "found 1 format",
            "Formats loaded successfully: 1",
            "Selected default format: abc123",
        ]);
    });

    it("tolerates a missing terminal_logs field without throwing", async () => {
        const { result, onTerminalLog } = renderLoader();

        vi.mocked(listYtDlpFormats).mockResolvedValueOnce({
            suggested_title: "",
            formats: [],
        } as unknown as YtDlpFormatsResult);

        await act(async () => {
            await result.current.loadYtDlpFormats();
        });

        expect(result.current.ytDlpFormats).toEqual([]);
        expect(onTerminalLog).toHaveBeenCalledWith("Formats loaded successfully: 0");
    });

    it("tolerates a missing formats field without throwing", async () => {
        const { result } = renderLoader();

        vi.mocked(listYtDlpFormats).mockResolvedValueOnce({
            suggested_title: "",
            terminal_logs: [],
        } as unknown as YtDlpFormatsResult);

        await act(async () => {
            await result.current.loadYtDlpFormats();
        });

        expect(result.current.ytDlpFormats).toEqual([]);
        expect(result.current.selectedYtDlpFormatId).toBe("");
    });

    it("suggests the title only when the current title is empty and a suggestion exists", async () => {
        const { result, onSuggestedTitle } = renderLoader({ getCurrentTitle: () => "" });

        await loadFormats(result, [], { suggested_title: "Cool Video" });

        expect(onSuggestedTitle).toHaveBeenCalledWith("Cool Video");
    });

    it("does not suggest a title when the current title is already set", async () => {
        const { result, onSuggestedTitle } = renderLoader({
            getCurrentTitle: () => "Existing Title",
        });

        await loadFormats(result, [], { suggested_title: "Cool Video" });

        expect(onSuggestedTitle).not.toHaveBeenCalled();
    });

    it("does not suggest a title when the suggestion is blank", async () => {
        const { result, onSuggestedTitle } = renderLoader({ getCurrentTitle: () => "" });

        await loadFormats(result, [], { suggested_title: "   " });

        expect(onSuggestedTitle).not.toHaveBeenCalled();
    });

    it("logs the automatic merge notice when some raw formats are video-only", async () => {
        const { result, onTerminalLog } = renderLoader();

        await loadFormats(result, [
            makeFormat({ format_id: "native1", has_video: true, has_audio: true, height: 720 }),
            makeFormat({ format_id: "video1", has_video: true, has_audio: false, height: 480 }),
            makeFormat({ format_id: "audio1", has_video: false, has_audio: true, ext: "m4a", abr: 128 }),
        ]);

        expect(onTerminalLog).toHaveBeenCalledWith(
            "Merged video + audio options were generated automatically."
        );
    });

    it("does not log the merge notice when there is no video-only format", async () => {
        const { result, onTerminalLog } = renderLoader();

        await loadFormats(result, [
            makeFormat({ format_id: "native1", has_video: true, has_audio: true, height: 720 }),
        ]);

        expect(onTerminalLog).not.toHaveBeenCalledWith(
            "Merged video + audio options were generated automatically."
        );
    });
});

describe("useYtDlpFormatLoader - error handling", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("logs the fallback error message without a details line for a plain Error", async () => {
        const { result, onTerminalLog, onTerminalStop, onMediaTypeResolved } = renderLoader();

        vi.mocked(listYtDlpFormats).mockRejectedValueOnce(new Error("network down"));

        await expect(
            act(async () => {
                await result.current.loadYtDlpFormats();
            })
        ).rejects.toThrow("network down");

        expect(onTerminalLog).toHaveBeenCalledWith("ERROR: Failed to load yt-dlp formats.");
        expect(result.current.ytDlpFormats).toEqual([]);
        expect(result.current.selectedYtDlpFormatId).toBe("");
        expect(onMediaTypeResolved).toHaveBeenCalledWith("video");
        expect(result.current.isLoadingYtDlpFormats).toBe(false);
        expect(onTerminalStop).toHaveBeenCalled();
    });

    it("appends a trimmed details line when the error carries string details", async () => {
        const { result, onTerminalLog } = renderLoader();

        const error = Object.assign(new Error("boom"), { details: "  stack trace line 1  " });
        vi.mocked(listYtDlpFormats).mockRejectedValueOnce(error);

        await expect(
            act(async () => {
                await result.current.loadYtDlpFormats();
            })
        ).rejects.toThrow();

        expect(onTerminalLog).toHaveBeenCalledWith(
            "ERROR: Failed to load yt-dlp formats.\nstack trace line 1"
        );
    });

    it("does not append a details line when details is blank", async () => {
        const { result, onTerminalLog } = renderLoader();

        const error = Object.assign(new Error("boom"), { details: "   " });
        vi.mocked(listYtDlpFormats).mockRejectedValueOnce(error);

        await expect(
            act(async () => {
                await result.current.loadYtDlpFormats();
            })
        ).rejects.toThrow();

        expect(onTerminalLog).toHaveBeenCalledWith("ERROR: Failed to load yt-dlp formats.");
    });

    it("surfaces a catalogued backend error's details exactly once, not duplicated", async () => {
        const { result, onTerminalLog } = renderLoader();

        // A real backend AppError arrives as a structured object. resolveErrorMessage already
        // folds its `details` into the message via the "Details:" block; the loader must not
        // append them a second time (the regression this guards).
        vi.mocked(listYtDlpFormats).mockRejectedValueOnce({
            code: "YT_DLP_METADATA_FAILED",
            message: "yt-dlp: unable to extract",
            details: "traceback-info-xyz",
        });

        await expect(
            act(async () => {
                await result.current.loadYtDlpFormats();
            })
        ).rejects.toBeDefined();

        const errorLine = onTerminalLog.mock.calls
            .map((call) => String(call[0]))
            .find((line) => line.startsWith("ERROR:"));

        expect(errorLine).toBe(
            "ERROR: yt-dlp could not load media information for this URL.\n\nDetails: traceback-info-xyz"
        );
        expect(errorLine?.split("traceback-info-xyz")).toHaveLength(2);
    });

    it("does not append a details line when details is not a string", async () => {
        const { result, onTerminalLog } = renderLoader();

        const error = Object.assign(new Error("boom"), { details: 12345 });
        vi.mocked(listYtDlpFormats).mockRejectedValueOnce(error);

        await expect(
            act(async () => {
                await result.current.loadYtDlpFormats();
            })
        ).rejects.toThrow();

        expect(onTerminalLog).toHaveBeenCalledWith("ERROR: Failed to load yt-dlp formats.");
    });

    it("handles a plain string throw without crashing or appending details", async () => {
        const { result, onTerminalLog } = renderLoader();

        vi.mocked(listYtDlpFormats).mockRejectedValueOnce("plain string failure");

        await expect(
            act(async () => {
                await result.current.loadYtDlpFormats();
            })
        ).rejects.toBe("plain string failure");

        expect(onTerminalLog).toHaveBeenCalledWith("ERROR: Failed to load yt-dlp formats.");
    });

    it("discards a stale error after a reset mid-load, without rethrowing or logging an ERROR line", async () => {
        let rejectFormats: (error: unknown) => void = () => {};
        vi.mocked(listYtDlpFormats).mockReturnValueOnce(
            new Promise<YtDlpFormatsResult>((_resolve, reject) => {
                rejectFormats = reject;
            })
        );

        const { result, onTerminalLog, onTerminalStop } = renderLoader();

        let loadPromise: Promise<void> = Promise.resolve();
        act(() => {
            loadPromise = result.current.loadYtDlpFormats();
        });

        act(() => {
            result.current.resetYtDlpFormats();
        });

        await act(async () => {
            rejectFormats(new Error("late failure"));
            await loadPromise;
        });

        expect(result.current.ytDlpFormats).toEqual([]);
        expect(result.current.selectedYtDlpFormatId).toBe("");
        expect(
            onTerminalLog.mock.calls.some((call) => String(call[0]).startsWith("ERROR"))
        ).toBe(false);
        expect(onTerminalStop).toHaveBeenCalled();
    });
});