import type {
    AppDiagnostics,
    DiagnosticsIssue,
    DiagnosticsIssueExample,
    DiagnosticsMediaTarget,
    DiagnosticsOverview,
    DiagnosticsOverviewStatus,
} from "../types/diagnostics";

// How old a yt-dlp release has to be before the diagnostics mention it. Deliberately generous:
// yt-dlp ships very often, so a stricter threshold would nag about a version that still works,
// and this only ever suggests an update - it never blocks a download.
const YT_DLP_STALE_AFTER_DAYS = 60;

function compareIssueSeverity(left: DiagnosticsIssue, right: DiagnosticsIssue): number {
    const rank: Record<DiagnosticsIssue["severity"], number> = {
        error: 0,
        warning: 1,
        info: 2,
    };

    return rank[left.severity] - rank[right.severity];
}

export function sortDiagnosticsIssues(issues: DiagnosticsIssue[]): DiagnosticsIssue[] {
    return [...issues].sort(compareIssueSeverity);
}

// Attaches concrete example paths to an issue so the user can see and act on the specific files
// manually (the diagnostics only report - they never delete). Blank entries are dropped and the
// `examples` key is omitted entirely when nothing remains, so an issue with no examples stays a
// plain { code, severity, title, description } object. `resolveMedia`, when given, turns a path
// into a jump-to-the-media target (used for missing media, whose row still exists).
function withExamples(
    issue: DiagnosticsIssue,
    paths: string[],
    resolveMedia?: (path: string) => DiagnosticsMediaTarget | undefined
): DiagnosticsIssue {
    const examples: DiagnosticsIssueExample[] = paths
        .map((path) => path.trim())
        .filter((path) => path.length > 0)
        .map((path) => {
            const media = resolveMedia?.(path);

            return media ? { path, media } : { path };
        });

    return examples.length > 0 ? { ...issue, examples } : issue;
}

