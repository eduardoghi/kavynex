import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/app", () => ({
    getVersion: vi.fn(),
}));

vi.mock("./diagnostics-runtime", () => ({
    getRuntimeDiagnosticsInfo: vi.fn(),
}));

vi.mock("./diagnostics-external-tools", () => ({
    getExternalToolsStatus: vi.fn(),
}));

vi.mock("./diagnostics-library-summary", () => ({
    getLibrarySummary: vi.fn(),
}));

vi.mock("./diagnostics-library-integrity", () => ({
    getLibraryIntegrity: vi.fn(),
}));

vi.mock("./diagnostics-live-chat-storage", () => ({
    getLiveChatStorageSummary: vi.fn(),
}));

vi.mock("./diagnostics-live-chat-integrity", () => ({
    getLiveChatIntegrity: vi.fn(),
}));

vi.mock("../repositories/media-repository", () => ({
    getMediaRepositoryStats: vi.fn(),
}));

import { getVersion } from "@tauri-apps/api/app";
import { getMediaRepositoryStats } from "../repositories/media-repository";
import { getExternalToolsStatus } from "./diagnostics-external-tools";
import { getLibraryIntegrity } from "./diagnostics-library-integrity";
import { getLibrarySummary } from "./diagnostics-library-summary";
import { getLiveChatIntegrity } from "./diagnostics-live-chat-integrity";
import { getLiveChatStorageSummary } from "./diagnostics-live-chat-storage";
import { getRuntimeDiagnosticsInfo } from "./diagnostics-runtime";
import { getDiagnosticsSummary } from "./diagnostics-service";

const getVersionMock = vi.mocked(getVersion);
const getRuntimeDiagnosticsInfoMock = vi.mocked(getRuntimeDiagnosticsInfo);
const getExternalToolsStatusMock = vi.mocked(getExternalToolsStatus);
const getLibrarySummaryMock = vi.mocked(getLibrarySummary);
const getMediaRepositoryStatsMock = vi.mocked(getMediaRepositoryStats);
const getLibraryIntegrityMock = vi.mocked(getLibraryIntegrity);
const getLiveChatStorageSummaryMock = vi.mocked(getLiveChatStorageSummary);
const getLiveChatIntegrityMock = vi.mocked(getLiveChatIntegrity);

function createMediaRepositoryStats(
    overrides: Partial<Awaited<ReturnType<typeof getMediaRepositoryStats>>> = {}
): Awaited<ReturnType<typeof getMediaRepositoryStats>> {
    return {
        total_media: 0,
        total_video_media: 0,
        total_audio_media: 0,
        total_live_media: 0,
        total_with_thumbnail: 0,
        total_without_thumbnail: 0,
        total_watched: 0,
        total_unwatched: 0,
        total_with_live_chat: 0,
        total_without_live_chat: 0,
        total_media_with_live_chat_flag_but_no_path: 0,
        total_media_with_live_chat_path_but_not_live: 0,
        ...overrides,
    };
}

function mockHealthyLiveChatDiagnostics(): void {
    getLiveChatStorageSummaryMock.mockResolvedValueOnce({
        live_chat_files: 0,
    });

    getLiveChatIntegrityMock.mockResolvedValueOnce({
        checked_live_chat_files: 0,
        missing_live_chat_files: 0,
        missing_live_chat_examples: [],
        orphan_live_chat_files: 0,
        orphan_live_chat_examples: [],
    });
}

