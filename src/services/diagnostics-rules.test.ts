import { describe, expect, it } from "vitest";
import {
    buildDiagnosticsIssues,
    buildDiagnosticsOverview,
    sortDiagnosticsIssues,
} from "./diagnostics-rules";
import type { AppDiagnostics, DiagnosticsIssue } from "../types/diagnostics";

// A fully "healthy" fixture that triggers none of the rules in buildDiagnosticsIssues.
// Each test below overrides only the fields needed to flip exactly one rule, while
// keeping every other field at a value that keeps the remaining rules silent (verified
// inline in the "no issues" test and by exact assertions in every other test).
function baseDiagnostics(): AppDiagnostics {
    return {
        appVersion: "1.0.0",
        platform: "Windows",
        arch: "x64",
        libraryPath: "/library",
        importMode: "copy",
        externalTools: {
            yt_dlp: { path: "/tools/yt-dlp", version: "2026.01.01", healthy: true, release_age_days: null },
            ffmpeg: { path: "/tools/ffmpeg", version: "7.0", healthy: true, release_age_days: null },
        },
        librarySummary: {
            total_bytes: 1024,
            formatted_size: "1 KB",
            video_files: 1,
            audio_files: 0,
            thumbnail_files: 1,
        },
        liveChatStorage: { live_chat_files: 0 },
        mediaRepositoryStats: {
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
            total_media_with_live_chat_flag_but_no_path: 0,
            total_media_with_live_chat_path_but_not_live: 0,
        },
        libraryIntegrity: {
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
        },
        liveChatIntegrity: {
            checked_live_chat_files: 0,
            missing_live_chat_files: 0,
            missing_live_chat_examples: [],
            orphan_live_chat_files: 0,
            orphan_live_chat_examples: [],
        },
    };
}

