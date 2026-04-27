export type ExternalToolStatus = {
    path: string;
    version: string;
    healthy: boolean;
};

export type ExternalToolsStatus = {
    yt_dlp: ExternalToolStatus;
    ffmpeg: ExternalToolStatus;
};

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

export type MediaRepositoryStats = {
    total_media: number;
    total_video_media: number;
    total_audio_media: number;
    total_with_thumbnail: number;
    total_without_thumbnail: number;
    total_watched: number;
    total_unwatched: number;
    total_live_media: number;
    total_with_live_chat: number;
    total_without_live_chat: number;
    total_media_with_live_chat_flag_but_no_path: number;
    total_media_with_live_chat_path_but_not_live: number;
};

export type MediaIntegrityReference = {
    id: number;
    title: string;
    file_path: string;
    thumbnail_path: string | null;
    live_chat_file_path: string | null;
};

export type LibraryIntegrityReport = {
    checked_media_files: number;
    missing_media_files: number;
    missing_media_examples: string[];
    checked_thumbnail_files: number;
    missing_thumbnail_files: number;
    missing_thumbnail_examples: string[];
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