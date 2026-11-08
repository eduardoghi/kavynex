//! Creating a media, end to end, as one backend operation.
//!
//! Adding a media is not one step. The artifacts have to be produced (a yt-dlp download or a local
//! import, plus a thumbnail and possibly a live chat replay), and only then can the row that points
//! at them be inserted. Between those two points the files sit in the library with nothing
//! referencing them, and that window is what everything here is shaped around.
//!
//! What deliberately stayed in the renderer is everything *after* the row lands. The comment backup,
//! the live-chat notice, the duration probe. None of them is inside the window (the media is
//! registered and safe by then), and the duration probe in particular reads the file through a
//! `<video>` element, which is a webview capability rather than something to reimplement over
//! FFmpeg. It also has to stay outside the window. The probe resolves on `loadedmetadata` or
//! `error` and carries no timeout, so a source that fires neither would hang a creation that still
//! had its marker on disk.
//!
//! The ordering inside [`create_media_async`] is load-bearing in two places, and both are the same
//! rule stated twice. Never record something that is not true yet. The marker is written *after* the
//! artifacts exist, because a marker naming files that were never created would hand the startup
//! sweep paths to reconcile that no run ever wrote. And the marker is cleared *after* the row lands
//! or the cleanup has run, because clearing it earlier would drop the record precisely while it is
//! the only thing describing the state on disk.

use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Runtime};

use crate::models::yt_dlp::{DownloadedMediaResult, ImportMode};
use crate::services::database::shared_pool;
use crate::services::library;
use crate::services::logger;
use crate::services::pending_media::{self, PendingMediaArtifacts};
use crate::services::thumbnail;
use crate::services::video_repository as repo;
use crate::services::yt_dlp;
use crate::utils::format::media_subdir_from_extension;
use crate::utils::path::ensure_managed_library_relative_path;
use crate::utils::path::extension_from_path;
use crate::utils::task::run_blocking;
use crate::utils::validation::ensure_valid_media_title;
use crate::{AppError, AppErrorCode, AppResult};

mod artifact_cleanup;
mod prepare;
mod register;
mod request;

pub(crate) use artifact_cleanup::*;
pub(crate) use prepare::*;
pub(crate) use register::*;
pub(crate) use request::*;

#[cfg(test)]
mod tests;