describe("buildDiagnosticsIssues", () => {
    it("returns no issues for a fully healthy environment", () => {
        expect(buildDiagnosticsIssues(baseDiagnostics())).toEqual([]);
    });

    it("flags LIBRARY_PATH_NOT_CONFIGURED when the library path is empty", () => {
        const input = baseDiagnostics();
        input.libraryPath = "";

        expect(buildDiagnosticsIssues(input)).toEqual([
            {
                code: "LIBRARY_PATH_NOT_CONFIGURED",
                severity: "error",
                title: "Library folder not configured",
                description: "Choose a valid library folder before importing or downloading media.",
            },
        ]);
    });

    it("flags LIBRARY_PATH_NOT_CONFIGURED when the library path is only whitespace", () => {
        const input = baseDiagnostics();
        input.libraryPath = "   ";

        const issues = buildDiagnosticsIssues(input);

        expect(issues).toHaveLength(1);
        expect(issues[0]!.code).toBe("LIBRARY_PATH_NOT_CONFIGURED");
    });

    it("does not flag LIBRARY_EMPTY when the library path is not configured", () => {
        const input = baseDiagnostics();
        input.libraryPath = "";
        input.librarySummary.total_bytes = 0;

        const codes = buildDiagnosticsIssues(input).map((issue) => issue.code);

        expect(codes).toEqual(["LIBRARY_PATH_NOT_CONFIGURED"]);
        expect(codes).not.toContain("LIBRARY_EMPTY");
    });

    it("flags YT_DLP_NOT_AVAILABLE when yt-dlp is unhealthy", () => {
        const input = baseDiagnostics();
        input.externalTools.yt_dlp.healthy = false;

        expect(buildDiagnosticsIssues(input)).toEqual([
            {
                code: "YT_DLP_NOT_AVAILABLE",
                severity: "warning",
                title: "yt-dlp is not available",
                description:
                    "URL imports will not work until yt-dlp is installed or configured correctly.",
            },
        ]);
    });

    it("flags YT_DLP_OUTDATED once the installed release is old enough", () => {
        const input = baseDiagnostics();
        input.externalTools.yt_dlp.release_age_days = 61;

        expect(buildDiagnosticsIssues(input)).toEqual([
            {
                code: "YT_DLP_OUTDATED",
                severity: "info",
                title: "yt-dlp may be out of date",
                description:
                    'The installed yt-dlp was released 61 days ago. YouTube changes often break older versions, so update it (for example with "yt-dlp -U") if downloads start failing.',
            },
        ]);
    });

    it("stays quiet about a yt-dlp release that is recent, ageless, or exactly at the threshold", () => {
        // `null` is the ffmpeg/unparseable case, and it must not read as "age zero" or as stale.
        // 60 is the threshold itself: the rule fires *past* it, so the boundary stays silent.
        for (const releaseAge of [null, 0, 59, 60]) {
            const input = baseDiagnostics();
            input.externalTools.yt_dlp.release_age_days = releaseAge;

            expect(buildDiagnosticsIssues(input).map((issue) => issue.code)).not.toContain(
                "YT_DLP_OUTDATED"
            );
        }
    });

    it("does not call an unavailable yt-dlp outdated as well", () => {
        // An unhealthy tool already has its own issue; adding "may be out of date" on top would
        // point at the wrong fix, since there is no working copy to update in the first place.
        const input = baseDiagnostics();
        input.externalTools.yt_dlp.healthy = false;
        input.externalTools.yt_dlp.release_age_days = 400;

        const codes = buildDiagnosticsIssues(input).map((issue) => issue.code);

        expect(codes).toContain("YT_DLP_NOT_AVAILABLE");
        expect(codes).not.toContain("YT_DLP_OUTDATED");
    });

    it("flags FFMPEG_NOT_AVAILABLE when ffmpeg is unhealthy", () => {
        const input = baseDiagnostics();
        input.externalTools.ffmpeg.healthy = false;

        expect(buildDiagnosticsIssues(input)).toEqual([
            {
                code: "FFMPEG_NOT_AVAILABLE",
                severity: "warning",
                title: "ffmpeg is not available",
                description:
                    "Some media processing flows may fail until ffmpeg is installed or configured correctly.",
            },
        ]);
    });

    it("flags LIBRARY_EMPTY when the library is configured but has no bytes stored", () => {
        const input = baseDiagnostics();
        input.librarySummary.total_bytes = 0;

        expect(buildDiagnosticsIssues(input)).toEqual([
            {
                code: "LIBRARY_EMPTY",
                severity: "info",
                title: "Library is empty",
                description:
                    "The library folder is configured, but no files are currently stored in it.",
            },
        ]);
    });

    it("flags LIBRARY_FILES_WITHOUT_DATABASE_ROWS when files exist without database rows", () => {
        const input = baseDiagnostics();
        input.mediaRepositoryStats.total_media = 0;
        input.mediaRepositoryStats.total_with_thumbnail = 0;
        input.librarySummary.thumbnail_files = 0;
        // librarySummary.video_files (1) + audio_files (0) keeps totalLibraryMediaFiles > 0

        expect(buildDiagnosticsIssues(input)).toEqual([
            {
                code: "LIBRARY_FILES_WITHOUT_DATABASE_ROWS",
                severity: "warning",
                title: "Library contains files, but database has no indexed media",
                description:
                    "Media files were found in the library folder, but no media records exist in the database.",
            },
        ]);
    });

    it("flags THUMBNAILS_WITHOUT_DATABASE_ROWS when thumbnail files exist without indexed thumbnails", () => {
        const input = baseDiagnostics();
        input.mediaRepositoryStats.total_with_thumbnail = 0;
        // librarySummary.thumbnail_files stays 1 from the base fixture

        expect(buildDiagnosticsIssues(input)).toEqual([
            {
                code: "THUMBNAILS_WITHOUT_DATABASE_ROWS",
                severity: "info",
                title: "Thumbnail files exist without indexed media",
                description:
                    "Thumbnail files were found in the library folder, but the database does not reference any thumbnails.",
            },
        ]);
    });

    it("flags DATABASE_MEDIA_WITHOUT_LIBRARY_FILES when the database has media but no library files", () => {
        const input = baseDiagnostics();
        input.librarySummary.video_files = 0;
        input.librarySummary.audio_files = 0;
        input.librarySummary.thumbnail_files = 0;
        input.mediaRepositoryStats.total_with_thumbnail = 0;
        // mediaRepositoryStats.total_media stays 1 from the base fixture

        expect(buildDiagnosticsIssues(input)).toEqual([
            {
                code: "DATABASE_MEDIA_WITHOUT_LIBRARY_FILES",
                severity: "warning",
                title: "Database has media, but library files were not found",
                description:
                    "There are media records in the database, but no media files were counted in the library folder.",
            },
        ]);
    });

    it("flags DATABASE_THUMBNAILS_WITHOUT_LIBRARY_FILES when the database has thumbnails but no thumbnail files", () => {
        const input = baseDiagnostics();
        input.librarySummary.thumbnail_files = 0;
        // mediaRepositoryStats.total_with_thumbnail stays 1 from the base fixture

        expect(buildDiagnosticsIssues(input)).toEqual([
            {
                code: "DATABASE_THUMBNAILS_WITHOUT_LIBRARY_FILES",
                severity: "warning",
                title: "Database has thumbnails, but thumbnail files were not found",
                description:
                    "There are media records with thumbnails, but no thumbnail files were counted in the library folder.",
            },
        ]);
    });

    it("flags THUMBNAILS_WITHOUT_MEDIA_FILES when thumbnails exist without any media files", () => {
        const input = baseDiagnostics();
        input.librarySummary.video_files = 0;
        input.librarySummary.audio_files = 0;
        input.mediaRepositoryStats.total_media = 0;
        input.mediaRepositoryStats.total_with_thumbnail = 1;
        // librarySummary.thumbnail_files stays 1 from the base fixture

        expect(buildDiagnosticsIssues(input)).toEqual([
            {
                code: "THUMBNAILS_WITHOUT_MEDIA_FILES",
                severity: "info",
                title: "Thumbnail files exist without media files",
                description: "The library contains thumbnail files, but no media files were counted.",
            },
        ]);
    });

    it("flags MEDIA_WITHOUT_THUMBNAILS when every media record lacks a thumbnail", () => {
        const input = baseDiagnostics();
        input.mediaRepositoryStats.total_without_thumbnail = 1;
        // mediaRepositoryStats.total_media stays 1, so total_without_thumbnail === total_media

        expect(buildDiagnosticsIssues(input)).toEqual([
            {
                code: "MEDIA_WITHOUT_THUMBNAILS",
                severity: "info",
                title: "All media items are missing thumbnails",
                description:
                    "Every media record in the database currently has no thumbnail associated with it.",
            },
        ]);
    });

    it("does not flag MEDIA_WITHOUT_THUMBNAILS when only some media records lack a thumbnail", () => {
        const input = baseDiagnostics();
        input.mediaRepositoryStats.total_media = 2;
        input.mediaRepositoryStats.total_with_thumbnail = 1;
        input.mediaRepositoryStats.total_without_thumbnail = 1;

        const codes = buildDiagnosticsIssues(input).map((issue) => issue.code);

        expect(codes).not.toContain("MEDIA_WITHOUT_THUMBNAILS");
    });

    it("flags MISSING_MEDIA_FILES_ON_DISK with the exact missing count in the description", () => {
        const input = baseDiagnostics();
        input.libraryIntegrity.missing_media_files = 3;

        expect(buildDiagnosticsIssues(input)).toEqual([
            {
                code: "MISSING_MEDIA_FILES_ON_DISK",
                severity: "warning",
                title: "Some media files are missing on disk",
                description:
                    "3 media file(s) referenced by the database were not found in the library folder.",
            },
        ]);
    });

    it("flags MISSING_THUMBNAIL_FILES_ON_DISK with the exact missing count in the description", () => {
        const input = baseDiagnostics();
        input.libraryIntegrity.missing_thumbnail_files = 2;

        expect(buildDiagnosticsIssues(input)).toEqual([
            {
                code: "MISSING_THUMBNAIL_FILES_ON_DISK",
                severity: "info",
                title: "Some thumbnail files are missing on disk",
                description:
                    "2 thumbnail file(s) referenced by the database were not found in the library folder.",
            },
        ]);
    });

    it("flags ORPHAN_MEDIA_FILES with the exact orphan count in the description", () => {
        const input = baseDiagnostics();
        input.libraryIntegrity.orphan_media_files = 4;

        expect(buildDiagnosticsIssues(input)).toEqual([
            {
                code: "ORPHAN_MEDIA_FILES",
                severity: "info",
                title: "Orphan media files were found",
                description:
                    "4 media file(s) exist in the library folder without a linked database record.",
            },
        ]);
    });

    it("flags ORPHAN_THUMBNAIL_FILES with the exact orphan count in the description", () => {
        const input = baseDiagnostics();
        input.libraryIntegrity.orphan_thumbnail_files = 5;

        expect(buildDiagnosticsIssues(input)).toEqual([
            {
                code: "ORPHAN_THUMBNAIL_FILES",
                severity: "info",
                title: "Orphan thumbnail files were found",
                description:
                    "5 thumbnail file(s) exist in the library folder without a linked database record.",
            },
        ]);
    });

    it("flags MISSING_LIVE_CHAT_FILES with the exact missing count in the description", () => {
        const input = baseDiagnostics();
        input.liveChatIntegrity.missing_live_chat_files = 2;

        expect(buildDiagnosticsIssues(input)).toEqual([
            {
                code: "MISSING_LIVE_CHAT_FILES",
                severity: "warning",
                title: "Some live chat replay files are missing",
                description:
                    "2 live chat file(s) referenced by the database were not found in app storage.",
            },
        ]);
    });

    it("flags ORPHAN_LIVE_CHAT_FILES with the exact orphan count in the description", () => {
        const input = baseDiagnostics();
        input.liveChatIntegrity.orphan_live_chat_files = 3;

        expect(buildDiagnosticsIssues(input)).toEqual([
            {
                code: "ORPHAN_LIVE_CHAT_FILES",
                severity: "info",
                title: "Orphan live chat replay files were found",
                description:
                    "3 live chat file(s) exist in app storage without a linked media record.",
            },
        ]);
    });

    it("flags LIVE_CHAT_FLAG_WITHOUT_PATH with the exact affected count in the description", () => {
        const input = baseDiagnostics();
        input.mediaRepositoryStats.total_media_with_live_chat_flag_but_no_path = 1;

        expect(buildDiagnosticsIssues(input)).toEqual([
            {
                code: "LIVE_CHAT_FLAG_WITHOUT_PATH",
                severity: "warning",
                title: "Some media items are marked with live chat but have no file path",
                description:
                    "1 media item(s) have live chat enabled in the database but no saved file path.",
            },
        ]);
    });

    it("flags LIVE_CHAT_ON_NON_LIVE_MEDIA with the exact affected count in the description", () => {
        const input = baseDiagnostics();
        input.mediaRepositoryStats.total_media_with_live_chat_path_but_not_live = 6;

        expect(buildDiagnosticsIssues(input)).toEqual([
            {
                code: "LIVE_CHAT_ON_NON_LIVE_MEDIA",
                severity: "info",
                title: "Some non-live media items have a live chat file linked",
                description:
                    "6 media item(s) are not marked as live but still have a live chat replay file linked.",
            },
        ]);
    });

    it("attaches example paths to ORPHAN_MEDIA_FILES so the user can act on them manually", () => {
        const input = baseDiagnostics();
        input.libraryIntegrity.orphan_media_files = 2;
        input.libraryIntegrity.orphan_media_examples = ["video/orphan.mp4", "audio/stray.m4a"];

        const issue = buildDiagnosticsIssues(input)[0]!;

        expect(issue.code).toBe("ORPHAN_MEDIA_FILES");
        // Orphans have no database row, so their examples carry no navigation target.
        expect(issue.examples).toEqual([
            { path: "video/orphan.mp4" },
            { path: "audio/stray.m4a" },
        ]);
    });

    it("resolves a MISSING_MEDIA example path to its media so it can be opened in the library", () => {
        const input = baseDiagnostics();
        input.libraryIntegrity.missing_media_files = 1;
        input.libraryIntegrity.missing_media_examples = ["audio/youtube_abc_140.m4a"];

        const issue = buildDiagnosticsIssues(input, {
            "audio/youtube_abc_140.m4a": { channelId: 7, mediaId: 42 },
        })[0]!;

        expect(issue.code).toBe("MISSING_MEDIA_FILES_ON_DISK");
        expect(issue.examples).toEqual([
            { path: "audio/youtube_abc_140.m4a", media: { channelId: 7, mediaId: 42 } },
        ]);
    });

    it("leaves a MISSING_MEDIA example without a target when the path is not in the media map", () => {
        const input = baseDiagnostics();
        input.libraryIntegrity.missing_media_files = 1;
        input.libraryIntegrity.missing_media_examples = ["audio/unknown.m4a"];

        const issue = buildDiagnosticsIssues(input, {})[0]!;

        expect(issue.examples).toEqual([{ path: "audio/unknown.m4a" }]);
    });

    it("omits the examples key entirely when the count is set but no example paths are provided", () => {
        const input = baseDiagnostics();
        input.libraryIntegrity.orphan_media_files = 4;
        // orphan_media_examples stays [] from the base fixture.

        const issue = buildDiagnosticsIssues(input)[0]!;

        expect(issue.code).toBe("ORPHAN_MEDIA_FILES");
        expect(issue).not.toHaveProperty("examples");
    });

    it("drops blank example entries before attaching them", () => {
        const input = baseDiagnostics();
        input.libraryIntegrity.orphan_thumbnail_files = 1;
        input.libraryIntegrity.orphan_thumbnail_examples = ["  ", "thumbnails/x.jpg", ""];

        const issue = buildDiagnosticsIssues(input)[0]!;

        expect(issue.examples).toEqual([{ path: "thumbnails/x.jpg" }]);
    });

    it("concatenates media and thumbnail example paths for INVALID_PATH_REFERENCES", () => {
        const input = baseDiagnostics();
        input.libraryIntegrity.invalid_media_files = 1;
        input.libraryIntegrity.invalid_media_examples = ["/etc/passwd"];
        input.libraryIntegrity.invalid_thumbnail_files = 1;
        input.libraryIntegrity.invalid_thumbnail_examples = ["../secret.jpg"];

        const issue = buildDiagnosticsIssues(input)[0]!;

        expect(issue.code).toBe("INVALID_PATH_REFERENCES");
        expect(issue.examples).toEqual([{ path: "/etc/passwd" }, { path: "../secret.jpg" }]);
    });

    it("returns issues sorted by severity (errors, then warnings, then infos)", () => {
        const input = baseDiagnostics();
        input.libraryPath = "";
        input.externalTools.yt_dlp.healthy = false;
        input.libraryIntegrity.orphan_media_files = 1;

        const codes = buildDiagnosticsIssues(input).map((issue) => issue.code);

        expect(codes).toEqual([
            "LIBRARY_PATH_NOT_CONFIGURED",
            "YT_DLP_NOT_AVAILABLE",
            "ORPHAN_MEDIA_FILES",
        ]);
    });
});

