use serde::{Deserialize, Serialize};
use std::fmt;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AppErrorCode {
    AppError,
    InvalidInput,

    BlockingTaskJoinFailed,

    AssetScopeRegisterFailed,

    DataDirectoryResolveFailed,
    CacheDirectoryResolveFailed,
    CacheDirectoryCreateFailed,
    VideoDirectoryResolveFailed,

    InvalidLibraryPath,
    CreateLibraryDirFailed,
    CreateDefaultLibraryDirFailed,
    CreateNewLibraryDirFailed,
    CanonicalizeLibraryPathFailed,
    CanonicalizeDirectoryFailed,
    InvalidLibraryMigration,
    LibraryMigrationAlreadyRunning,

    InvalidDirectoryPath,
    CreateDirectoryFailed,
    ReadDirFailed,
    ReadDirEntryFailed,

    SourceFileNotFound,
    InvalidSourceFile,
    FileOpenFailed,
    FileReadFailed,
    FileCopyFailed,
    FileRenameFailed,
    FileMoveFailed,
    SourceFileRemoveFailed,
    LiveChatCompressFailed,

    InvalidDestinationPath,
    CreateDestinationParentFailed,
    InvalidDestinationFile,
    DestinationAlreadyExists,
    DestinationBackupFailed,
    DestinationRestoreFailed,

    SourceMetadataFailed,
    DestinationMetadataFailed,

    InvalidSourceDirectory,
    MatchingFileNotFound,
    MultipleMatchingFilesFound,

    InvalidRelativePath,
    PathNotFound,
    PathOutsideBaseDir,
    CreateBaseDirFailed,
    InvalidTargetPath,
    CreateTargetParentFailed,
    CanonicalizeBaseDirFailed,
    CanonicalizeTargetPathFailed,
    CanonicalizeTargetParentFailed,
    RelativePathResolveFailed,

    SourceMediaNotFound,
    InvalidSourceMedia,
    InvalidMediaPath,
    CreateMediaDirFailed,
    RemoveMediaFailed,
    UnsupportedMediaExtension,

    SourceThumbnailNotFound,
    InvalidSourceThumbnail,
    InvalidThumbnailFile,
    ThumbnailNotSupportedForAudio,
    CreateThumbnailsDirFailed,
    InvalidThumbnailPath,
    RemoveThumbnailFailed,

    InvalidTempDirectory,
    TempDirectoryReadFailed,
    TempDirectoryEntryReadFailed,
    CreateTempThumbsDirFailed,
    CreateTempThumbRootFailed,
    CreateTempThumbDirFailed,
    CreateTempRootDirFailed,
    CreateTempDirFailed,
    InvalidTempThumbnailPath,
    RemoveTempThumbnailFailed,

    FfmpegNotFound,
    FfmpegExecFailed,
    FfmpegFailed,

    YtDlpNotFound,
    InvalidUrl,
    InvalidRunId,
    InvalidFormatId,
    InvalidYoutubeVideoId,
    YtDlpRunAlreadyActive,
    YtDlpInvalidMetadata,
    YtDlpEventEmitFailed,
    YtDlpMetadataTimeout,
    YtDlpMetadataExecFailed,
    YtDlpMetadataFailed,
    YtDlpMetadataParseFailed,
    YtDlpCommentsTimeout,
    YtDlpCommentsExecFailed,
    YtDlpCommentsFailed,
    YtDlpCommentsParseFailed,
    YtDlpThumbnailTimeout,
    YtDlpThumbnailExecFailed,
    YtDlpThumbnailFailed,
    YtDlpThumbnailNotFound,
    YtDlpSelectedFormatNotFound,
    YtDlpDownloadSpawnFailed,
    YtDlpStdoutCaptureFailed,
    YtDlpStderrCaptureFailed,
    YtDlpWaitFailed,
    YtDlpDownloadTimeout,
    YtDlpDownloadFailed,
    YtDlpDownloadCancelled,
    YtDlpDownloadedFileNotFound,
    InvalidDownloadedFile,
}