describe("diagnostics-service", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("builds healthy overview when no issues are found", async () => {
        getVersionMock.mockResolvedValueOnce("0.1.0");

        getRuntimeDiagnosticsInfoMock.mockResolvedValueOnce({
            platform: "Windows",
            arch: "x64",
        });

        getExternalToolsStatusMock.mockResolvedValueOnce({
            yt_dlp: {
                path: "/tools/yt-dlp",
                version: "2026.01.01",
                healthy: true,
            },
            ffmpeg: {
                path: "/tools/ffmpeg",
                version: "7.0",
                healthy: true,
            },
        });

        getLibrarySummaryMock.mockResolvedValueOnce({
            total_bytes: 1024,
            formatted_size: "1 KB",
            video_files: 1,
            audio_files: 0,
            thumbnail_files: 1,
        });

        getMediaRepositoryStatsMock.mockResolvedValueOnce(
            createMediaRepositoryStats({
                total_media: 1,
                total_video_media: 1,
                total_audio_media: 0,
                total_live_media: 0,
                total_with_thumbnail: 1,
                total_without_thumbnail: 0,
                total_watched: 0,
                total_unwatched: 1,
                total_with_live_chat: 0,
                total_without_live_chat: 1,
            })
        );

        getLibraryIntegrityMock.mockResolvedValueOnce({
            checked_media_files: 1,
            missing_media_files: 0,
            missing_media_examples: [],
            checked_thumbnail_files: 1,
            missing_thumbnail_files: 0,
            missing_thumbnail_examples: [],
            orphan_media_files: 0,
            orphan_media_examples: [],
            orphan_thumbnail_files: 0,
            orphan_thumbnail_examples: [],
            invalid_media_files: 0,
            invalid_media_examples: [],
            invalid_thumbnail_files: 0,
            invalid_thumbnail_examples: [],
        });

        mockHealthyLiveChatDiagnostics();

        const result = await getDiagnosticsSummary({
            libraryPath: "/library",
            importMode: "copy",
        });

        expect(getRuntimeDiagnosticsInfoMock).toHaveBeenCalled();
        expect(getExternalToolsStatusMock).toHaveBeenCalled();
        expect(getLibrarySummaryMock).toHaveBeenCalledWith("/library");
        expect(getLibraryIntegrityMock).toHaveBeenCalledWith("/library");
        expect(getLiveChatStorageSummaryMock).toHaveBeenCalled();
        expect(getLiveChatIntegrityMock).toHaveBeenCalled();

        expect(result.overview.status).toBe("healthy");
        expect(result.overview.issueCount).toBe(0);
        expect(result.issues).toEqual([]);
        expect(result.diagnostics.platform).toBe("Windows");
        expect(result.diagnostics.arch).toBe("x64");
        expect(result.diagnostics.librarySummary.formatted_size).toBe("1 KB");
        expect(result.diagnostics.mediaRepositoryStats.total_media).toBe(1);
        expect(result.diagnostics.libraryIntegrity.missing_media_files).toBe(0);
    });

    it("creates an error issue when library path is missing", async () => {
        getVersionMock.mockResolvedValueOnce("0.1.0");

        getRuntimeDiagnosticsInfoMock.mockResolvedValueOnce({
            platform: "unknown",
            arch: "unknown",
        });

        getExternalToolsStatusMock.mockResolvedValueOnce({
            yt_dlp: {
                path: "/tools/yt-dlp",
                version: "2026.01.01",
                healthy: true,
            },
            ffmpeg: {
                path: "/tools/ffmpeg",
                version: "7.0",
                healthy: true,
            },
        });

        getLibrarySummaryMock.mockResolvedValueOnce({
            total_bytes: 0,
            formatted_size: "0 B",
            video_files: 0,
            audio_files: 0,
            thumbnail_files: 0,
        });

        getMediaRepositoryStatsMock.mockResolvedValueOnce(createMediaRepositoryStats());

        getLibraryIntegrityMock.mockResolvedValueOnce({
            checked_media_files: 0,
            missing_media_files: 0,
            missing_media_examples: [],
            checked_thumbnail_files: 0,
            missing_thumbnail_files: 0,
            missing_thumbnail_examples: [],
            orphan_media_files: 0,
            orphan_media_examples: [],
            orphan_thumbnail_files: 0,
            orphan_thumbnail_examples: [],
            invalid_media_files: 0,
            invalid_media_examples: [],
            invalid_thumbnail_files: 0,
            invalid_thumbnail_examples: [],
        });

        mockHealthyLiveChatDiagnostics();

        const result = await getDiagnosticsSummary({
            libraryPath: "",
            importMode: "copy",
        });

        expect(result.overview.status).toBe("error");
        expect(result.overview.errorCount).toBe(1);
        expect(result.issues[0]).toMatchObject({
            code: "LIBRARY_PATH_NOT_CONFIGURED",
            severity: "error",
        });
    });

    it("creates warning issues when external tools are unavailable", async () => {
        getVersionMock.mockResolvedValueOnce("0.1.0");

        getRuntimeDiagnosticsInfoMock.mockResolvedValueOnce({
            platform: "Linux",
            arch: "x64",
        });

        getExternalToolsStatusMock.mockResolvedValueOnce({
            yt_dlp: {
                path: "",
                version: "",
                healthy: false,
            },
            ffmpeg: {
                path: "",
                version: "",
                healthy: false,
            },
        });

        getLibrarySummaryMock.mockResolvedValueOnce({
            total_bytes: 1024,
            formatted_size: "1 KB",
            video_files: 1,
            audio_files: 0,
            thumbnail_files: 1,
        });

        getMediaRepositoryStatsMock.mockResolvedValueOnce(
            createMediaRepositoryStats({
                total_media: 1,
                total_video_media: 1,
                total_audio_media: 0,
                total_live_media: 0,
                total_with_thumbnail: 1,
                total_without_thumbnail: 0,
                total_watched: 0,
                total_unwatched: 1,
                total_with_live_chat: 0,
                total_without_live_chat: 1,
            })
        );

        getLibraryIntegrityMock.mockResolvedValueOnce({
            checked_media_files: 1,
            missing_media_files: 0,
            missing_media_examples: [],
            checked_thumbnail_files: 1,
            missing_thumbnail_files: 0,
            missing_thumbnail_examples: [],
            orphan_media_files: 0,
            orphan_media_examples: [],
            orphan_thumbnail_files: 0,
            orphan_thumbnail_examples: [],
            invalid_media_files: 0,
            invalid_media_examples: [],
            invalid_thumbnail_files: 0,
            invalid_thumbnail_examples: [],
        });

        mockHealthyLiveChatDiagnostics();

        const result = await getDiagnosticsSummary({
            libraryPath: "/library",
            importMode: "copy",
        });

        expect(result.overview.status).toBe("warning");
        expect(result.overview.warningCount).toBe(2);
        expect(result.issues.map((item) => item.code)).toEqual([
            "YT_DLP_NOT_AVAILABLE",
            "FFMPEG_NOT_AVAILABLE",
        ]);
    });

    it("creates filesystem consistency issues when database and library disagree", async () => {
        getVersionMock.mockResolvedValueOnce("0.1.0");

        getRuntimeDiagnosticsInfoMock.mockResolvedValueOnce({
            platform: "Windows",
            arch: "x64",
        });

        getExternalToolsStatusMock.mockResolvedValueOnce({
            yt_dlp: {
                path: "/tools/yt-dlp",
                version: "2026.01.01",
                healthy: true,
            },
            ffmpeg: {
                path: "/tools/ffmpeg",
                version: "7.0",
                healthy: true,
            },
        });

        getLibrarySummaryMock.mockResolvedValueOnce({
            total_bytes: 2048,
            formatted_size: "2 KB",
            video_files: 0,
            audio_files: 0,
            thumbnail_files: 0,
        });

        getMediaRepositoryStatsMock.mockResolvedValueOnce(
            createMediaRepositoryStats({
                total_media: 3,
                total_video_media: 3,
                total_audio_media: 0,
                total_live_media: 0,
                total_with_thumbnail: 2,
                total_without_thumbnail: 1,
                total_watched: 1,
                total_unwatched: 2,
                total_with_live_chat: 0,
                total_without_live_chat: 3,
            })
        );

        getLibraryIntegrityMock.mockResolvedValueOnce({
            checked_media_files: 3,
            missing_media_files: 1,
            missing_media_examples: ["video/a.mp4"],
            checked_thumbnail_files: 2,
            missing_thumbnail_files: 1,
            missing_thumbnail_examples: ["thumbs/a.jpg"],
            orphan_media_files: 0,
            orphan_media_examples: [],
            orphan_thumbnail_files: 0,
            orphan_thumbnail_examples: [],
            invalid_media_files: 0,
            invalid_media_examples: [],
            invalid_thumbnail_files: 0,
            invalid_thumbnail_examples: [],
        });

        mockHealthyLiveChatDiagnostics();

        const result = await getDiagnosticsSummary({
            libraryPath: "/library",
            importMode: "copy",
        });

        expect(result.overview.status).toBe("warning");
        expect(result.issues.map((item) => item.code)).toEqual([
            "DATABASE_MEDIA_WITHOUT_LIBRARY_FILES",
            "DATABASE_THUMBNAILS_WITHOUT_LIBRARY_FILES",
            "MISSING_MEDIA_FILES_ON_DISK",
            "MISSING_THUMBNAIL_FILES_ON_DISK",
        ]);
    });

    it("returns a partial summary when one diagnostic check fails", async () => {
        getVersionMock.mockResolvedValueOnce("0.1.0");

        getRuntimeDiagnosticsInfoMock.mockResolvedValueOnce({
            platform: "Windows",
            arch: "x64",
        });

        getExternalToolsStatusMock.mockResolvedValueOnce({
            yt_dlp: {
                path: "/tools/yt-dlp",
                version: "2026.01.01",
                healthy: true,
            },
            ffmpeg: {
                path: "/tools/ffmpeg",
                version: "7.0",
                healthy: true,
            },
        });

        getLibrarySummaryMock.mockRejectedValueOnce(new Error("library scan failed"));
        getMediaRepositoryStatsMock.mockResolvedValueOnce(createMediaRepositoryStats());

        getLibraryIntegrityMock.mockResolvedValueOnce({
            checked_media_files: 0,
            missing_media_files: 0,
            missing_media_examples: [],
            checked_thumbnail_files: 0,
            missing_thumbnail_files: 0,
            missing_thumbnail_examples: [],
            orphan_media_files: 0,
            orphan_media_examples: [],
            orphan_thumbnail_files: 0,
            orphan_thumbnail_examples: [],
            invalid_media_files: 0,
            invalid_media_examples: [],
            invalid_thumbnail_files: 0,
            invalid_thumbnail_examples: [],
        });

        mockHealthyLiveChatDiagnostics();

        const result = await getDiagnosticsSummary({
            libraryPath: "/library",
            importMode: "copy",
        });

        expect(result.diagnostics.platform).toBe("Windows");
        expect(result.diagnostics.librarySummary).toEqual({
            total_bytes: 0,
            formatted_size: "0 B",
            video_files: 0,
            audio_files: 0,
            thumbnail_files: 0,
        });
        expect(result.issues.map((item) => item.code)).toContain("LIBRARY_EMPTY");
    });
});