describe("sortDiagnosticsIssues", () => {
    function issue(code: string, severity: DiagnosticsIssue["severity"]): DiagnosticsIssue {
        return { code, severity, title: code, description: code };
    }

    it("orders issues as error, then warning, then info", () => {
        const issues = [
            issue("INFO_1", "info"),
            issue("WARNING_1", "warning"),
            issue("ERROR_1", "error"),
        ];

        expect(sortDiagnosticsIssues(issues).map((item) => item.code)).toEqual([
            "ERROR_1",
            "WARNING_1",
            "INFO_1",
        ]);
    });

    it("preserves the relative order of issues with the same severity (stable sort)", () => {
        const issues = [
            issue("WARNING_A", "warning"),
            issue("ERROR_A", "error"),
            issue("WARNING_B", "warning"),
            issue("ERROR_B", "error"),
        ];

        expect(sortDiagnosticsIssues(issues).map((item) => item.code)).toEqual([
            "ERROR_A",
            "ERROR_B",
            "WARNING_A",
            "WARNING_B",
        ]);
    });

    it("does not mutate the input array", () => {
        const issues = [issue("WARNING_1", "warning"), issue("ERROR_1", "error")];
        const original = [...issues];

        sortDiagnosticsIssues(issues);

        expect(issues).toEqual(original);
    });

    it("returns an empty array unchanged", () => {
        expect(sortDiagnosticsIssues([])).toEqual([]);
    });
});

