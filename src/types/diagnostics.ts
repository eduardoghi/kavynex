// Generated from the Rust structs by ts-rs (ExternalToolStatus comes from
// `ExternalToolHealth`). Imported (not just re-exported) so other types here can use them.
import type { ExternalToolStatus } from "./generated/ExternalToolStatus";
import type { ExternalToolsStatus } from "./generated/ExternalToolsStatus";

export type { ExternalToolStatus, ExternalToolsStatus };

// Generated from the Rust structs by ts-rs. Imported so other types here can reference them.
import type { LibrarySummaryInfo } from "./generated/LibrarySummaryInfo";
import type { LibraryIntegrityReport } from "./generated/LibraryIntegrityReport";

export type { LibrarySummaryInfo, LibraryIntegrityReport };

export type LiveChatStorageInfo = {
    live_chat_files: number;
};

// Generated from the Rust structs by ts-rs. Change the Rust struct and regenerate.
// Imported (not just re-exported) so other types in this file can reference them.
import type { MediaRepositoryStats } from "./generated/MediaRepositoryStats";
import type { MediaIntegrityReference } from "./generated/MediaIntegrityReference";

export type { MediaRepositoryStats, MediaIntegrityReference };

export type LiveChatIntegrityReport = {
    checked_live_chat_files: number;
    missing_live_chat_files: number;
    missing_live_chat_examples: string[];
    orphan_live_chat_files: number;
    orphan_live_chat_examples: string[];
};

export type RuntimeDiagnosticsInfo = {
    platform: string;
    arch: string;
};

export type AppDiagnostics = {
    appVersion: string | null;
    platform: string;
    arch: string;
    libraryPath: string;
    importMode: string;
    externalTools: ExternalToolsStatus;
    librarySummary: LibrarySummaryInfo;
    liveChatStorage: LiveChatStorageInfo;
    mediaRepositoryStats: MediaRepositoryStats;
    libraryIntegrity: LibraryIntegrityReport;
    liveChatIntegrity: LiveChatIntegrityReport;
};

export type DiagnosticsIssueSeverity = "info" | "warning" | "error";

export type DiagnosticsIssue = {
    code: string;
    severity: DiagnosticsIssueSeverity;
    title: string;
    description: string;
};

export type DiagnosticsOverviewStatus = "healthy" | "warning" | "error";

export type DiagnosticsOverview = {
    status: DiagnosticsOverviewStatus;
    issueCount: number;
    errorCount: number;
    warningCount: number;
    infoCount: number;
    headline: string;
    description: string;
};

export type DiagnosticsSummary = {
    diagnostics: AppDiagnostics;
    issues: DiagnosticsIssue[];
    overview: DiagnosticsOverview;
};