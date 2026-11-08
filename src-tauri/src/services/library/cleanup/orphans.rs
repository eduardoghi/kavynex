//! Finding the files in the library no row references, and moving the ones the app wrote to the
//! trash when Diagnostics is asked to.

use super::*;

/// The orphans `remove_orphan_artifacts` may delete. Files under `video/`, `audio/` and
/// `thumbnails/` that no row references and that carry the name the app gives what it writes
/// (`media_<sha256>.<ext>`, `thumb_<sha256>.<ext>`).
///
/// The name is the line between the app's leftovers and the user's own files. A library folder is
/// not required to be empty, and a file the user put in `video/` by hand is reported as an orphan
/// too, but it does not carry a digest in its name, so it stays. Live chat replays are left out
/// entirely, since their names carry no digest either.
///
/// "Referenced" is decided by digest, not by the path's spelling. A row whose stored path differs
/// from the file on disk only in letter case or separators (which the filesystem may treat as the
/// same file) still protects it, and so does any row naming the same digest under another
/// extension or folder, since a content-addressed name with that digest is the same bytes.
pub(crate) fn removable_orphans(
    library_dir: &Path,
    expected: &crate::services::library::integrity::ExpectedLibraryPaths,
) -> Vec<DeletableArtifact> {
    use crate::constants::{LIBRARY_DIR_AUDIO, LIBRARY_DIR_THUMBNAILS, LIBRARY_DIR_VIDEO};
    use crate::services::library::integrity::list_files_relative;
    use crate::services::library::verification::declared_content_hash;

    let groups: [(&str, ArtifactKind); 3] = [
        (LIBRARY_DIR_VIDEO, ArtifactKind::MediaFile),
        (LIBRARY_DIR_AUDIO, ArtifactKind::MediaFile),
        (LIBRARY_DIR_THUMBNAILS, ArtifactKind::Thumbnail),
    ];

    // Every digest any row names, from either list, lowercased. A stored path that declares no
    // digest protects nothing here, and needs not to, because only digest-named files are removed.
    let referenced_digests: std::collections::HashSet<String> = expected
        .media
        .iter()
        .chain(expected.thumbnails.iter())
        .filter_map(|path| {
            let file_name = path.rsplit(['/', '\\']).next().unwrap_or_default();
            declared_content_hash(file_name).map(str::to_ascii_lowercase)
        })
        .collect();

    let mut removable = Vec::new();

    for (subdir, kind) in groups {
        for relative in list_files_relative(&library_dir.join(subdir), library_dir) {
            let file_name = relative.rsplit('/').next().unwrap_or_default();

            let Some(digest) = declared_content_hash(file_name) else {
                continue;
            };

            if referenced_digests.contains(&digest.to_ascii_lowercase()) {
                continue;
            }

            removable.push(DeletableArtifact {
                kind,
                path: relative,
            });
        }
    }

    removable
}

/// The folder inside the library that orphan removals move files into, one subfolder per run.
pub(crate) const LIBRARY_TRASH_DIR: &str = ".trash";

/// How long the orphan removal is refused after the database was replaced, and how long a removal's
/// files wait in [`LIBRARY_TRASH_DIR`] before the startup sweep purges them. The Diagnostics dialog
/// tells the user this number, and `shared/orphan-grace-period.json` keeps the two the same.
pub(crate) const ORPHAN_GRACE_PERIOD: std::time::Duration =
    std::time::Duration::from_secs(30 * 24 * 60 * 60);

/// A file written this recently is never treated as an orphan. A thumbnail or a channel avatar is
/// written into the library one IPC call before the row that references it, and nothing holds the
/// two together, so a removal in between would take a file that is about to be referenced.
pub(super) const RECENT_WRITE_WINDOW: std::time::Duration = std::time::Duration::from_secs(60 * 60);

/// `relative` (with `/` separators) under `base`, pushed a component at a time, since a verbatim
/// (`\\?\`) base on Windows takes a forward slash literally.
pub(super) fn library_relative(base: &Path, relative: &str) -> std::path::PathBuf {
    let mut path = base.to_path_buf();
    for part in relative.split('/') {
        path.push(part);
    }
    path
}

/// Whether `path` was modified within [`RECENT_WRITE_WINDOW`]. A copy into the library is stamped
/// with the time it was made (`filesystem::copy_bytes_whole`), so this is when the file arrived.
pub(super) fn was_written_recently(path: &Path) -> bool {
    std::fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .map(|modified| {
            std::time::SystemTime::now()
                .duration_since(modified)
                .map_or(true, |age| age < RECENT_WRITE_WINDOW)
        })
        .unwrap_or(false)
}

/// Below this many removable files the share rule in [`orphan_removal_refusal`] does not apply. A
/// small library with a handful of leftovers would otherwise be refused for being small.
pub(super) const SHARE_RULE_MIN_FILES: usize = 10;

/// Why the orphan removal will not run on this library right now.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub enum OrphanRemovalRefusal {
    /// The database was imported or restored within [`ORPHAN_GRACE_PERIOD`]. Files the previous
    /// database used read as orphans to this one, and undoing the import would bring back rows
    /// pointing at them.
    RecentDatabaseSwap,
    /// Most of the files Kavynex named are unreferenced, which is what an older or another
    /// library's database looks like rather than leftovers.
    MostFilesUnreferenced,
}