impl AppErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::AppError => "APP_ERROR",
            Self::InvalidInput => "INVALID_INPUT",

            Self::BlockingTaskJoinFailed => "BLOCKING_TASK_JOIN_FAILED",

            Self::AssetScopeRegisterFailed => "ASSET_SCOPE_REGISTER_FAILED",

            Self::DataDirectoryResolveFailed => "DATA_DIRECTORY_RESOLVE_FAILED",
            Self::CacheDirectoryResolveFailed => "CACHE_DIRECTORY_RESOLVE_FAILED",
            Self::CacheDirectoryCreateFailed => "CACHE_DIRECTORY_CREATE_FAILED",
            Self::VideoDirectoryResolveFailed => "VIDEO_DIRECTORY_RESOLVE_FAILED",

            Self::InvalidLibraryPath => "INVALID_LIBRARY_PATH",
            Self::CreateLibraryDirFailed => "CREATE_LIBRARY_DIR_FAILED",
            Self::CreateDefaultLibraryDirFailed => "CREATE_DEFAULT_LIBRARY_DIR_FAILED",
            Self::CreateNewLibraryDirFailed => "CREATE_NEW_LIBRARY_DIR_FAILED",
            Self::CanonicalizeLibraryPathFailed => "CANONICALIZE_LIBRARY_PATH_FAILED",
            Self::CanonicalizeDirectoryFailed => "CANONICALIZE_DIRECTORY_FAILED",
            Self::InvalidLibraryMigration => "INVALID_LIBRARY_MIGRATION",
            Self::LibraryMigrationAlreadyRunning => "LIBRARY_MIGRATION_ALREADY_RUNNING",

            Self::InvalidDirectoryPath => "INVALID_DIRECTORY_PATH",
            Self::CreateDirectoryFailed => "CREATE_DIRECTORY_FAILED",
            Self::ReadDirFailed => "READ_DIR_FAILED",
            Self::ReadDirEntryFailed => "READ_DIR_ENTRY_FAILED",

            Self::SourceFileNotFound => "SOURCE_FILE_NOT_FOUND",
            Self::InvalidSourceFile => "INVALID_SOURCE_FILE",
            Self::FileOpenFailed => "FILE_OPEN_FAILED",
            Self::FileReadFailed => "FILE_READ_FAILED",
            Self::FileCopyFailed => "FILE_COPY_FAILED",
            Self::FileRenameFailed => "FILE_RENAME_FAILED",
            Self::FileMoveFailed => "FILE_MOVE_FAILED",
            Self::SourceFileRemoveFailed => "SOURCE_FILE_REMOVE_FAILED",
            Self::LiveChatCompressFailed => "LIVE_CHAT_COMPRESS_FAILED",

            Self::InvalidDestinationPath => "INVALID_DESTINATION_PATH",
            Self::CreateDestinationParentFailed => "CREATE_DESTINATION_PARENT_FAILED",
            Self::InvalidDestinationFile => "INVALID_DESTINATION_FILE",
            Self::DestinationAlreadyExists => "DESTINATION_ALREADY_EXISTS",
            Self::DestinationBackupFailed => "DESTINATION_BACKUP_FAILED",
            Self::DestinationRestoreFailed => "DESTINATION_RESTORE_FAILED",

            Self::SourceMetadataFailed => "SOURCE_METADATA_FAILED",
            Self::DestinationMetadataFailed => "DESTINATION_METADATA_FAILED",

            Self::InvalidSourceDirectory => "INVALID_SOURCE_DIRECTORY",
            Self::MatchingFileNotFound => "MATCHING_FILE_NOT_FOUND",
            Self::MultipleMatchingFilesFound => "MULTIPLE_MATCHING_FILES_FOUND",

            Self::InvalidRelativePath => "INVALID_RELATIVE_PATH",
            Self::PathNotFound => "PATH_NOT_FOUND",
            Self::PathOutsideBaseDir => "PATH_OUTSIDE_BASE_DIR",
            Self::CreateBaseDirFailed => "CREATE_BASE_DIR_FAILED",
            Self::InvalidTargetPath => "INVALID_TARGET_PATH",
            Self::CreateTargetParentFailed => "CREATE_TARGET_PARENT_FAILED",
            Self::CanonicalizeBaseDirFailed => "CANONICALIZE_BASE_DIR_FAILED",
            Self::CanonicalizeTargetPathFailed => "CANONICALIZE_TARGET_PATH_FAILED",
            Self::CanonicalizeTargetParentFailed => "CANONICALIZE_TARGET_PARENT_FAILED",
            Self::RelativePathResolveFailed => "RELATIVE_PATH_RESOLVE_FAILED",

            Self::SourceMediaNotFound => "SOURCE_MEDIA_NOT_FOUND",
            Self::InvalidSourceMedia => "INVALID_SOURCE_MEDIA",
            Self::InvalidMediaPath => "INVALID_MEDIA_PATH",
            Self::CreateMediaDirFailed => "CREATE_MEDIA_DIR_FAILED",
            Self::RemoveMediaFailed => "REMOVE_MEDIA_FAILED",
            Self::UnsupportedMediaExtension => "UNSUPPORTED_MEDIA_EXTENSION",

            Self::SourceThumbnailNotFound => "SOURCE_THUMBNAIL_NOT_FOUND",
            Self::InvalidSourceThumbnail => "INVALID_SOURCE_THUMBNAIL",
            Self::InvalidThumbnailFile => "INVALID_THUMBNAIL_FILE",
            Self::ThumbnailNotSupportedForAudio => "THUMBNAIL_NOT_SUPPORTED_FOR_AUDIO",
            Self::CreateThumbnailsDirFailed => "CREATE_THUMBNAILS_DIR_FAILED",
            Self::InvalidThumbnailPath => "INVALID_THUMBNAIL_PATH",
            Self::RemoveThumbnailFailed => "REMOVE_THUMBNAIL_FAILED",

            Self::InvalidTempDirectory => "INVALID_TEMP_DIRECTORY",
            Self::TempDirectoryReadFailed => "TEMP_DIRECTORY_READ_FAILED",
            Self::TempDirectoryEntryReadFailed => "TEMP_DIRECTORY_ENTRY_READ_FAILED",
            Self::CreateTempThumbsDirFailed => "CREATE_TEMP_THUMBS_DIR_FAILED",
            Self::CreateTempThumbRootFailed => "CREATE_TEMP_THUMB_ROOT_FAILED",
            Self::CreateTempThumbDirFailed => "CREATE_TEMP_THUMB_DIR_FAILED",
            Self::CreateTempRootDirFailed => "CREATE_TEMP_ROOT_DIR_FAILED",
            Self::CreateTempDirFailed => "CREATE_TEMP_DIR_FAILED",
            Self::InvalidTempThumbnailPath => "INVALID_TEMP_THUMBNAIL_PATH",
            Self::RemoveTempThumbnailFailed => "REMOVE_TEMP_THUMBNAIL_FAILED",

            Self::FfmpegNotFound => "FFMPEG_NOT_FOUND",
            Self::FfmpegExecFailed => "FFMPEG_EXEC_FAILED",
            Self::FfmpegFailed => "FFMPEG_FAILED",

            Self::YtDlpNotFound => "YT_DLP_NOT_FOUND",
            Self::InvalidUrl => "INVALID_URL",
            Self::InvalidRunId => "INVALID_RUN_ID",
            Self::InvalidFormatId => "INVALID_FORMAT_ID",
            Self::InvalidYoutubeVideoId => "INVALID_YOUTUBE_VIDEO_ID",
            Self::YtDlpRunAlreadyActive => "YT_DLP_RUN_ALREADY_ACTIVE",
            Self::YtDlpInvalidMetadata => "YT_DLP_INVALID_METADATA",
            Self::YtDlpEventEmitFailed => "YT_DLP_EVENT_EMIT_FAILED",
            Self::YtDlpMetadataTimeout => "YT_DLP_METADATA_TIMEOUT",
            Self::YtDlpMetadataExecFailed => "YT_DLP_METADATA_EXEC_FAILED",
            Self::YtDlpMetadataFailed => "YT_DLP_METADATA_FAILED",
            Self::YtDlpMetadataParseFailed => "YT_DLP_METADATA_PARSE_FAILED",
            Self::YtDlpCommentsTimeout => "YT_DLP_COMMENTS_TIMEOUT",
            Self::YtDlpCommentsExecFailed => "YT_DLP_COMMENTS_EXEC_FAILED",
            Self::YtDlpCommentsFailed => "YT_DLP_COMMENTS_FAILED",
            Self::YtDlpCommentsParseFailed => "YT_DLP_COMMENTS_PARSE_FAILED",
            Self::YtDlpThumbnailTimeout => "YT_DLP_THUMBNAIL_TIMEOUT",
            Self::YtDlpThumbnailExecFailed => "YT_DLP_THUMBNAIL_EXEC_FAILED",
            Self::YtDlpThumbnailFailed => "YT_DLP_THUMBNAIL_FAILED",
            Self::YtDlpThumbnailNotFound => "YT_DLP_THUMBNAIL_NOT_FOUND",
            Self::YtDlpSelectedFormatNotFound => "YT_DLP_SELECTED_FORMAT_NOT_FOUND",
            Self::YtDlpDownloadSpawnFailed => "YT_DLP_DOWNLOAD_SPAWN_FAILED",
            Self::YtDlpStdoutCaptureFailed => "YT_DLP_STDOUT_CAPTURE_FAILED",
            Self::YtDlpStderrCaptureFailed => "YT_DLP_STDERR_CAPTURE_FAILED",
            Self::YtDlpWaitFailed => "YT_DLP_WAIT_FAILED",
            Self::YtDlpDownloadTimeout => "YT_DLP_DOWNLOAD_TIMEOUT",
            Self::YtDlpDownloadFailed => "YT_DLP_DOWNLOAD_FAILED",
            Self::YtDlpDownloadCancelled => "YT_DLP_DOWNLOAD_CANCELLED",
            Self::YtDlpDownloadedFileNotFound => "YT_DLP_DOWNLOADED_FILE_NOT_FOUND",
            Self::InvalidDownloadedFile => "INVALID_DOWNLOADED_FILE",
        }
    }
}