describe("buildDiagnosticsOverview", () => {
    function issue(severity: DiagnosticsIssue["severity"], code = severity.toUpperCase()): DiagnosticsIssue {
        return { code, severity, title: code, description: code };
    }

    it("reports a healthy overview with no issues", () => {
        expect(buildDiagnosticsOverview([])).toEqual({
            status: "healthy",
            issueCount: 0,
            errorCount: 0,
            warningCount: 0,
            infoCount: 0,
            headline: "Everything looks good",
            description: "No blocking issues were detected in the current environment.",
        });
    });

    it("reports a warning overview when only warnings are present", () => {
        const issues = [issue("warning"), issue("warning", "WARNING_2")];

        expect(buildDiagnosticsOverview(issues)).toEqual({
            status: "warning",
            issueCount: 2,
            errorCount: 0,
            warningCount: 2,
            infoCount: 0,
            headline: "Attention needed",
            description:
                "The application is usable, but some features may be limited until these issues are resolved.",
        });
    });

    it("reports an error overview when an error is present, even alongside warnings and infos", () => {
        const issues = [issue("info"), issue("warning"), issue("error")];

        expect(buildDiagnosticsOverview(issues)).toEqual({
            status: "error",
            issueCount: 3,
            errorCount: 1,
            warningCount: 1,
            infoCount: 1,
            headline: "Action required",
            description:
                "One or more blocking issues were detected. Some features may not work correctly.",
        });
    });

    it("reports a healthy status with a different headline when only infos are present", () => {
        const issues = [issue("info"), issue("info", "INFO_2")];

        expect(buildDiagnosticsOverview(issues)).toEqual({
            status: "healthy",
            issueCount: 2,
            errorCount: 0,
            warningCount: 0,
            infoCount: 2,
            headline: "Environment is healthy",
            description:
                "The app is working, but there are a few informational items worth checking.",
        });
    });

    it("prioritizes error over warning when both are present", () => {
        const issues = [issue("warning"), issue("error")];

        const overview = buildDiagnosticsOverview(issues);

        expect(overview.status).toBe("error");
        expect(overview.headline).toBe("Action required");
    });

    it("prioritizes warning over info when both are present", () => {
        const issues = [issue("info"), issue("warning")];

        const overview = buildDiagnosticsOverview(issues);

        expect(overview.status).toBe("warning");
        expect(overview.headline).toBe("Attention needed");
    });
});
