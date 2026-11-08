//! Deleting a media's or a channel's rows and deciding, in the same transaction, which of their
//! files nothing else references any more.

use super::*;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ArtifactKind {
    MediaFile,
    Thumbnail,
    LiveChat,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeletableArtifact {
    pub kind: ArtifactKind,
    pub path: String,
}

/// What the committed transaction decided. Which files became unreferenced (safe to
/// remove from disk) and which are still shared with surviving rows.
#[derive(Debug, Default, Clone)]
pub struct ArtifactCleanupPlan {
    pub deletable: Vec<DeletableArtifact>,
    pub skipped_shared_paths: Vec<String>,
}

#[derive(Debug, Default, Clone, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub struct ArtifactCleanupReport {
    pub deleted_paths: Vec<String>,
    pub skipped_shared_paths: Vec<String>,
    pub failed_paths: Vec<String>,
}

pub(super) fn normalized(value: Option<String>) -> Option<String> {
    value
        .map(|item| item.trim().to_string())
        .filter(|item| !item.is_empty())
}

/// Both spellings of a library-relative path. The app writes `/`, but a row from an older database
/// or an imported one can hold `video\media_x.mp4` for the same file, and a count that saw only one
/// spelling would read the other row's file as unreferenced and remove it. An `IN` over the indexed
/// column, so the lookup stays an index search.
pub(super) fn path_spellings(path: &str) -> (String, String) {
    let forward = path.replace('\\', "/");
    let backward = forward.replace('/', "\\");

    (forward, backward)
}

