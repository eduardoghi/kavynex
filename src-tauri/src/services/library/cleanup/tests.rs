// The tests for the parent module, kept in a file of their own so the module reads as its
// production code. Same module as before (`mod tests` declared under `#[cfg(test)]` in the
// parent), so `use super::*` still reaches every private item it did.

use super::*;
use crate::services::db_schema::ensure_schema;
use sqlx::sqlite::SqlitePoolOptions;
use std::fs;
use std::path::PathBuf;

async fn create_test_pool() -> SqlitePool {
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .expect("create sqlite memory pool");

    sqlx::query("PRAGMA foreign_keys = ON;")
        .execute(&pool)
        .await
        .expect("enable foreign keys");

    ensure_schema(&pool).await.expect("apply schema");

    pool
}

async fn insert_channel(pool: &SqlitePool, handle: &str, avatar: Option<&str>) -> i64 {
    let result =
        sqlx::query("INSERT INTO channels (name, youtube_handle, avatar_path) VALUES (?, ?, ?)")
            .bind(handle)
            .bind(handle)
            .bind(avatar)
            .execute(pool)
            .await
            .expect("insert channel");

    result.last_insert_rowid()
}

#[allow(clippy::too_many_arguments)]
async fn insert_media(
    pool: &SqlitePool,
    channel_id: i64,
    file_path: &str,
    thumbnail_path: Option<&str>,
    live_chat_file_path: Option<&str>,
) -> i64 {
    let result = sqlx::query(
        "INSERT INTO videos (channel_id, title, title_normalized, file_path, thumbnail_path, media_type, live_chat_file_path)
         VALUES (?, 'title', 'title', ?, ?, 'video', ?)",
    )
    .bind(channel_id)
    .bind(file_path)
    .bind(thumbnail_path)
    .bind(live_chat_file_path)
    .execute(pool)
    .await
    .expect("insert media");

    result.last_insert_rowid()
}

fn paths(artifacts: &[DeletableArtifact]) -> Vec<&str> {
    artifacts.iter().map(|item| item.path.as_str()).collect()
}

#[tokio::test]
async fn drop_paths_referenced_again_spares_a_path_referenced_after_the_commit() {
    // Simulate the race: a plan decided a file was unreferenced, then a concurrent import
    // inserted a row pointing at the same content-addressed path before the unlink ran.
    let pool = create_test_pool().await;
    let channel_id = insert_channel(&pool, "@race", None).await;
    insert_media(&pool, channel_id, "video/shared.mp4", None, None).await;

    let mut plan = ArtifactCleanupPlan {
        deletable: vec![DeletableArtifact {
            kind: ArtifactKind::MediaFile,
            path: "video/shared.mp4".to_string(),
        }],
        skipped_shared_paths: Vec::new(),
    };

    drop_paths_referenced_again(&pool, &mut plan).await;

    // The path is referenced again, so it must not be unlinked.
    assert!(plan.deletable.is_empty());
    assert_eq!(plan.skipped_shared_paths, vec!["video/shared.mp4"]);
}

#[tokio::test]
async fn drop_paths_referenced_again_keeps_a_genuinely_unreferenced_path() {
    let pool = create_test_pool().await;

    let mut plan = ArtifactCleanupPlan {
        deletable: vec![DeletableArtifact {
            kind: ArtifactKind::MediaFile,
            path: "video/gone.mp4".to_string(),
        }],
        skipped_shared_paths: Vec::new(),
    };

    drop_paths_referenced_again(&pool, &mut plan).await;

    // No row references it, so it stays scheduled for removal.
    assert_eq!(paths(&plan.deletable), vec!["video/gone.mp4"]);
    assert!(plan.skipped_shared_paths.is_empty());
}