/// What an orphan removal would do on this library, for Diagnostics to show before it is asked.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub struct OrphanRemovalPlan {
    #[cfg_attr(test, ts(type = "number"))]
    pub files: usize,
    #[cfg_attr(test, ts(type = "number"))]
    pub bytes: u64,
    pub refusal: Option<OrphanRemovalRefusal>,
}

/// The refusal rule, apart from the filesystem so each branch is one call from a test.
pub(crate) fn orphan_removal_refusal(
    removable: usize,
    content_addressed_total: usize,
    recent_database_swap: bool,
) -> Option<OrphanRemovalRefusal> {
    if removable == 0 {
        return None;
    }

    if recent_database_swap {
        return Some(OrphanRemovalRefusal::RecentDatabaseSwap);
    }

    if removable >= SHARE_RULE_MIN_FILES && removable * 2 > content_addressed_total {
        return Some(OrphanRemovalRefusal::MostFilesUnreferenced);
    }

    None
}

/// How many files under the media and thumbnail folders carry a name the app gives what it writes,
/// referenced or not. The denominator of the share rule.
pub(super) fn count_content_addressed_files(library_dir: &Path) -> usize {
    use crate::constants::{LIBRARY_DIR_AUDIO, LIBRARY_DIR_THUMBNAILS, LIBRARY_DIR_VIDEO};
    use crate::services::library::integrity::list_files_relative;
    use crate::services::library::verification::declared_content_hash;

    [LIBRARY_DIR_VIDEO, LIBRARY_DIR_AUDIO, LIBRARY_DIR_THUMBNAILS]
        .iter()
        .flat_map(|subdir| list_files_relative(&library_dir.join(subdir), library_dir))
        .filter(|relative| {
            let file_name = relative.rsplit('/').next().unwrap_or_default();
            declared_content_hash(file_name).is_some()
        })
        .count()
}

/// Lists the removable orphans and decides whether removing them is allowed. Blocking (it walks the
/// library).
///
/// `awaiting_return` is what a crash marker says a Move import took from the user
/// (`pending_media::moved_files_awaiting_return`). Such a file has no row and may be the only copy,
/// and the startup sweep is what puts it back, so it is never offered for removal.
pub(crate) fn plan_orphan_removal(
    library_dir: &Path,
    expected: &crate::services::library::integrity::ExpectedLibraryPaths,
    recent_database_swap: bool,
    awaiting_return: &std::collections::HashSet<String>,
) -> (OrphanRemovalPlan, Vec<DeletableArtifact>) {
    let removable: Vec<DeletableArtifact> = removable_orphans(library_dir, expected)
        .into_iter()
        .filter(|artifact| !awaiting_return.contains(&artifact.path))
        .filter(|artifact| !was_written_recently(&library_relative(library_dir, &artifact.path)))
        .collect();

    let bytes = removable
        .iter()
        .filter_map(|artifact| {
            std::fs::metadata(library_relative(library_dir, &artifact.path)).ok()
        })
        .map(|metadata| metadata.len())
        .sum();

    let refusal = orphan_removal_refusal(
        removable.len(),
        count_content_addressed_files(library_dir),
        recent_database_swap,
    );

    (
        OrphanRemovalPlan {
            files: removable.len(),
            bytes,
            refusal,
        },
        removable,
    )
}

/// Whether the database at `db_path` was imported or restored within [`ORPHAN_GRACE_PERIOD`].
pub(crate) fn database_was_recently_swapped(db_path: &Path) -> bool {
    crate::services::db_backup::database_swapped_within(db_path, ORPHAN_GRACE_PERIOD)
}

/// Moves one orphan into `trash_dir`, keeping its library-relative path under it.
pub(super) fn move_orphan_to_trash(
    library_dir: &Path,
    trash_dir: &Path,
    artifact: &DeletableArtifact,
) -> AppResult<()> {
    let subtree = match artifact.kind {
        ArtifactKind::MediaFile => ManagedSubtree::Media,
        ArtifactKind::Thumbnail => ManagedSubtree::Thumbnails,
        ArtifactKind::LiveChat => ManagedSubtree::LiveChat,
    };

    let source = absolute_path_from_relative(library_dir, &artifact.path, subtree)?;

    if !source.exists() {
        return Ok(());
    }

    ensure_existing_path_inside_dir(&source, library_dir)?;

    let target = library_relative(trash_dir, &artifact.path);

    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|error| {
            AppError::fs_error(
                AppErrorCode::CreateDirectoryFailed,
                "failed to create the library trash folder",
                parent,
                &error,
            )
        })?;
    }

    crate::services::filesystem::rename_retrying(&source, &target).map_err(|error| {
        AppError::fs_error(
            AppErrorCode::FileMoveFailed,
            "failed to move an orphan file to the library trash",
            &source,
            &error,
        )
    })
}

