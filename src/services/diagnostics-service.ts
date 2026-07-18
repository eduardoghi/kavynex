import { getVersion } from "../lib/tauri-platform";
import { getMediaRepositoryStats } from "../repositories/media-repository";
import type {
    AppDiagnostics,
    DiagnosticsIssue,
    DiagnosticsSummary,
    ExternalToolsStatus,
    LibraryIntegrityReport,
    LibrarySummaryInfo,
    LiveChatIntegrityReport,
    LiveChatStorageInfo,
    MediaRepositoryStats,
    RuntimeDiagnosticsInfo,
} from "../types/diagnostics";
import type { ImportMode } from "../types/settings";
import { logError } from "../utils/app-logger";
import {
    buildDiagnosticsIssues,
    buildDiagnosticsOverview,
    sortDiagnosticsIssues,
} from "./diagnostics-rules";
import { getLibraryIntegrity } from "./diagnostics-library-integrity";
import { getLibrarySummary } from "./diagnostics-library-summary";
import { createEmptyLibrarySummary } from "./library-service";
import { getExternalToolsStatus } from "./diagnostics-external-tools";
import { getRuntimeDiagnosticsInfo } from "./diagnostics-runtime";
import { getLiveChatStorageSummary } from "./diagnostics-live-chat-storage";
import { getLiveChatIntegrity } from "./diagnostics-live-chat-integrity";

type GetDiagnosticsInput = {
    libraryPath: string;
    importMode: ImportMode;
};

function settledValue<T>(result: PromiseSettledResult<T>, fallback: T): T {
    return result.status === "fulfilled" ? result.value : fallback;
}

function defaultRuntimeInfo(): RuntimeDiagnosticsInfo {
    return {
        platform: "unknown",
        arch: "unknown",
    };
}

function defaultExternalToolsStatus(): ExternalToolsStatus {
    return {
        yt_dlp: {
            path: "",
            version: "",
            healthy: false,
            // No version was read at all, so there is no release date to age: an unhealthy tool
            // has its own issue to report and must not also be called out as merely outdated.
            release_age_days: null,
        },
        ffmpeg: {
            path: "",
            version: "",
            healthy: false,
            release_age_days: null,
        },
    };
}

function defaultLibrarySummary(): LibrarySummaryInfo {
    return createEmptyLibrarySummary();
}

function defaultLiveChatStorageSummary(): LiveChatStorageInfo {
    return {
        live_chat_files: 0,
    };
}

function defaultMediaRepositoryStats(): MediaRepositoryStats {
    return {
        total_media: 0,
        total_video_media: 0,
        total_audio_media: 0,
        total_with_thumbnail: 0,
        total_without_thumbnail: 0,
        total_watched: 0,
        total_unwatched: 0,
        total_live_media: 0,
        total_with_live_chat: 0,
        total_without_live_chat: 0,
        total_media_with_live_chat_flag_but_no_path: 0,
        total_media_with_live_chat_path_but_not_live: 0,
    };
}

function defaultLibraryIntegrity(): LibraryIntegrityReport {
    return {
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
        corrupt_media_files: 0,
        corrupt_media_examples: [],
        corrupt_thumbnail_files: 0,
        corrupt_thumbnail_examples: [],
    };
}

function defaultLiveChatIntegrity(): LiveChatIntegrityReport {
    return {
        checked_live_chat_files: 0,
        missing_live_chat_files: 0,
        missing_live_chat_examples: [],
        orphan_live_chat_files: 0,
        orphan_live_chat_examples: [],
    };
}

// Labels for each check, in the exact order of the Promise.allSettled array below. A rejected
// check is reported to the user by index, so this must stay in sync with that array.
const DIAGNOSTIC_CHECKS = [
    { code: "APP_VERSION", label: "app version" },
    { code: "RUNTIME_INFO", label: "runtime information" },
    { code: "EXTERNAL_TOOLS", label: "external tools" },
    { code: "LIBRARY_SUMMARY", label: "library summary" },
    { code: "LIVE_CHAT_STORAGE", label: "live chat storage" },
    { code: "MEDIA_STATS", label: "media statistics" },
    { code: "LIBRARY_INTEGRITY", label: "library integrity" },
    { code: "LIVE_CHAT_INTEGRITY", label: "live chat integrity" },
] as const;

// A rejected sub-check is replaced by its zeroed default so the rest of the report can still
// render. On its own that would make the failed dimension read as "healthy" (0 missing, 0
// orphan, ...). Turn each failure into a warning issue - and log the underlying reason - so the
// overview stops showing a false all-clear and the user is told the report is incomplete.
function collectCheckFailureIssues(
    settled: readonly PromiseSettledResult<unknown>[]
): DiagnosticsIssue[] {
    const issues: DiagnosticsIssue[] = [];

    settled.forEach((result, index) => {
        if (result.status !== "rejected") {
            return;
        }

        const check = DIAGNOSTIC_CHECKS[index];
        const label = check?.label ?? "diagnostic";

        logError("diagnostics", `The ${label} diagnostics check failed to run.`, result.reason);

        issues.push({
            code: `DIAGNOSTIC_CHECK_FAILED:${check?.code ?? index}`,
            severity: "warning",
            title: `Could not run the ${label} check`,
            description:
                "This check did not complete, so the values shown for it may be incomplete or missing. Check the logs and try again.",
        });
    });

    return issues;
}

export async function getDiagnosticsSummary(
    input: GetDiagnosticsInput
): Promise<DiagnosticsSummary> {
    const normalizedLibraryPath = input.libraryPath.trim();

    const settled = await Promise.allSettled([
        getVersion(),
        getRuntimeDiagnosticsInfo(),
        getExternalToolsStatus(),
        getLibrarySummary(normalizedLibraryPath),
        getLiveChatStorageSummary(),
        getMediaRepositoryStats(),
        getLibraryIntegrity(normalizedLibraryPath),
        getLiveChatIntegrity(),
    ]);

    const [
        appVersion,
        runtimeInfo,
        externalTools,
        librarySummary,
        liveChatStorage,
        mediaRepositoryStats,
        libraryIntegrity,
        liveChatIntegrity,
    ] = settled;

    const libraryIntegrityResult = settledValue(libraryIntegrity, {
        report: defaultLibraryIntegrity(),
        mediaByPath: {},
    });

    const diagnostics: AppDiagnostics = {
        appVersion: settledValue(appVersion, null),
        platform: settledValue(runtimeInfo, defaultRuntimeInfo()).platform,
        arch: settledValue(runtimeInfo, defaultRuntimeInfo()).arch,
        libraryPath: normalizedLibraryPath,
        importMode: input.importMode,
        externalTools: settledValue(externalTools, defaultExternalToolsStatus()),
        librarySummary: settledValue(librarySummary, defaultLibrarySummary()),
        liveChatStorage: settledValue(liveChatStorage, defaultLiveChatStorageSummary()),
        mediaRepositoryStats: settledValue(mediaRepositoryStats, defaultMediaRepositoryStats()),
        libraryIntegrity: libraryIntegrityResult.report,
        liveChatIntegrity: settledValue(liveChatIntegrity, defaultLiveChatIntegrity()),
    };

    const issues = sortDiagnosticsIssues([
        ...collectCheckFailureIssues(settled),
        ...buildDiagnosticsIssues(diagnostics, libraryIntegrityResult.mediaByPath),
    ]);
    const overview = buildDiagnosticsOverview(issues);

    return {
        diagnostics,
        issues,
        overview,
    };
}
