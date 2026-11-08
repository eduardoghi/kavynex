//! Replacing a channel's avatar or banner, and cleaning up the image it replaced.

use super::*;

/// One of the two images a channel stores under `thumbnails/`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChannelImage {
    /// The round picture beside the channel's name.
    Avatar,
    /// The wide image behind the avatar on the channel's page.
    Banner,
}

impl ChannelImage {
    fn select_sql(self) -> &'static str {
        match self {
            Self::Avatar => "SELECT avatar_path FROM channels WHERE id = ?",
            Self::Banner => "SELECT banner_path FROM channels WHERE id = ?",
        }
    }

    fn update_sql(self) -> &'static str {
        match self {
            Self::Avatar => "UPDATE channels SET avatar_path = ? WHERE id = ?",
            Self::Banner => "UPDATE channels SET banner_path = ? WHERE id = ?",
        }
    }
}

/// Updates one of a channel's images and decides, within the same transaction, whether the
/// previous file became unreferenced. Returns `None` when the channel does not exist.
///
/// A thumbnail is referenced by video rows and by channel avatars and banners, and all of them are
/// content-addressed (they can share a path), so the previous file is only planned for deletion
/// when nothing else (no video thumbnail and no other channel image) still points at it. Doing this
/// in one transaction (row write plus reference decision) closes the check-then-act race the
/// frontend had when it updated the avatar and then counted references over separate IPC calls.
pub async fn replace_channel_image_and_plan_cleanup(
    pool: &SqlitePool,
    channel_id: i64,
    image: ChannelImage,
    path: Option<String>,
) -> AppResult<Option<ArtifactCleanupPlan>> {
    let next = normalized(path);

    let mut tx = pool
        .begin_with(BEGIN_IMMEDIATE)
        .await
        .map_err(|error| db_error("failed to start channel image update transaction", error))?;

    let existing: Option<(Option<String>,)> = sqlx::query_as(image.select_sql())
        .bind(channel_id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(|error| db_error("failed to load channel for image update", error))?;

    let Some((previous,)) = existing else {
        return Ok(None);
    };

    let previous = normalized(previous);

    if previous == next {
        return Ok(Some(ArtifactCleanupPlan::default()));
    }

    sqlx::query(image.update_sql())
        .bind(next.as_deref())
        .bind(channel_id)
        .execute(&mut *tx)
        .await
        .map_err(|error| db_error("failed to update channel image path", error))?;

    let mut plan = ArtifactCleanupPlan::default();

    if let Some(previous) = previous {
        plan_artifact(&mut tx, ArtifactKind::Thumbnail, previous, &mut plan).await?;
    }

    tx.commit()
        .await
        .map_err(|error| db_error("failed to commit channel image update", error))?;

    Ok(Some(plan))
}

/// Updates one of a channel's images and removes the previous file when it is no longer
/// referenced. The row write and the "is the old file still used" decision commit atomically. The
/// unlink runs after the commit and is reported back.
pub async fn replace_channel_image<R: Runtime>(
    app: &AppHandle<R>,
    channel_id: i64,
    image: ChannelImage,
    path: Option<String>,
) -> AppResult<ArtifactCleanupReport> {
    let pool = shared_pool(app).await?;

    // A replaced image is removed at once. It was fetched from the channel or picked from the
    // user's files, so it can be had again, and the trash is for what a deletion the user made
    // could take back.
    match replace_channel_image_and_plan_cleanup(&pool, channel_id, image, path).await? {
        Some(plan) => execute_plan(app, plan, Disposal::Delete).await,
        None => Ok(ArtifactCleanupReport::default()),
    }
}
