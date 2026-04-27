import { getVersion } from "@tauri-apps/api/app";
import { getMediaRepositoryStats } from "../repositories/media-repository";
import type {
    AppDiagnostics,
    DiagnosticsSummary,
} from "../types/diagnostics";
import type { ImportMode } from "../types/settings";
import {
    buildDiagnosticsIssues,
    buildDiagnosticsOverview,
} from "./diagnostics-rules";
import { getLibraryIntegrity } from "./diagnostics-library-integrity";
import { getLibrarySummary } from "./diagnostics-library-summary";
import { getExternalToolsStatus } from "./diagnostics-external-tools";
import { getRuntimeDiagnosticsInfo } from "./diagnostics-runtime";
import { getLiveChatStorageSummary } from "./diagnostics-live-chat-storage";
import { getLiveChatIntegrity } from "./diagnostics-live-chat-integrity";

type GetDiagnosticsInput = {
    libraryPath: string;
    importMode: ImportMode;
};

export async function getDiagnosticsSummary(
    input: GetDiagnosticsInput
): Promise<DiagnosticsSummary> {
    const normalizedLibraryPath = input.libraryPath.trim();

    const [
        appVersion,
        runtimeInfo,
        externalTools,
        librarySummary,
        liveChatStorage,
        mediaRepositoryStats,
        libraryIntegrity,
        liveChatIntegrity,
    ] = await Promise.all([
        getVersion().catch(() => null),
        getRuntimeDiagnosticsInfo(),
        getExternalToolsStatus(),
        getLibrarySummary(normalizedLibraryPath),
        getLiveChatStorageSummary(),
        getMediaRepositoryStats(),
        getLibraryIntegrity(normalizedLibraryPath),
        getLiveChatIntegrity(),
    ]);

    const diagnostics: AppDiagnostics = {
        appVersion,
        platform: runtimeInfo.platform,
        arch: runtimeInfo.arch,
        libraryPath: normalizedLibraryPath,
        importMode: input.importMode,
        externalTools,
        librarySummary,
        liveChatStorage,
        mediaRepositoryStats,
        libraryIntegrity,
        liveChatIntegrity,
    };

    const issues = buildDiagnosticsIssues(diagnostics);
    const overview = buildDiagnosticsOverview(issues);

    return {
        diagnostics,
        issues,
        overview,
    };
}