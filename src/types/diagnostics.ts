// Generated from the Rust structs by ts-rs (ExternalToolStatus comes from
// `ExternalToolHealth`). Imported (not just re-exported) so other types here can use them.
import type { ExternalToolStatus } from "./generated/ExternalToolStatus";
import type { ExternalToolsStatus } from "./generated/ExternalToolsStatus";

export type { ExternalToolStatus, ExternalToolsStatus };

export type LibrarySummaryInfo = {
    total_bytes: number;
    formatted_size: string;
    video_files: number;
    audio_files: number;
    thumbnail_files: number;
};

export type LiveChatStorageInfo = {
    live_chat_files: number;
};

// Generated from the Rust structs by ts-rs. Change the Rust struct and regenerate.
// Imported (not just re-exported) so other types in this file can reference them.
import type { MediaRepositoryStats } from "./generated/MediaRepositoryStats";
import type { MediaIntegrityReference } from "./generated/MediaIntegrityReference";

export type { MediaRepositoryStats, MediaIntegrityReference };

export type LibraryIntegrityReport = {
    checked_media_files: number;
    missing_media_files: number;
    missing_media_examples: string[];
    checked_thumbnail_files: number;
    missing_thumbnail_files: number;
    missing_thumbnail_examples: string[];
    orphan_media_files: number;
    orphan_media_examples: string[];
    orphan_thumbnail_files: number;
    orphan_thumbnail_examples: string[];
};

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