#[tokio::test]
async fn execute_plan_waits_for_a_media_registration_holding_the_lock() {
    // The regression this pins: the three delete paths reached this function with no exclusion
    // against a creation at all, relying on `drop_paths_referenced_again` above and nothing
    // else. A recount is not exclusion. It answers "is this referenced *now*", and a creation
    // that inserts a moment later makes that answer stale between the recount and the unlink,
    // which is the window that strands a row on a file that has been removed.
    //
    // An empty plan is enough, and is the point: what is under test is that the lock is taken
    // *before* any work is delegated, not what the work then does. A plan with real artifacts
    // would need a library on disk and prove nothing extra about the ordering.
    use tauri::test::{mock_builder, mock_context, noop_assets};

    let app = mock_builder().build(mock_context(noop_assets())).unwrap();
    let guard = media_registration_guard().await;

    let handle = app.handle().clone();
    let mut cleanup =
        tokio::spawn(async move { execute_plan(&handle, ArtifactCleanupPlan::default()).await });

    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(200), &mut cleanup)
            .await
            .is_err(),
        "execute_plan must block while a media registration holds MEDIA_REGISTRATION_LOCK"
    );

    drop(guard);

    // Generously bounded rather than tight: the lock is a process-wide static, so another test
    // in this binary can take it between the release above and this await. The assertion is
    // that the cleanup proceeds at all, not how quickly.
    let report = tokio::time::timeout(std::time::Duration::from_secs(10), cleanup)
        .await
        .expect("execute_plan must proceed once the registration releases the lock")
        .expect("the cleanup task must not panic")
        .expect("an empty plan is not an error");

    assert!(report.deleted_paths.is_empty());
}

