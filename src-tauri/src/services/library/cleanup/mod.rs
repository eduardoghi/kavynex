//! Atomic deletion of media/channel rows together with their on-disk artifacts.
//!
//! Deleting a media or a channel involves a referential-integrity rule. An artifact file
//! (media file, thumbnail, live chat replay) may be shared by other rows (the same
//! thumbnail can back several videos or a channel avatar, and a live chat replay can back
//! the same video added to several channels), so a file can only be removed from disk
//! when nothing else references it. This module makes that decision inside the same
//! database transaction that deletes the rows, eliminating the check-then-act window that
//! existed when the frontend orchestrated the cleanup over several IPC calls.
//!
//! File removal itself happens after the transaction commits (the filesystem cannot join
//! a SQLite transaction). A failure there is reported and logged but never undoes the
//! committed row deletion, matching the previous best-effort semantics.

use std::collections::BTreeSet;
use std::path::Path;

use serde::Serialize;
use sqlx::{SqliteConnection, SqlitePool};
use tauri::{AppHandle, Runtime};

use crate::services::database::{db_error, get_app_settings_from_pool, shared_pool};
use crate::services::library::guard::configured_library_dir;
use crate::services::library::media::delete_media_file_sync;
use crate::services::logger;
use crate::services::temp_paths::thumb_display_dir_async;
use crate::services::thumbnail::display::display_derivative_path;
use crate::services::thumbnail::persist::delete_thumbnail_file_sync;

/// Opens the read-then-write transactions below with `BEGIN IMMEDIATE` rather than sqlx's
/// default deferred `BEGIN`.
///
/// Each of them reads first (which rows exist, what artifacts they point at) and writes second,
/// so a deferred transaction takes its read snapshot on the SELECT and only asks for the write
/// lock later. In WAL mode, if another connection commits in between, SQLite fails that upgrade
/// with `SQLITE_BUSY_SNAPSHOT` **immediately, without consulting the busy handler**. The
/// `busy_timeout` these connections carry cannot help, because no amount of waiting can make a
/// stale snapshot writable. The user would see a bare "failed to delete media" with no retry.
/// `BEGIN IMMEDIATE` takes the write lock up front, so the wait happens where `busy_timeout`
/// does apply and the snapshot is guaranteed writable once acquired.
const BEGIN_IMMEDIATE: &str = "BEGIN IMMEDIATE";
use crate::utils::path::{
    absolute_path_from_relative, ensure_existing_path_inside_dir, ManagedSubtree,
};
use crate::utils::task::run_blocking;
use crate::{AppError, AppErrorCode, AppResult};

mod channel_image;
mod execute;
mod orphans;
mod plan;
mod sweep;

pub(crate) use channel_image::*;
pub(crate) use execute::*;
pub(crate) use orphans::*;
pub(crate) use plan::*;
pub(crate) use sweep::*;

#[cfg(test)]
mod tests;