pub(super) async fn count_media_files_referencing(
    conn: &mut SqliteConnection,
    path: &str,
) -> AppResult<i64> {
    let (forward, backward) = path_spellings(path);
    let (total,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM videos WHERE file_path IN (?, ?)")
        .bind(forward)
        .bind(backward)
        .fetch_one(conn)
        .await
        .map_err(|error| db_error("failed to count media file references", error))?;

    Ok(total)
}

/// How many media rows store `path` as their file, in either separator spelling. For the startup
/// sweep, which puts a Move import's file back only when no row took it after all.
pub(crate) async fn count_media_rows_using_file(pool: &SqlitePool, path: &str) -> AppResult<i64> {
    let mut conn = pool
        .acquire()
        .await
        .map_err(|error| db_error("failed to acquire a database connection", error))?;

    count_media_files_referencing(&mut conn, path).await
}

/// A thumbnail is referenced by video rows and by channel avatars and banners, so a single count
/// covers every surviving use regardless of which side the deletion came from.
pub(super) async fn count_thumbnails_referencing(
    conn: &mut SqliteConnection,
    path: &str,
) -> AppResult<i64> {
    let (forward, backward) = path_spellings(path);
    let (total,): (i64,) = sqlx::query_as(
        "SELECT (SELECT COUNT(*) FROM videos WHERE thumbnail_path IN (?, ?))
              + (SELECT COUNT(*) FROM channels WHERE avatar_path IN (?, ?))
              + (SELECT COUNT(*) FROM channels WHERE banner_path IN (?, ?))",
    )
    .bind(&forward)
    .bind(&backward)
    .bind(&forward)
    .bind(&backward)
    .bind(&forward)
    .bind(&backward)
    .fetch_one(conn)
    .await
    .map_err(|error| db_error("failed to count thumbnail references", error))?;

    Ok(total)
}

pub(super) async fn count_live_chats_referencing(
    conn: &mut SqliteConnection,
    path: &str,
) -> AppResult<i64> {
    let (forward, backward) = path_spellings(path);
    let (total,): (i64,) =
        sqlx::query_as("SELECT COUNT(*) FROM videos WHERE live_chat_file_path IN (?, ?)")
            .bind(forward)
            .bind(backward)
            .fetch_one(conn)
            .await
            .map_err(|error| db_error("failed to count live chat references", error))?;

    Ok(total)
}

pub(super) async fn plan_artifact(
    conn: &mut SqliteConnection,
    kind: ArtifactKind,
    path: String,
    plan: &mut ArtifactCleanupPlan,
) -> AppResult<()> {
    let remaining = match kind {
        ArtifactKind::MediaFile => count_media_files_referencing(conn, &path).await?,
        ArtifactKind::Thumbnail => count_thumbnails_referencing(conn, &path).await?,
        ArtifactKind::LiveChat => count_live_chats_referencing(conn, &path).await?,
    };

    if remaining == 0 {
        plan.deletable.push(DeletableArtifact { kind, path });
    } else {
        plan.skipped_shared_paths.push(path);
    }

    Ok(())
}

/// Refuses a deletion that would leave its files behind because the library cannot be reached.
///
/// Checked inside the deletion transaction, once the plan says which files are about to become
/// unreferenced, so a refusal rolls the rows back. Committed anyway, a media deleted with the
/// library drive unplugged would lose its row while its files stayed on that drive as orphans
/// nothing pointed at any more. A plan with nothing to remove (every file still shared) needs no
/// library and goes through.
pub(super) fn ensure_library_reachable_for(
    plan: &ArtifactCleanupPlan,
    library_reachable: bool,
) -> AppResult<()> {
    if library_reachable || plan.deletable.is_empty() {
        return Ok(());
    }

    Err(AppError::from_code(
        AppErrorCode::InvalidLibraryPath,
        "the library folder is not available, so the files of what is being deleted could not be removed",
    ))
}

/// Deletes the media row and decides, within the same transaction, which of its artifact
/// files became unreferenced. Returns `None` when the media does not exist (the operation
/// is idempotent. Nothing is deleted and no error is raised).
///
/// `library_reachable` says whether the library folder exists right now. When it does not and the
/// deletion would free files, nothing is deleted (see [`ensure_library_reachable_for`]).
pub async fn delete_media_row_and_plan_cleanup(
    pool: &SqlitePool,
    media_id: i64,
    library_reachable: bool,
) -> AppResult<Option<ArtifactCleanupPlan>> {
    let mut tx = pool
        .begin_with(BEGIN_IMMEDIATE)
        .await
        .map_err(|error| db_error("failed to start media deletion transaction", error))?;

    let row: Option<(String, Option<String>, Option<String>)> = sqlx::query_as(
        "SELECT file_path, thumbnail_path, live_chat_file_path FROM videos WHERE id = ?",
    )
    .bind(media_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(|error| db_error("failed to load media for deletion", error))?;

    let Some((file_path, thumbnail_path, live_chat_file_path)) = row else {
        return Ok(None);
    };

    sqlx::query("DELETE FROM videos WHERE id = ?")
        .bind(media_id)
        .execute(&mut *tx)
        .await
        .map_err(|error| db_error("failed to delete media", error))?;

    let mut plan = ArtifactCleanupPlan::default();

    if let Some(path) = normalized(Some(file_path)) {
        plan_artifact(&mut tx, ArtifactKind::MediaFile, path, &mut plan).await?;
    }

    if let Some(path) = normalized(thumbnail_path) {
        plan_artifact(&mut tx, ArtifactKind::Thumbnail, path, &mut plan).await?;
    }

    if let Some(path) = normalized(live_chat_file_path) {
        plan_artifact(&mut tx, ArtifactKind::LiveChat, path, &mut plan).await?;
    }

    // Before the commit, so a refusal drops the transaction and the row stays.
    ensure_library_reachable_for(&plan, library_reachable)?;

    tx.commit()
        .await
        .map_err(|error| db_error("failed to commit media deletion", error))?;

    Ok(Some(plan))
}

/// Deletes the channel row (its videos and comments go with it via `ON DELETE CASCADE`)
/// and decides, within the same transaction, which artifact files became unreferenced.
/// Returns `None` when the channel does not exist.
///
/// `library_reachable` works as in [`delete_media_row_and_plan_cleanup`].
pub async fn delete_channel_row_and_plan_cleanup(
    pool: &SqlitePool,
    channel_id: i64,
    library_reachable: bool,
) -> AppResult<Option<ArtifactCleanupPlan>> {
    let mut tx = pool
        .begin_with(BEGIN_IMMEDIATE)
        .await
        .map_err(|error| db_error("failed to start channel deletion transaction", error))?;

    let channel: Option<(Option<String>, Option<String>)> =
        sqlx::query_as("SELECT avatar_path, banner_path FROM channels WHERE id = ?")
            .bind(channel_id)
            .fetch_optional(&mut *tx)
            .await
            .map_err(|error| db_error("failed to load channel for deletion", error))?;

    let Some((avatar_path, banner_path)) = channel else {
        return Ok(None);
    };

    let file_paths: Vec<(String,)> = sqlx::query_as(
        "SELECT DISTINCT file_path FROM videos WHERE channel_id = ? AND TRIM(file_path) <> ''",
    )
    .bind(channel_id)
    .fetch_all(&mut *tx)
    .await
    .map_err(|error| db_error("failed to list channel media files for deletion", error))?;

    let thumbnail_paths: Vec<(String,)> = sqlx::query_as(
        "SELECT DISTINCT thumbnail_path FROM videos
         WHERE channel_id = ? AND thumbnail_path IS NOT NULL AND TRIM(thumbnail_path) <> ''",
    )
    .bind(channel_id)
    .fetch_all(&mut *tx)
    .await
    .map_err(|error| db_error("failed to list channel thumbnails for deletion", error))?;

    let live_chat_paths: Vec<(String,)> = sqlx::query_as(
        "SELECT DISTINCT live_chat_file_path FROM videos
         WHERE channel_id = ? AND live_chat_file_path IS NOT NULL
           AND TRIM(live_chat_file_path) <> ''",
    )
    .bind(channel_id)
    .fetch_all(&mut *tx)
    .await
    .map_err(|error| db_error("failed to list channel live chat files for deletion", error))?;

    sqlx::query("DELETE FROM channels WHERE id = ?")
        .bind(channel_id)
        .execute(&mut *tx)
        .await
        .map_err(|error| db_error("failed to delete channel", error))?;

    let mut plan = ArtifactCleanupPlan::default();

    // BTreeSet dedupes (the avatar or banner can also be a media thumbnail) and keeps the plan
    // order deterministic for tests and logs.
    let media_files: BTreeSet<String> = file_paths
        .into_iter()
        .filter_map(|(value,)| normalized(Some(value)))
        .collect();

    let thumbnails: BTreeSet<String> = thumbnail_paths
        .into_iter()
        .map(|(value,)| value)
        .chain(avatar_path)
        .chain(banner_path)
        .filter_map(|value| normalized(Some(value)))
        .collect();

    let live_chats: BTreeSet<String> = live_chat_paths
        .into_iter()
        .filter_map(|(value,)| normalized(Some(value)))
        .collect();

    for path in media_files {
        plan_artifact(&mut tx, ArtifactKind::MediaFile, path, &mut plan).await?;
    }

    for path in thumbnails {
        plan_artifact(&mut tx, ArtifactKind::Thumbnail, path, &mut plan).await?;
    }

    for path in live_chats {
        plan_artifact(&mut tx, ArtifactKind::LiveChat, path, &mut plan).await?;
    }

    ensure_library_reachable_for(&plan, library_reachable)?;

    tx.commit()
        .await
        .map_err(|error| db_error("failed to commit channel deletion", error))?;

    Ok(Some(plan))
}