#[tokio::test]
async fn media_plan_deletes_unshared_artifacts() {
    let pool = create_test_pool().await;
    let channel_id = insert_channel(&pool, "@one", None).await;
    let media_id = insert_media(
        &pool,
        channel_id,
        "video/a.mp4",
        Some("thumbnails/a.jpg"),
        Some("live_chat/a.json.gz"),
    )
    .await;

    let plan = delete_media_row_and_plan_cleanup(&pool, media_id)
        .await
        .unwrap()
        .expect("media exists");

    assert_eq!(
        paths(&plan.deletable),
        vec!["video/a.mp4", "thumbnails/a.jpg", "live_chat/a.json.gz"]
    );
    assert!(plan.skipped_shared_paths.is_empty());

    let (remaining,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM videos")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(remaining, 0);
}

#[tokio::test]
async fn media_plan_skips_artifacts_shared_with_other_media() {
    let pool = create_test_pool().await;
    let channel_a = insert_channel(&pool, "@a", None).await;
    let channel_b = insert_channel(&pool, "@b", None).await;

    let media_id = insert_media(
        &pool,
        channel_a,
        "video/shared.mp4",
        Some("thumbnails/shared.jpg"),
        Some("live_chat/shared.json.gz"),
    )
    .await;
    // The same artifacts also back a media row in another channel.
    insert_media(
        &pool,
        channel_b,
        "video/shared.mp4",
        Some("thumbnails/shared.jpg"),
        Some("live_chat/shared.json.gz"),
    )
    .await;

    let plan = delete_media_row_and_plan_cleanup(&pool, media_id)
        .await
        .unwrap()
        .expect("media exists");

    assert!(plan.deletable.is_empty());
    assert_eq!(
        plan.skipped_shared_paths,
        vec![
            "video/shared.mp4",
            "thumbnails/shared.jpg",
            "live_chat/shared.json.gz"
        ]
    );
}

#[tokio::test]
async fn media_plan_skips_thumbnail_used_as_channel_avatar() {
    let pool = create_test_pool().await;
    let channel_id = insert_channel(&pool, "@one", Some("thumbnails/avatar.jpg")).await;
    let media_id = insert_media(
        &pool,
        channel_id,
        "video/a.mp4",
        Some("thumbnails/avatar.jpg"),
        None,
    )
    .await;

    let plan = delete_media_row_and_plan_cleanup(&pool, media_id)
        .await
        .unwrap()
        .expect("media exists");

    assert_eq!(paths(&plan.deletable), vec!["video/a.mp4"]);
    assert_eq!(plan.skipped_shared_paths, vec!["thumbnails/avatar.jpg"]);
}

#[tokio::test]
async fn media_plan_returns_none_for_missing_media() {
    let pool = create_test_pool().await;

    let plan = delete_media_row_and_plan_cleanup(&pool, 999).await.unwrap();

    assert!(plan.is_none());
}

#[tokio::test]
async fn channel_plan_cascades_rows_and_collects_unshared_artifacts() {
    let pool = create_test_pool().await;
    let channel_id = insert_channel(&pool, "@one", Some("thumbnails/avatar.jpg")).await;
    insert_media(
        &pool,
        channel_id,
        "video/a.mp4",
        Some("thumbnails/a.jpg"),
        Some("live_chat/a.json.gz"),
    )
    .await;
    insert_media(
        &pool,
        channel_id,
        "video/b.mp4",
        Some("thumbnails/a.jpg"),
        None,
    )
    .await;

    let plan = delete_channel_row_and_plan_cleanup(&pool, channel_id)
        .await
        .unwrap()
        .expect("channel exists");

    // Media files first, then thumbnails (avatar included, deduped), then live chat.
    assert_eq!(
        paths(&plan.deletable),
        vec![
            "video/a.mp4",
            "video/b.mp4",
            "thumbnails/a.jpg",
            "thumbnails/avatar.jpg",
            "live_chat/a.json.gz"
        ]
    );
    assert!(plan.skipped_shared_paths.is_empty());

    let (videos,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM videos")
        .fetch_one(&pool)
        .await
        .unwrap();
    let (channels,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM channels")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(videos, 0);
    assert_eq!(channels, 0);
}

#[tokio::test]
async fn channel_plan_skips_artifacts_shared_with_other_channels() {
    let pool = create_test_pool().await;
    let channel_a = insert_channel(&pool, "@a", Some("thumbnails/shared-avatar.jpg")).await;
    let channel_b = insert_channel(&pool, "@b", Some("thumbnails/shared-avatar.jpg")).await;

    insert_media(
        &pool,
        channel_a,
        "video/shared.mp4",
        Some("thumbnails/own.jpg"),
        Some("live_chat/shared.json.gz"),
    )
    .await;
    insert_media(
        &pool,
        channel_b,
        "video/shared.mp4",
        None,
        Some("live_chat/shared.json.gz"),
    )
    .await;

    let plan = delete_channel_row_and_plan_cleanup(&pool, channel_a)
        .await
        .unwrap()
        .expect("channel exists");

    assert_eq!(paths(&plan.deletable), vec!["thumbnails/own.jpg"]);
    assert_eq!(
        plan.skipped_shared_paths,
        vec![
            "video/shared.mp4",
            "thumbnails/shared-avatar.jpg",
            "live_chat/shared.json.gz"
        ]
    );
}

#[tokio::test]
async fn channel_plan_returns_none_for_missing_channel() {
    let pool = create_test_pool().await;

    let plan = delete_channel_row_and_plan_cleanup(&pool, 999)
        .await
        .unwrap();

    assert!(plan.is_none());
}

async fn plan_unreferenced(
    pool: &SqlitePool,
    file_path: Option<&str>,
    thumbnail_path: Option<&str>,
    live_chat_file_path: Option<&str>,
) -> ArtifactCleanupPlan {
    let mut conn = pool.acquire().await.unwrap();

    plan_unreferenced_artifacts(
        &mut conn,
        file_path.map(str::to_string),
        thumbnail_path.map(str::to_string),
        live_chat_file_path.map(str::to_string),
    )
    .await
    .unwrap()
}

#[tokio::test]
async fn cleanup_plan_deletes_orphan_artifacts_no_row_references() {
    let pool = create_test_pool().await;

    // No rows reference these freshly-prepared paths, so all become deletable.
    let plan = plan_unreferenced(
        &pool,
        Some("video/orphan.mp4"),
        Some("thumbnails/orphan.jpg"),
        Some("live_chat/orphan.json.gz"),
    )
    .await;

    assert_eq!(
        paths(&plan.deletable),
        vec![
            "video/orphan.mp4",
            "thumbnails/orphan.jpg",
            "live_chat/orphan.json.gz"
        ]
    );
    assert!(plan.skipped_shared_paths.is_empty());
}

#[tokio::test]
async fn cleanup_plan_keeps_artifacts_still_referenced_by_a_registered_row() {
    let pool = create_test_pool().await;
    let channel_id = insert_channel(&pool, "@one", Some("thumbnails/shared.jpg")).await;
    // A registered row references the media file and live chat; the thumbnail is a
    // channel avatar. Re-preparing the same content-addressed artifacts must not delete
    // the files the existing row/channel depends on.
    insert_media(
        &pool,
        channel_id,
        "video/shared.mp4",
        Some("thumbnails/shared.jpg"),
        Some("live_chat/shared.json.gz"),
    )
    .await;

    let plan = plan_unreferenced(
        &pool,
        Some("video/shared.mp4"),
        Some("thumbnails/shared.jpg"),
        Some("live_chat/shared.json.gz"),
    )
    .await;

    assert!(plan.deletable.is_empty());
    assert_eq!(
        plan.skipped_shared_paths,
        vec![
            "video/shared.mp4",
            "thumbnails/shared.jpg",
            "live_chat/shared.json.gz"
        ]
    );
}

#[tokio::test]
async fn replace_avatar_plan_deletes_previous_when_unreferenced() {
    let pool = create_test_pool().await;
    let channel_id = insert_channel(&pool, "@one", Some("thumbnails/old.jpg")).await;

    let plan = replace_channel_avatar_and_plan_cleanup(
        &pool,
        channel_id,
        Some("thumbnails/new.jpg".to_string()),
    )
    .await
    .unwrap()
    .expect("channel exists");

    assert_eq!(paths(&plan.deletable), vec!["thumbnails/old.jpg"]);
    assert!(plan.skipped_shared_paths.is_empty());

    let avatar =
        sqlx::query_as::<_, (Option<String>,)>("SELECT avatar_path FROM channels WHERE id = ?")
            .bind(channel_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(avatar.0.as_deref(), Some("thumbnails/new.jpg"));
}

#[tokio::test]
async fn replace_avatar_plan_keeps_previous_when_used_as_a_video_thumbnail() {
    let pool = create_test_pool().await;
    let channel_id = insert_channel(&pool, "@one", Some("thumbnails/shared.jpg")).await;
    // The avatar file is also a video's thumbnail: replacing the avatar must not delete
    // it. This is the reference the old frontend-only count ignored.
    insert_media(
        &pool,
        channel_id,
        "video/a.mp4",
        Some("thumbnails/shared.jpg"),
        None,
    )
    .await;

    let plan = replace_channel_avatar_and_plan_cleanup(
        &pool,
        channel_id,
        Some("thumbnails/new.jpg".to_string()),
    )
    .await
    .unwrap()
    .expect("channel exists");

    assert!(plan.deletable.is_empty());
    assert_eq!(plan.skipped_shared_paths, vec!["thumbnails/shared.jpg"]);
}

#[tokio::test]
async fn replace_avatar_plan_keeps_previous_when_used_by_another_channel() {
    let pool = create_test_pool().await;
    let channel_a = insert_channel(&pool, "@a", Some("thumbnails/shared.jpg")).await;
    insert_channel(&pool, "@b", Some("thumbnails/shared.jpg")).await;

    let plan = replace_channel_avatar_and_plan_cleanup(&pool, channel_a, None)
        .await
        .unwrap()
        .expect("channel exists");

    assert!(plan.deletable.is_empty());
    assert_eq!(plan.skipped_shared_paths, vec!["thumbnails/shared.jpg"]);
}

#[tokio::test]
async fn replace_avatar_plan_is_noop_when_unchanged() {
    let pool = create_test_pool().await;
    let channel_id = insert_channel(&pool, "@one", Some("thumbnails/same.jpg")).await;

    let plan = replace_channel_avatar_and_plan_cleanup(
        &pool,
        channel_id,
        Some("  thumbnails/same.jpg  ".to_string()),
    )
    .await
    .unwrap()
    .expect("channel exists");

    assert!(plan.deletable.is_empty());
    assert!(plan.skipped_shared_paths.is_empty());
}

#[tokio::test]
async fn replace_avatar_plan_returns_none_for_missing_channel() {
    let pool = create_test_pool().await;

    let plan = replace_channel_avatar_and_plan_cleanup(&pool, 999, None)
        .await
        .unwrap();

    assert!(plan.is_none());
}

fn unique_test_dir(suffix: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "kavynex-library-cleanup-test-{suffix}-{}",
        crate::utils::naming::unique_temp_suffix()
    ))
}

#[test]
fn remove_planned_artifacts_deletes_files_and_reports_missing_as_deleted() {
    let library = unique_test_dir("remove");
    fs::create_dir_all(library.join("video")).unwrap();
    fs::create_dir_all(library.join("thumbnails")).unwrap();
    fs::create_dir_all(library.join("live_chat")).unwrap();
    fs::write(library.join("video/a.mp4"), b"media").unwrap();
    fs::write(library.join("live_chat/a.json.gz"), b"chat").unwrap();
    // thumbnails/a.jpg intentionally does not exist: deletion of a missing file is a
    // no-op success, matching the individual delete services.

    let plan = ArtifactCleanupPlan {
        deletable: vec![
            DeletableArtifact {
                kind: ArtifactKind::MediaFile,
                path: "video/a.mp4".to_string(),
            },
            DeletableArtifact {
                kind: ArtifactKind::Thumbnail,
                path: "thumbnails/a.jpg".to_string(),
            },
            DeletableArtifact {
                kind: ArtifactKind::LiveChat,
                path: "live_chat/a.json.gz".to_string(),
            },
        ],
        skipped_shared_paths: vec!["video/shared.mp4".to_string()],
    };

    let report = remove_planned_artifacts_sync(&library, None, plan);

    assert_eq!(
        report.deleted_paths,
        vec!["video/a.mp4", "thumbnails/a.jpg", "live_chat/a.json.gz"]
    );
    assert_eq!(report.skipped_shared_paths, vec!["video/shared.mp4"]);
    assert!(report.failed_paths.is_empty());
    assert!(!library.join("video/a.mp4").exists());
    assert!(!library.join("live_chat/a.json.gz").exists());

    let _ = fs::remove_dir_all(&library);
}

/// The 64-hex stem a content-addressed thumbnail carries, so the derivative naming below is
/// spelled out rather than derived from the function under test.
const TEST_THUMBNAIL_HASH: &str =
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

#[test]
fn removing_a_thumbnail_drops_its_display_derivative_too() {
    // Nothing else ever would. A derivative is addressed by the canonical thumbnail's own
    // content hash and no row refers to one, so before this the only bound on that directory
    // was the startup size sweep, which trims oldest-first once the whole cache is over
    // budget, and therefore has nothing to do with what was deleted. Deleting a media left its
    // thumbnail readable in the cache until enough unrelated browsing pushed the cache past
    // its ceiling.
    let root = unique_test_dir("display-derivative");
    let library = root.join("library");
    let display_dir = root.join("thumb-display");
    fs::create_dir_all(library.join("thumbnails")).unwrap();
    fs::create_dir_all(&display_dir).unwrap();

    let relative = format!("thumbnails/thumb_{TEST_THUMBNAIL_HASH}.jpg");
    fs::write(
        library
            .join("thumbnails")
            .join(format!("thumb_{TEST_THUMBNAIL_HASH}.jpg")),
        b"thumb",
    )
    .unwrap();

    // Spelled out rather than built with display_derivative_path, so this pins the name the
    // resolve path writes under instead of agreeing with whatever that function returns. The
    // width is in it because changing DISPLAY_THUMBNAIL_MAX_WIDTH has to invalidate the cache.
    let derivative = display_dir.join(format!("{TEST_THUMBNAIL_HASH}-w640.jpg"));
    fs::write(&derivative, b"derivative").unwrap();

    // A second derivative for an unrelated thumbnail, to pin that the removal is addressed
    // rather than a sweep of the directory.
    let unrelated = display_dir.join(format!("{}-w640.jpg", "f".repeat(64)));
    fs::write(&unrelated, b"unrelated").unwrap();

    let plan = ArtifactCleanupPlan {
        deletable: vec![DeletableArtifact {
            kind: ArtifactKind::Thumbnail,
            path: relative.clone(),
        }],
        skipped_shared_paths: Vec::new(),
    };

    let report = remove_planned_artifacts_sync(&library, Some(&display_dir), plan);

    assert_eq!(report.deleted_paths, vec![relative]);
    assert!(
        !derivative.exists(),
        "the derivative should be gone with it"
    );
    assert!(
        unrelated.exists(),
        "only the deleted thumbnail's copy should go"
    );

    let _ = fs::remove_dir_all(&root);
}

#[test]
fn removing_a_media_file_leaves_the_display_cache_alone() {
    // The kind check, in the direction that would be silent. Dropping it would make every
    // deletion walk the cache for a key derived from a `video/...` path, which yields None
    // today, so nothing observable happens until some later name change makes it yield a
    // path, at which point a media delete starts removing an unrelated media's derivative.
    let root = unique_test_dir("display-derivative-media");
    let library = root.join("library");
    let display_dir = root.join("thumb-display");
    fs::create_dir_all(library.join("video")).unwrap();
    fs::create_dir_all(&display_dir).unwrap();
    fs::write(library.join("video/a.mp4"), b"media").unwrap();

    let derivative = display_dir.join(format!("{TEST_THUMBNAIL_HASH}-w640.jpg"));
    fs::write(&derivative, b"derivative").unwrap();

    let plan = ArtifactCleanupPlan {
        deletable: vec![DeletableArtifact {
            kind: ArtifactKind::MediaFile,
            path: "video/a.mp4".to_string(),
        }],
        skipped_shared_paths: Vec::new(),
    };

    remove_planned_artifacts_sync(&library, Some(&display_dir), plan);

    assert!(derivative.exists());

    let _ = fs::remove_dir_all(&root);
}

#[test]
fn a_thumbnail_that_could_not_be_removed_keeps_its_derivative() {
    // The ordering. The derivative is the cheaper of the two to lose, so a thumbnail whose
    // unlink failed (it is reported as possibly orphaned, and still on disk) must keep the
    // copy the grid can still draw from. Forcing the failure with a directory at the
    // thumbnail's path, which is portable, unlike a permission trick.
    let root = unique_test_dir("display-derivative-failed");
    let library = root.join("library");
    let display_dir = root.join("thumb-display");
    let relative = format!("thumbnails/thumb_{TEST_THUMBNAIL_HASH}.jpg");
    fs::create_dir_all(library.join(&relative)).unwrap();
    fs::create_dir_all(&display_dir).unwrap();

    let derivative = display_dir.join(format!("{TEST_THUMBNAIL_HASH}-w640.jpg"));
    fs::write(&derivative, b"derivative").unwrap();

    let plan = ArtifactCleanupPlan {
        deletable: vec![DeletableArtifact {
            kind: ArtifactKind::Thumbnail,
            path: relative.clone(),
        }],
        skipped_shared_paths: Vec::new(),
    };

    let report = remove_planned_artifacts_sync(&library, Some(&display_dir), plan);

    assert_eq!(report.failed_paths, vec![relative]);
    assert!(derivative.exists());

    let _ = fs::remove_dir_all(&root);
}

#[test]
fn an_unresolvable_display_cache_does_not_fail_the_removal() {
    // `None` is what execute_plan passes when the cache directory cannot be resolved. The
    // deletion the user asked for must still happen and still be reported. A cache entry is
    // not worth failing it over, and the size sweep reclaims the derivative regardless.
    let root = unique_test_dir("display-derivative-none");
    let library = root.join("library");
    fs::create_dir_all(library.join("thumbnails")).unwrap();

    let relative = format!("thumbnails/thumb_{TEST_THUMBNAIL_HASH}.jpg");
    fs::write(
        library
            .join("thumbnails")
            .join(format!("thumb_{TEST_THUMBNAIL_HASH}.jpg")),
        b"thumb",
    )
    .unwrap();

    let plan = ArtifactCleanupPlan {
        deletable: vec![DeletableArtifact {
            kind: ArtifactKind::Thumbnail,
            path: relative.clone(),
        }],
        skipped_shared_paths: Vec::new(),
    };

    let report = remove_planned_artifacts_sync(&library, None, plan);

    assert_eq!(report.deleted_paths, vec![relative]);
    assert!(report.failed_paths.is_empty());

    let _ = fs::remove_dir_all(&root);
}

#[test]
fn report_for_nothing_deletable_carries_the_shared_paths_through() {
    // execute_plan's empty-plan early return: nothing is deleted, but the paths the planner
    // spared as still-shared must survive into the report rather than being dropped.
    let plan = ArtifactCleanupPlan {
        deletable: Vec::new(),
        skipped_shared_paths: vec!["video/shared.mp4".to_string()],
    };

    let report = report_for_nothing_deletable(plan);

    assert_eq!(report.skipped_shared_paths, vec!["video/shared.mp4"]);
    assert!(report.deleted_paths.is_empty());
    assert!(report.failed_paths.is_empty());
}

#[test]
fn report_for_unavailable_library_marks_every_deletable_as_failed() {
    // execute_plan's library-unavailable branch: the rows are already committed as deleted but
    // no file can be located, so every planned unlink is reported failed (possibly orphaned)
    // while the spared shared paths still carry through.
    let plan = ArtifactCleanupPlan {
        deletable: vec![
            DeletableArtifact {
                kind: ArtifactKind::MediaFile,
                path: "video/a.mp4".to_string(),
            },
            DeletableArtifact {
                kind: ArtifactKind::Thumbnail,
                path: "thumbnails/a.jpg".to_string(),
            },
        ],
        skipped_shared_paths: vec!["video/shared.mp4".to_string()],
    };

    let report = report_for_unavailable_library(plan);

    assert_eq!(report.failed_paths, vec!["video/a.mp4", "thumbnails/a.jpg"]);
    assert_eq!(report.skipped_shared_paths, vec!["video/shared.mp4"]);
    assert!(report.deleted_paths.is_empty());
}

#[test]
fn remove_planned_artifacts_reports_traversal_paths_as_failed() {
    let library = unique_test_dir("traversal");
    fs::create_dir_all(&library).unwrap();

    let plan = ArtifactCleanupPlan {
        deletable: vec![DeletableArtifact {
            kind: ArtifactKind::LiveChat,
            path: "../outside.txt".to_string(),
        }],
        skipped_shared_paths: Vec::new(),
    };

    let report = remove_planned_artifacts_sync(&library, None, plan);

    assert!(report.deleted_paths.is_empty());
    assert_eq!(report.failed_paths, vec!["../outside.txt"]);

    let _ = fs::remove_dir_all(&library);
}
