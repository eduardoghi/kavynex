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
        checked_live_chat_files: 0,
        missing_live_chat_files: 0,
        missing_live_chat_examples: [],
        corrupt_live_chat_files: 0,
        corrupt_live_chat_examples: [],
        orphan_live_chat_files: 0,
        orphan_live_chat_examples: [],
        invalid_live_chat_files: 0,
        invalid_live_chat_examples: [],
    };
}

// Live chat integrity is a projection of the single backend library-integrity check (the only
// side that can stat the files), rather than a separate pass: this is what gives live chat the
// same missing/corrupt/orphan detection media and thumbnails get.
function deriveLiveChatIntegrity(report: LibraryIntegrityReport): LiveChatIntegrityReport {
    return {
        checked_live_chat_files: report.checked_live_chat_files,
        missing_live_chat_files: report.missing_live_chat_files,
        missing_live_chat_examples: report.missing_live_chat_examples,
        corrupt_live_chat_files: report.corrupt_live_chat_files,
        corrupt_live_chat_examples: report.corrupt_live_chat_examples,
        orphan_live_chat_files: report.orphan_live_chat_files,
        orphan_live_chat_examples: report.orphan_live_chat_examples,
    };
}

// One entry per check: the code and label a failure is reported under, and how the check runs.
// These used to be three lists kept in step by position (the labels here, the calls passed to
// `Promise.allSettled`, and the destructuring of its results), which is the shape where a check
// added to one list and not the others turns into the wrong label on a failure and the wrong
// value in a field, with nothing failing. Everything now derives from this one table: the runs
// are read off it, the results come back keyed by the same names, and the failure report reads
// the label of the entry whose run rejected. The library path is bound here, once, because two
// of the checks take it and a runner that takes no argument is what lets `settleAll` stay typed.
function diagnosticChecks(libraryPath: string) {
    return {
        appVersion: { code: "APP_VERSION", label: "app version", run: () => getVersion() },
        runtimeInfo: {
            code: "RUNTIME_INFO",
            label: "runtime information",
            run: () => getRuntimeDiagnosticsInfo(),
        },
        externalTools: {
            code: "EXTERNAL_TOOLS",
            label: "external tools",
            run: () => getExternalToolsStatus(),
        },
        librarySummary: {
            code: "LIBRARY_SUMMARY",
            label: "library summary",
            run: () => getLibrarySummary(libraryPath),
        },
        liveChatStorage: {
            code: "LIVE_CHAT_STORAGE",
            label: "live chat storage",
            run: () => getLiveChatStorageSummary(),
        },
        mediaStats: {
            code: "MEDIA_STATS",
            label: "media statistics",
            run: () => getMediaRepositoryStats(),
        },
        libraryIntegrity: {
            code: "LIBRARY_INTEGRITY",
            label: "library integrity",
            run: () => getLibraryIntegrity(libraryPath),
        },
    } as const;
}

type DiagnosticChecks = ReturnType<typeof diagnosticChecks>;
type DiagnosticCheckKey = keyof DiagnosticChecks;

// The settled result of every check, under the same key as its entry in the table, and typed as
// what that entry's `run` resolves to. The whole point of keying rather than destructuring a
// positional array: a result cannot land in the wrong field because there is no position.
type SettledChecks = {
    [K in DiagnosticCheckKey]: PromiseSettledResult<Awaited<ReturnType<DiagnosticChecks[K]["run"]>>>;
};

// `Promise.allSettled` over the table's runners, re-keyed. Every check runs regardless of how the
// others end (a rejected check is a warning issue below, never a failed report), which is what
// allSettled is for. The assertion is the price of allSettled returning
// `PromiseSettledResult<unknown>[]` for a heterogeneous input: each result is put back under the
// key whose runner produced it, at the same index it came out, so it states that one-to-one
// mapping rather than guessing at a type.
async function settleAll(checks: DiagnosticChecks): Promise<SettledChecks> {
    const keys = Object.keys(checks) as DiagnosticCheckKey[];
    const settled = await Promise.allSettled(keys.map((key) => checks[key].run()));

    return Object.fromEntries(keys.map((key, index) => [key, settled[index]])) as SettledChecks;
}

// A rejected sub-check is replaced by its zeroed default so the rest of the report can still
// render. On its own that would make the failed dimension read as "healthy" (0 missing, 0
// orphan, ...). Turn each failure into a warning issue (and log the underlying reason), so the
// overview stops showing a false all-clear and the user is told the report is incomplete.
function collectCheckFailureIssues(
    checks: DiagnosticChecks,
    settled: SettledChecks
): DiagnosticsIssue[] {
    const issues: DiagnosticsIssue[] = [];

    for (const key of Object.keys(checks) as DiagnosticCheckKey[]) {
        const result = settled[key];

        if (result.status !== "rejected") {
            continue;
        }

        const { code, label } = checks[key];

        logError("diagnostics", `The ${label} diagnostics check failed to run.`, result.reason);

        issues.push({
            code: `DIAGNOSTIC_CHECK_FAILED:${code}`,
            severity: "warning",
            title: `Could not run the ${label} check`,
            description:
                "This check did not complete, so the values shown for it may be incomplete or missing. Check the logs and try again.",
        });
    }

    return issues;
}

export async function getDiagnosticsSummary(
    input: GetDiagnosticsInput
): Promise<DiagnosticsSummary> {
    const normalizedLibraryPath = input.libraryPath.trim();

    const checks = diagnosticChecks(normalizedLibraryPath);
    const settled = await settleAll(checks);

    const libraryIntegrityResult = settledValue(settled.libraryIntegrity, {
        report: defaultLibraryIntegrity(),
        mediaByPath: {},
    });

    const runtimeInfo = settledValue(settled.runtimeInfo, defaultRuntimeInfo());

    const diagnostics: AppDiagnostics = {
        appVersion: settledValue(settled.appVersion, null),
        platform: runtimeInfo.platform,
        arch: runtimeInfo.arch,
        libraryPath: normalizedLibraryPath,
        importMode: input.importMode,
        externalTools: settledValue(settled.externalTools, defaultExternalToolsStatus()),
        librarySummary: settledValue(settled.librarySummary, defaultLibrarySummary()),
        liveChatStorage: settledValue(settled.liveChatStorage, defaultLiveChatStorageSummary()),
        mediaRepositoryStats: settledValue(settled.mediaStats, defaultMediaRepositoryStats()),
        libraryIntegrity: libraryIntegrityResult.report,
        liveChatIntegrity: deriveLiveChatIntegrity(libraryIntegrityResult.report),
    };

    const issues = sortDiagnosticsIssues([
        ...collectCheckFailureIssues(checks, settled),
        ...buildDiagnosticsIssues(diagnostics, libraryIntegrityResult.mediaByPath),
    ]);
    const overview = buildDiagnosticsOverview(issues);

    return {
        diagnostics,
        issues,
        overview,
    };
}