/// Moves each planned orphan into a new `.trash/<timestamp>` folder of the library. Reports a moved
/// file as deleted, since it is gone from where the library looks.
pub(super) fn move_orphans_to_trash_sync(
    library_dir: &Path,
    display_dir: Option<&Path>,
    deletable: Vec<DeletableArtifact>,
) -> ArtifactCleanupReport {
    let _library_guard = crate::services::library::lock::library_read_guard();

    // Nothing is moved when something other than a real folder inside the library sits at `.trash`,
    // since the files would leave the library for wherever it points.
    if let Err(error) = crate::services::library::trash::existing_trash_dir(library_dir) {
        logger::error(
            "library_cleanup",
            format!("nothing was moved to the trash: {error}"),
        );

        return ArtifactCleanupReport {
            failed_paths: deletable
                .into_iter()
                .map(|artifact| artifact.path)
                .collect(),
            ..ArtifactCleanupReport::default()
        };
    }

    let trash_dir = library_dir.join(LIBRARY_TRASH_DIR).join(format!(
        "{}-{}",
        chrono::Utc::now().format("%Y%m%dT%H%M%SZ"),
        crate::utils::naming::unique_temp_suffix()
    ));

    let mut report = ArtifactCleanupReport::default();

    for artifact in deletable {
        match move_orphan_to_trash(library_dir, &trash_dir, &artifact) {
            Ok(()) => {
                if artifact.kind == ArtifactKind::Thumbnail {
                    drop_display_derivative(display_dir, &artifact.path);
                }

                report.deleted_paths.push(artifact.path);
            }
            Err(error) => {
                logger::error(
                    "library_cleanup",
                    format!(
                        "orphan '{}' could not be moved to the trash: {error}",
                        artifact.path
                    ),
                );
                report.failed_paths.push(artifact.path);
            }
        }
    }

    report
}

/// Moves the library files no row references, which is what Diagnostics reports as orphans, into
/// the library's `.trash` folder, limited to the ones `removable_orphans` recognizes as the app's
/// own. The startup sweep purges a trash folder once it is older than [`ORPHAN_GRACE_PERIOD`].
///
/// Refused when [`orphan_removal_refusal`] says the database does not describe this folder well
/// enough to call its files leftovers. Refused while a media creation is running, and holds every
/// new one off until it is done (see `media_creation::try_exclude_creations`), since a creation's
/// artifacts sit in the library unreferenced until its row lands. Also holds
/// [`MEDIA_REGISTRATION_LOCK`], which the startup sweep and the avatar cleanup take. Each path is
/// recounted against the database right before it moves.
pub async fn remove_orphan_artifacts<R: Runtime>(
    app: &AppHandle<R>,
) -> AppResult<ArtifactCleanupReport> {
    // Taken without waiting and before the registration lock. A creation takes the two in the
    // other order (its gate for the whole run, the lock around the insert), so waiting here while
    // holding the lock could deadlock.
    let Some(_creations_excluded) = crate::services::media_creation::try_exclude_creations() else {
        return Err(AppError::from_code(
            AppErrorCode::MediaCreationInProgress,
            "a media is being added, so its files are not referenced yet",
        ));
    };

    let _guard = MEDIA_REGISTRATION_LOCK.lock().await;

    let pool = shared_pool(app).await?;
    let references =
        crate::services::video_repository::list_media_integrity_references(&pool).await?;
    let avatar_paths = crate::services::channel_repository::list_channel_image_paths(&pool).await?;
    let expected =
        crate::services::library::integrity::expected_library_paths(&references, avatar_paths);
    let library_dir = configured_library_dir(app).await?;
    let db_path = crate::services::database::database_path(app)?;
    let recent_database_swap =
        run_blocking(move || Ok(database_was_recently_swapped(&db_path))).await?;

    let planning_dir = library_dir.clone();
    let planning_app = app.clone();
    let (removal, deletable) = run_blocking(move || {
        let awaiting_return =
            crate::services::pending_media::moved_files_awaiting_return(&planning_app);

        Ok(plan_orphan_removal(
            &planning_dir,
            &expected,
            recent_database_swap,
            &awaiting_return,
        ))
    })
    .await?;

    if let Some(refusal) = removal.refusal {
        return Err(AppError::from_code(
            AppErrorCode::OrphanRemovalRefused,
            match refusal {
                OrphanRemovalRefusal::RecentDatabaseSwap => {
                    "the database was imported or restored recently, so unreferenced files may belong to the previous one"
                }
                OrphanRemovalRefusal::MostFilesUnreferenced => {
                    "most of the library's files are unreferenced, which looks like a database that does not describe this folder"
                }
            },
        ));
    }

    let mut plan = ArtifactCleanupPlan {
        deletable,
        skipped_shared_paths: Vec::new(),
    };

    if plan.deletable.is_empty() {
        return Ok(ArtifactCleanupReport::default());
    }

    drop_paths_referenced_again(&pool, &mut plan).await;

    let display_dir = thumb_display_dir_async(app).await.ok();

    run_blocking(move || {
        Ok(move_orphans_to_trash_sync(
            &library_dir,
            display_dir.as_deref(),
            plan.deletable,
        ))
    })
    .await
}
