use serde::{Deserialize, Serialize};

#[derive(Deserialize, Clone, Copy, Debug)]
#[serde(rename_all = "lowercase")]
pub enum ImportMode {
    Copy,
    Move,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct DownloadedMediaResult {
    pub file_path: String,
    pub suggested_title: String,
    pub youtube_video_id: Option<String>,
    pub published_at: Option<String>,
    pub media_type: String,
    pub thumbnail_url: Option<String>,
    pub thumbnail_path: Option<String>,
    pub is_live: bool,
    pub live_chat_file_path: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "lowercase")]
pub enum DownloadLogLevel {
    Info,
    Warn,
    Error,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct DownloadLogEvent {
    pub run_id: String,
    pub line: String,
    pub stream: String,
    pub level: DownloadLogLevel,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct DownloadFinishedEvent {
    pub run_id: String,
    pub file_path: String,
    pub suggested_title: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct DownloadFailedEvent {
    pub run_id: String,
    pub message: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "lowercase")]
pub enum DownloadTerminalStatus {
    Finished,
    Failed,
    Cancelled,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct DownloadTerminalEvent {
    pub run_id: String,
    pub status: DownloadTerminalStatus,
    pub message: Option<String>,
    pub file_path: Option<String>,
    pub suggested_title: Option<String>,
}

#[derive(Deserialize, Default)]
pub struct YtDlpMetadata {
    pub id: Option<String>,
    pub title: Option<String>,
    pub extractor: Option<String>,
    pub upload_date: Option<String>,
    pub thumbnail: Option<String>,
    pub live_status: Option<String>,
    pub was_live: Option<bool>,
    #[serde(default)]
    pub formats: Vec<YtDlpFormatMetadata>,
    #[serde(default)]
    pub comments: Vec<YtDlpCommentMetadata>,
}

#[derive(Deserialize, Default, Clone)]
pub struct YtDlpFormatMetadata {
    pub format_id: Option<String>,
    pub ext: Option<String>,
    pub format: Option<String>,
    pub format_note: Option<String>,
    pub resolution: Option<String>,
    pub filesize: Option<u64>,
    pub filesize_approx: Option<u64>,
    pub vcodec: Option<String>,
    pub acodec: Option<String>,
    pub height: Option<u64>,
    pub fps: Option<f64>,
    pub abr: Option<f64>,
    pub tbr: Option<f64>,
    pub protocol: Option<String>,
}

#[derive(Deserialize, Default, Clone, Debug)]
pub struct YtDlpCommentMetadata {
    pub id: Option<String>,
    pub parent: Option<String>,
    pub author: Option<String>,
    pub author_id: Option<String>,
    pub author_thumbnail: Option<String>,
    pub author_is_uploader: Option<bool>,
    pub author_url: Option<String>,
    pub is_favorited: Option<bool>,
    pub is_pinned: Option<bool>,
    pub text: Option<String>,
    pub like_count: Option<u64>,
    pub reply_count: Option<u64>,
    pub time_text: Option<String>,
    pub timestamp: Option<i64>,
    pub is_edited: Option<bool>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct YtDlpFormatOption {
    pub format_id: String,
    pub display_name: String,
    pub ext: String,
    pub media_type: String,
    pub has_video: bool,
    pub has_audio: bool,
    pub filesize_bytes: Option<u64>,
    pub height: Option<u64>,
    pub abr: Option<f64>,
    pub tbr: Option<f64>,
    pub vcodec: Option<String>,
    pub protocol: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct YtDlpFormatsResult {
    pub suggested_title: String,
    pub formats: Vec<YtDlpFormatOption>,
    pub terminal_logs: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct YtDlpComment {
    pub comment_id: Option<String>,
    pub parent_comment_id: Option<String>,
    pub author_name: String,
    pub author_handle: Option<String>,
    pub author_channel_id: Option<String>,
    pub author_thumbnail: Option<String>,
    pub text: String,
    pub like_count: u64,
    pub reply_count: u64,
    pub is_author_uploader: bool,
    pub is_favorited: bool,
    pub is_pinned: bool,
    pub is_edited: bool,
    pub time_text: Option<String>,
    pub published_at: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ExternalToolHealth {
    pub path: String,
    pub version: String,
    pub healthy: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ExternalToolsStatus {
    pub yt_dlp: ExternalToolHealth,
    pub ffmpeg: ExternalToolHealth,
}