export function buildDiagnosticsIssues(
    input: AppDiagnostics,
    mediaByPath: Record<string, DiagnosticsMediaTarget> = {}
): DiagnosticsIssue[] {
    const issues: DiagnosticsIssue[] = [];

    // A "missing media" path is a media row whose file vanished on disk - the row still exists,
    // so it can be opened in the library. Resolve each such path to its media so the UI can jump
    // to it (keyed like the integrity service builds the map: trimmed, forward slashes).
    const resolveMissingMedia = (path: string): DiagnosticsMediaTarget | undefined =>
        mediaByPath[path.trim().replace(/\\/g, "/")];

    const totalLibraryMediaFiles =
        input.librarySummary.video_files + input.librarySummary.audio_files;

    if (!input.libraryPath.trim()) {
        issues.push({
            code: "LIBRARY_PATH_NOT_CONFIGURED",
            severity: "error",
            title: "Library folder not configured",
            description: "Choose a valid library folder before importing or downloading media.",
        });
    }

    if (!input.externalTools.yt_dlp.healthy) {
        issues.push({
            code: "YT_DLP_NOT_AVAILABLE",
            severity: "warning",
            title: "yt-dlp is not available",
            description:
                "URL imports will not work until yt-dlp is installed or configured correctly.",
        });
    }

    // yt-dlp breaks against YouTube whenever the site changes, and the fix is almost always just
    // updating it. Without this, that failure reaches the user as yt-dlp's own raw extractor error
    // in the terminal panel, which says nothing about the copy on their PATH being old - so the
    // app looks broken when it is not. The backend reports the age (yt-dlp versions are dates);
    // deciding when an age is worth mentioning is a diagnostics rule, so it lives here with the
    // rest of them. Informational rather than a warning: an old yt-dlp often still works fine, and
    // this must not read as "something is wrong" when nothing is.
    const ytDlpAgeDays = input.externalTools.yt_dlp.release_age_days;

    if (
        input.externalTools.yt_dlp.healthy &&
        ytDlpAgeDays !== null &&
        ytDlpAgeDays > YT_DLP_STALE_AFTER_DAYS
    ) {
        issues.push({
            code: "YT_DLP_OUTDATED",
            severity: "info",
            title: "yt-dlp may be out of date",
            description: `The installed yt-dlp was released ${ytDlpAgeDays} days ago. YouTube changes often break older versions, so update it (for example with "yt-dlp -U") if downloads start failing.`,
        });
    }

    if (!input.externalTools.ffmpeg.healthy) {
        issues.push({
            code: "FFMPEG_NOT_AVAILABLE",
            severity: "warning",
            title: "ffmpeg is not available",
            description:
                "Some media processing flows may fail until ffmpeg is installed or configured correctly.",
        });
    }

    if (input.libraryPath.trim() && input.librarySummary.total_bytes === 0) {
        issues.push({
            code: "LIBRARY_EMPTY",
            severity: "info",
            title: "Library is empty",
            description: "The library folder is configured, but no files are currently stored in it.",
        });
    }

    if (input.mediaRepositoryStats.total_media === 0 && totalLibraryMediaFiles > 0) {
        issues.push({
            code: "LIBRARY_FILES_WITHOUT_DATABASE_ROWS",
            severity: "warning",
            title: "Library contains files, but database has no indexed media",
            description:
                "Media files were found in the library folder, but no media records exist in the database.",
        });
    }

    if (
        input.mediaRepositoryStats.total_with_thumbnail === 0 &&
        input.librarySummary.thumbnail_files > 0
    ) {
        issues.push({
            code: "THUMBNAILS_WITHOUT_DATABASE_ROWS",
            severity: "info",
            title: "Thumbnail files exist without indexed media",
            description:
                "Thumbnail files were found in the library folder, but the database does not reference any thumbnails.",
        });
    }

    if (
        input.mediaRepositoryStats.total_media > 0 &&
        totalLibraryMediaFiles === 0
    ) {
        issues.push({
            code: "DATABASE_MEDIA_WITHOUT_LIBRARY_FILES",
            severity: "warning",
            title: "Database has media, but library files were not found",
            description:
                "There are media records in the database, but no media files were counted in the library folder.",
        });
    }

    if (
        input.mediaRepositoryStats.total_with_thumbnail > 0 &&
        input.librarySummary.thumbnail_files === 0
    ) {
        issues.push({
            code: "DATABASE_THUMBNAILS_WITHOUT_LIBRARY_FILES",
            severity: "warning",
            title: "Database has thumbnails, but thumbnail files were not found",
            description:
                "There are media records with thumbnails, but no thumbnail files were counted in the library folder.",
        });
    }

    if (
        input.librarySummary.thumbnail_files > 0 &&
        totalLibraryMediaFiles === 0
    ) {
        issues.push({
            code: "THUMBNAILS_WITHOUT_MEDIA_FILES",
            severity: "info",
            title: "Thumbnail files exist without media files",
            description:
                "The library contains thumbnail files, but no media files were counted.",
        });
    }

    if (
        input.mediaRepositoryStats.total_media > 0 &&
        input.mediaRepositoryStats.total_without_thumbnail === input.mediaRepositoryStats.total_media
    ) {
        issues.push({
            code: "MEDIA_WITHOUT_THUMBNAILS",
            severity: "info",
            title: "All media items are missing thumbnails",
            description:
                "Every media record in the database currently has no thumbnail associated with it.",
        });
    }

    if (input.libraryIntegrity.missing_media_files > 0) {
        issues.push(
            withExamples(
                {
                    code: "MISSING_MEDIA_FILES_ON_DISK",
                    severity: "warning",
                    title: "Some media files are missing on disk",
                    description: `${input.libraryIntegrity.missing_media_files} media file(s) referenced by the database were not found in the library folder.`,
                },
                input.libraryIntegrity.missing_media_examples,
                resolveMissingMedia
            )
        );
    }

    if (input.libraryIntegrity.missing_thumbnail_files > 0) {
        issues.push(
            withExamples(
                {
                    code: "MISSING_THUMBNAIL_FILES_ON_DISK",
                    severity: "info",
                    title: "Some thumbnail files are missing on disk",
                    description: `${input.libraryIntegrity.missing_thumbnail_files} thumbnail file(s) referenced by the database were not found in the library folder.`,
                },
                input.libraryIntegrity.missing_thumbnail_examples
            )
        );
    }

    if (input.libraryIntegrity.corrupt_media_files > 0) {
        issues.push(
            withExamples(
                {
                    code: "CORRUPT_MEDIA_FILES_ON_DISK",
                    severity: "warning",
                    title: "Some media files are empty or corrupted",
                    description: `${input.libraryIntegrity.corrupt_media_files} media file(s) exist in the library folder but are zero bytes, so the file is truncated or corrupted rather than a healthy backup.`,
                },
                input.libraryIntegrity.corrupt_media_examples,
                resolveMissingMedia
            )
        );
    }

    if (input.libraryIntegrity.corrupt_thumbnail_files > 0) {
        issues.push(
            withExamples(
                {
                    code: "CORRUPT_THUMBNAIL_FILES_ON_DISK",
                    severity: "info",
                    title: "Some thumbnail files are empty or corrupted",
                    description: `${input.libraryIntegrity.corrupt_thumbnail_files} thumbnail file(s) exist in the library folder but are zero bytes, so the file is truncated or corrupted.`,
                },
                input.libraryIntegrity.corrupt_thumbnail_examples
            )
        );
    }

    if (input.libraryIntegrity.orphan_media_files > 0) {
        issues.push(
            withExamples(
                {
                    code: "ORPHAN_MEDIA_FILES",
                    severity: "info",
                    title: "Orphan media files were found",
                    description: `${input.libraryIntegrity.orphan_media_files} media file(s) exist in the library folder without a linked database record.`,
                },
                input.libraryIntegrity.orphan_media_examples
            )
        );
    }

    if (input.libraryIntegrity.orphan_thumbnail_files > 0) {
        issues.push(
            withExamples(
                {
                    code: "ORPHAN_THUMBNAIL_FILES",
                    severity: "info",
                    title: "Orphan thumbnail files were found",
                    description: `${input.libraryIntegrity.orphan_thumbnail_files} thumbnail file(s) exist in the library folder without a linked database record.`,
                },
                input.libraryIntegrity.orphan_thumbnail_examples
            )
        );
    }

    const invalidPathCount =
        input.libraryIntegrity.invalid_media_files +
        input.libraryIntegrity.invalid_thumbnail_files;

    if (invalidPathCount > 0) {
        issues.push(
            withExamples(
                {
                    code: "INVALID_PATH_REFERENCES",
                    severity: "warning",
                    title: "Some database paths point outside the library",
                    description: `${invalidPathCount} database record(s) reference an absolute or out-of-library path instead of a managed library-relative one. This usually means corrupted or manually edited data.`,
                },
                [
                    ...input.libraryIntegrity.invalid_media_examples,
                    ...input.libraryIntegrity.invalid_thumbnail_examples,
                ]
            )
        );
    }

    if (input.liveChatIntegrity.missing_live_chat_files > 0) {
        issues.push(
            withExamples(
                {
                    code: "MISSING_LIVE_CHAT_FILES",
                    severity: "warning",
                    title: "Some live chat replay files are missing",
                    description: `${input.liveChatIntegrity.missing_live_chat_files} live chat file(s) referenced by the database were not found in app storage.`,
                },
                input.liveChatIntegrity.missing_live_chat_examples
            )
        );
    }

    if (input.liveChatIntegrity.orphan_live_chat_files > 0) {
        issues.push(
            withExamples(
                {
                    code: "ORPHAN_LIVE_CHAT_FILES",
                    severity: "info",
                    title: "Orphan live chat replay files were found",
                    description: `${input.liveChatIntegrity.orphan_live_chat_files} live chat file(s) exist in app storage without a linked media record.`,
                },
                input.liveChatIntegrity.orphan_live_chat_examples
            )
        );
    }

    if (input.mediaRepositoryStats.total_media_with_live_chat_flag_but_no_path > 0) {
        issues.push({
            code: "LIVE_CHAT_FLAG_WITHOUT_PATH",
            severity: "warning",
            title: "Some media items are marked with live chat but have no file path",
            description: `${input.mediaRepositoryStats.total_media_with_live_chat_flag_but_no_path} media item(s) have live chat enabled in the database but no saved file path.`,
        });
    }

    if (input.mediaRepositoryStats.total_media_with_live_chat_path_but_not_live > 0) {
        issues.push({
            code: "LIVE_CHAT_ON_NON_LIVE_MEDIA",
            severity: "info",
            title: "Some non-live media items have a live chat file linked",
            description: `${input.mediaRepositoryStats.total_media_with_live_chat_path_but_not_live} media item(s) are not marked as live but still have a live chat replay file linked.`,
        });
    }

    return sortDiagnosticsIssues(issues);
}

export function buildDiagnosticsOverview(issues: DiagnosticsIssue[]): DiagnosticsOverview {
    const errorCount = issues.filter((item) => item.severity === "error").length;
    const warningCount = issues.filter((item) => item.severity === "warning").length;
    const infoCount = issues.filter((item) => item.severity === "info").length;

    let status: DiagnosticsOverviewStatus = "healthy";
    let headline = "Everything looks good";
    let description = "No blocking issues were detected in the current environment.";

    if (errorCount > 0) {
        status = "error";
        headline = "Action required";
        description =
            "One or more blocking issues were detected. Some features may not work correctly.";
    } else if (warningCount > 0) {
        status = "warning";
        headline = "Attention needed";
        description =
            "The application is usable, but some features may be limited until these issues are resolved.";
    } else if (infoCount > 0) {
        status = "healthy";
        headline = "Environment is healthy";
        description =
            "The app is working, but there are a few informational items worth checking.";
    }

    return {
        status,
        issueCount: issues.length,
        errorCount,
        warningCount,
        infoCount,
        headline,
        description,
    };
}