impl fmt::Display for AppErrorCode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.as_str())
    }
}

impl From<AppErrorCode> for String {
    fn from(value: AppErrorCode) -> Self {
        value.as_str().to_string()
    }
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
pub struct AppError {
    pub code: String,
    pub message: String,
    pub details: Option<String>,
}

impl AppError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            details: None,
        }
    }

    pub fn with_details(
        code: impl Into<String>,
        message: impl Into<String>,
        details: impl Into<String>,
    ) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            details: Some(details.into()),
        }
    }

    pub fn from_code(code: AppErrorCode, message: impl Into<String>) -> Self {
        Self::new(code, message)
    }

    pub fn from_code_with_details(
        code: AppErrorCode,
        message: impl Into<String>,
        details: impl Into<String>,
    ) -> Self {
        Self::with_details(code, message, details)
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::from_code(AppErrorCode::AppError, message)
    }

    pub fn invalid_input(message: impl Into<String>) -> Self {
        Self::from_code(AppErrorCode::InvalidInput, message)
    }
}

impl fmt::Display for AppError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match &self.details {
            Some(details) if !details.trim().is_empty() => {
                write!(f, "{}: {} ({})", self.code, self.message, details)
            }
            _ => write!(f, "{}: {}", self.code, self.message),
        }
    }
}

impl std::error::Error for AppError {}

impl From<String> for AppError {
    fn from(value: String) -> Self {
        Self::internal(value)
    }
}

impl From<&str> for AppError {
    fn from(value: &str) -> Self {
        Self::internal(value)
    }
}

impl From<std::io::Error> for AppError {
    fn from(value: std::io::Error) -> Self {
        Self::from_code_with_details(
            AppErrorCode::AppError,
            "i/o operation failed",
            value.to_string(),
        )
    }
}

pub type AppResult<T> = Result<T, AppError>;
