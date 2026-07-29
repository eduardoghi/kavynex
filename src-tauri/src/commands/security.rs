use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, OnceLock};

use tauri::{AppHandle, Manager};

use crate::services::library::guard::ensure_configured_library_path;
use crate::services::logger;
use crate::utils::format::is_allowed_thumbnail_extension;
use crate::utils::path::extension_from_path;
use crate::utils::task::run_blocking;
use crate::{AppError, AppErrorCode, AppResult};

fn allow_directory_in_asset_scope(app: &AppHandle, dir: &Path) -> AppResult<()> {
    app.asset_protocol_scope()
        .allow_directory(dir, true)
        .map_err(|error| {
            AppError::from_code(
                AppErrorCode::AssetScopeRegisterFailed,
                format!("failed to allow directory in asset scope: {error}"),
            )
        })
}

/// Grants `primary` in the asset-protocol scope via `grant`, then best-effort also grants its
/// canonical (`\\?\`) form when that differs, logging a warning if the second grant fails rather
/// than dropping it silently. Shared by the directory and file registration paths, which differ
/// only in the grant closure; `subject` names the target in the warning ("library path" / "asset
/// file"). The primary grant's failure is propagated; only the canonical retry is best-effort.
fn grant_path_with_canonical<F>(primary: &Path, subject: &str, grant: F) -> AppResult<()>
where
    F: Fn(&Path) -> AppResult<()>,
{
    grant(primary)?;

    if let Ok(canonical) = std::fs::canonicalize(primary) {
        if canonical != primary {
            if let Err(error) = grant(&canonical) {
                logger::warn(
                    "asset_scope",
                    format!("failed to authorize canonical {subject} in asset scope: {error}"),
                );
            }
        }
    }

    Ok(())
}

/// The subdirectories of `library_root` whose files the asset protocol may serve: only the managed
/// media/thumbnail/live-chat trees the app writes itself (`video/`, `audio/`, `thumbnails/`,
/// `live_chat/`), never the library root. Every path the app legitimately reproduces is
/// content-addressed under one of these, so confining the grant to them keeps `convertFileSrc` from
/// reaching an unrelated file the user's chosen library folder happens to hold (a document, a photo)
/// - which granting the root recursively would expose.
pub(crate) fn managed_asset_scope_dirs(library_root: &Path) -> Vec<PathBuf> {
    crate::constants::MANAGED_LIBRARY_DIRS
        .iter()
        .map(|managed| library_root.join(managed))
        .collect()
}

/// The subdirectories of the app cache directory whose files the asset protocol may serve: the
/// preview written before a thumbnail is committed (`thumbs-temp/`) and the display-sized
/// derivatives the grid draws (`thumb-display/`). See
/// [`crate::constants::WEBVIEW_READABLE_CACHE_DIRS`] for why the other three are excluded.
///
/// The sibling of [`managed_asset_scope_dirs`], and it exists for the same reason: the cache root is
/// never granted. On Windows that root is the parent of the log directory and of the WebView2
/// profile, so granting it recursively - which is what this replaced - authorized the renderer to
/// read a tree that has nothing to do with rendering a thumbnail.
pub(crate) fn managed_cache_scope_dirs(cache_root: &Path) -> Vec<PathBuf> {
    crate::constants::WEBVIEW_READABLE_CACHE_DIRS
        .iter()
        .map(|managed| cache_root.join(managed))
        .collect()
}

/// Authorizes the cache subdirectories the webview renders from, called once from `lib.rs`'s
/// `setup()`. The library directory is authorized separately, at runtime, once the stored library
/// path is known ([`register_library_asset_scope`]).
///
/// Best effort throughout, exactly like the single recursive grant it replaced: a subdirectory that
/// cannot be created or authorized is logged and skipped rather than failing startup, because the
/// consequence is a thumbnail preview that does not appear, never an app that cannot open.
///
/// Each directory is created before it is granted so its canonical (`\\?\`) form resolves and can be
/// authorized alongside the plain one - the same two-form grant the library subdirectories need, for
/// the same reason (see [`grant_path_with_canonical`]). The directories are created on demand by
/// their writers anyway; doing it here is what makes the canonical grant possible on a first run.
pub fn register_cache_asset_scope(app: &AppHandle, cache_root: &Path) {
    for managed_dir in managed_cache_scope_dirs(cache_root) {
        if let Err(error) = std::fs::create_dir_all(&managed_dir) {
            logger::warn(
                "asset_scope",
                format!(
                    "failed to create cache directory {} for the asset scope: {error}",
                    logger::redact_path(&managed_dir)
                ),
            );
            continue;
        }

        let granted = grant_path_with_canonical(&managed_dir, "cache subdirectory", |dir| {
            allow_directory_in_asset_scope(app, dir)
        });

        if let Err(error) = granted {
            logger::warn(
                "asset_scope",
                format!(
                    "failed to authorize cache directory {} in asset scope: {error}",
                    logger::redact_path(&managed_dir)
                ),
            );
        }
    }
}

/// The managed directories this session has forbidden in the asset scope, i.e. the libraries the
/// app migrated *away* from while running.
///
/// This set exists because Tauri's asset scope is append-only in both directions: `is_allowed`
/// consults the forbidden patterns first and returns false on a match, and there is no API to
/// withdraw one. So once `revoke_directory_from_asset_scope` (commands/library.rs) forbids a
/// library's managed subdirectories, re-granting them later in the same session does nothing -
/// `allow_directory` succeeds, the forbid still wins, and every `convertFileSrc` into that library
/// resolves to a blocked asset.
///
/// That is reachable through an ordinary settings flow: move the library to a new folder, change
/// your mind, move it back. Without this set the second migration reports success, the grid renders
/// every item, and not one thumbnail or video loads, with nothing said. Recording what was forbidden
/// lets the re-registration say so instead.
fn session_forbidden_dirs() -> &'static Mutex<HashSet<PathBuf>> {
    static FORBIDDEN: OnceLock<Mutex<HashSet<PathBuf>>> = OnceLock::new();
    FORBIDDEN.get_or_init(|| Mutex::new(HashSet::new()))
}

/// The critical sections are a single insert or membership test, so a panic inside one is not a real
/// possibility; recover the guard rather than let poisoning propagate into a settings command.
fn lock_forbidden_dirs() -> MutexGuard<'static, HashSet<PathBuf>> {
    session_forbidden_dirs()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// True when any managed subdirectory of `library_root` has already been forbidden this session.
///
/// Pure over the set it is handed, so both directions can be pinned by a test without a Tauri
/// runtime and without touching process-wide state. Checks the managed subdirectories rather than
/// the root because those are exactly what the grant and the revoke operate on.
pub(crate) fn any_managed_dir_is_forbidden(
    library_root: &Path,
    forbidden: &HashSet<PathBuf>,
) -> bool {
    managed_asset_scope_dirs(library_root)
        .iter()
        .any(|dir| forbidden.contains(dir))
}

/// Records that `library_root`'s managed subdirectories were forbidden in the asset scope, so a
/// later attempt to re-authorize that library is refused with a clear reason instead of silently
/// succeeding into an unreadable library.
pub(crate) fn record_forbidden_library_dirs(library_root: &Path) {
    let mut forbidden = lock_forbidden_dirs();

    for dir in managed_asset_scope_dirs(library_root) {
        forbidden.insert(dir);
    }
}

/// Authorizes the asset protocol to read files inside the user's library directory.
///
/// The requested path is never trusted on its own: it must match the library path
/// persisted in the application settings. This prevents a compromised frontend from
/// widening the asset scope to an arbitrary directory which, combined with
/// `convertFileSrc`, would become an arbitrary local-file read primitive rendered inside
/// the webview. Only the directory the user actually configured as their library can be
/// authorized here.
///
/// Within that library, only the four managed subdirectories are granted, not the root
/// (see [`managed_asset_scope_dirs`]): the app only ever serves content-addressed files
/// from those, so authorizing the whole root recursively would needlessly expose any other
/// file the chosen library folder contains.
///
/// The asset protocol scope is in-memory and does not persist across restarts, so this
/// is called on startup (after settings load) and whenever the library path changes.
/// Both the path as stored (already canonical) and, when different, the freshly
/// canonicalized form are authorized so the extended-length (`\\?\`) and stripped
/// variants used by the frontend both match.
#[tauri::command]
pub async fn register_library_asset_scope(app: AppHandle, library_path: String) -> AppResult<()> {
    let trimmed = library_path.trim().to_string();

    // Re-derive the expected library directory from the persisted settings and reject any
    // request that does not point at it. The DB write always precedes this call in the
    // frontend (settings are persisted before the library path state that triggers the
    // registration changes), so a legitimate request always matches.
    ensure_configured_library_path(&app, &trimmed).await?;

    // Refuse rather than succeed into a library the scope will keep refusing to serve (see
    // session_forbidden_dirs). The guard runs after the path check above so an unauthorized path
    // still fails as one, and the lock is released before the blocking work below rather than held
    // across it.
    let already_forbidden = {
        let forbidden = lock_forbidden_dirs();
        any_managed_dir_is_forbidden(Path::new(&trimmed), &forbidden)
    };

    if already_forbidden {
        return Err(AppError::from_code(
            AppErrorCode::AssetScopeRestartRequired,
            "this library was released earlier in this session and cannot be served again until \
             the app restarts",
        ));
    }

    // canonicalize() and the asset scope registration are blocking filesystem/IPC calls;
    // run them off the async runtime's worker threads, consistent with other commands
    // (e.g. commands/library.rs, commands/thumbnail.rs).
    run_blocking(move || {
        for managed_dir in managed_asset_scope_dirs(Path::new(&trimmed)) {
            // Create the subdirectory first so its canonical (`\\?\`) form resolves and can be
            // granted alongside the plain form. Best effort: a subdir that cannot be created is
            // skipped (the import/download paths create it on demand), rather than failing the
            // whole registration and leaving the library unusable.
            if let Err(error) = std::fs::create_dir_all(&managed_dir) {
                logger::warn(
                    "asset_scope",
                    format!(
                        "failed to create managed directory {} for the asset scope: {error}",
                        logger::redact_path(&managed_dir)
                    ),
                );
                continue;
            }

            grant_path_with_canonical(&managed_dir, "library subdirectory", |dir| {
                allow_directory_in_asset_scope(&app, dir)
            })?;
        }

        Ok(())
    })
    .await
}

/// Authorizes the asset protocol to read a single user-selected image file.
///
/// Used for the manual thumbnail preview: the user picks an image from an arbitrary
/// location and it is previewed via `convertFileSrc` before being imported into the
/// library. To keep this from becoming a general arbitrary-file read primitive, only an
/// existing regular file whose extension is an allowed thumbnail image type can be
/// authorized, and only that exact file is granted (never its directory).
/// Validates that `path` is something that may be authorized for the manual-thumbnail
/// preview: an existing regular file with an allowed image extension. Extracted from the
/// command (which additionally needs the Tauri runtime to register the asset scope) so this
/// security check can be unit-tested without a runtime - the `AppHandle` command itself cannot
/// run under the mock runtime used in tests.
fn validate_asset_file_for_preview(path: &str) -> AppResult<()> {
    if path.trim().is_empty() {
        return Err(AppError::from_code(
            AppErrorCode::InvalidTargetPath,
            "path is empty",
        ));
    }

    let candidate = Path::new(path);

    if !candidate.is_file() {
        return Err(AppError::from_code(
            AppErrorCode::InvalidThumbnailFile,
            "path is not an existing file",
        ));
    }

    if !is_allowed_thumbnail_extension(&extension_from_path(candidate)) {
        return Err(AppError::from_code(
            AppErrorCode::InvalidThumbnailFile,
            "only image files can be authorized for preview",
        ));
    }

    Ok(())
}

#[tauri::command]
pub async fn allow_asset_file(app: AppHandle, path: String) -> AppResult<()> {
    let trimmed = path.trim().to_string();

    // is_file()/canonicalize() and the asset scope registration are blocking filesystem/IPC
    // calls; run them off the async runtime's worker threads, consistent with other commands
    // (e.g. commands/library.rs, commands/thumbnail.rs).
    run_blocking(move || {
        validate_asset_file_for_preview(&trimmed)?;

        grant_path_with_canonical(Path::new(&trimmed), "asset file", |file| {
            app.asset_protocol_scope()
                .allow_file(file)
                .map_err(|error| {
                    AppError::from_code(
                        AppErrorCode::AssetScopeRegisterFailed,
                        format!("failed to allow file in asset scope: {error}"),
                    )
                })
        })
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    fn unique_test_dir(suffix: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "kavynex-security-cmd-test-{suffix}-{}",
            crate::utils::naming::unique_temp_suffix()
        ))
    }

    // The asset-scope registration itself needs the Tauri runtime, which does not run under
    // the mock runtime; these cover the gate that decides what allow_asset_file will ever
    // authorize. The library-path guard behind register_library_asset_scope is covered by
    // services::library::guard's paths_refer_to_same_location tests.

    /// Records every path a `grant_path_with_canonical` run authorized, so its two-grant contract
    /// can be asserted without a Tauri runtime. The closure is `Fn`, not `FnMut`, so the recording
    /// needs interior mutability.
    fn record_grants(primary: &Path) -> AppResult<Vec<PathBuf>> {
        let granted = std::cell::RefCell::new(Vec::new());

        grant_path_with_canonical(primary, "test path", |path| {
            granted.borrow_mut().push(path.to_path_buf());
            Ok(())
        })?;

        Ok(granted.into_inner())
    }

    #[test]
    fn grant_path_with_canonical_authorizes_both_forms_when_they_differ() {
        // This is the whole reason the helper exists: convertFileSrc can hand the asset scope
        // either the plain path or its canonical (`\\?\`-prefixed, on Windows) form, and a scope
        // holding only one of them refuses the other - which surfaces as every thumbnail and video
        // silently failing to load, with nothing logged. Routing through a `..` segment yields a
        // path whose canonical form is a different string on every platform, which is what makes
        // this portable rather than Windows-only.
        let base = unique_test_dir("grant-differs");
        let nested = base.join("sub");
        fs::create_dir_all(&nested).unwrap();

        let indirect = nested.join("..");
        let canonical = indirect.canonicalize().unwrap();
        assert_ne!(
            indirect, canonical,
            "the two spellings must differ or this test asserts nothing"
        );

        let granted = record_grants(&indirect).unwrap();

        assert_eq!(
            granted,
            vec![indirect.clone(), canonical],
            "the requested form and its canonical form must both be authorized, in that order"
        );

        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn grant_path_with_canonical_authorizes_once_when_the_path_is_already_canonical() {
        // The other direction of the same comparison. Without it, inverting `canonical != primary`
        // still passes the test above by re-granting an identical path, so the redundant second
        // grant has to be ruled out explicitly.
        let base = unique_test_dir("grant-same");
        fs::create_dir_all(&base).unwrap();
        let canonical = base.canonicalize().unwrap();

        let granted = record_grants(&canonical).unwrap();

        assert_eq!(
            granted,
            vec![canonical],
            "an already-canonical path must be authorized exactly once"
        );

        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn grant_path_with_canonical_propagates_the_primary_failure_but_not_the_canonical_one() {
        // The documented asymmetry: failing to authorize the requested path is the caller's
        // problem, while the canonical retry is best effort and only warns. A change that made the
        // retry fatal would break registration for any path whose canonical form cannot be granted.
        let base = unique_test_dir("grant-failure");
        let nested = base.join("sub");
        fs::create_dir_all(&nested).unwrap();
        let indirect = nested.join("..");

        // The first grant fails: the error reaches the caller.
        let error = grant_path_with_canonical(&indirect, "test path", |_| {
            Err(AppError::from_code(
                AppErrorCode::AssetScopeRegisterFailed,
                "denied",
            ))
        })
        .unwrap_err();
        assert_eq!(error.code, AppErrorCode::AssetScopeRegisterFailed.as_str());

        // Only the canonical retry fails: the run still succeeds, and both grants were tried.
        let calls = std::cell::RefCell::new(0);
        grant_path_with_canonical(&indirect, "test path", |_| {
            let mut calls = calls.borrow_mut();
            *calls += 1;

            if *calls == 1 {
                Ok(())
            } else {
                Err(AppError::from_code(
                    AppErrorCode::AssetScopeRegisterFailed,
                    "denied",
                ))
            }
        })
        .expect("a failed canonical retry must not fail the registration");

        assert_eq!(calls.into_inner(), 2, "both grants should have been tried");

        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn managed_asset_scope_dirs_are_the_four_managed_subdirs_never_the_root() {
        let root = Path::new("/library");
        let dirs = managed_asset_scope_dirs(root);

        // Exactly the four managed subdirectories the app serves, and never the root itself:
        // granting the root recursively is what would expose unrelated files in the chosen folder.
        assert_eq!(dirs.len(), 4);
        assert!(dirs.contains(&root.join("video")));
        assert!(dirs.contains(&root.join("audio")));
        assert!(dirs.contains(&root.join("thumbnails")));
        assert!(dirs.contains(&root.join("live_chat")));
        assert!(!dirs.contains(&root.to_path_buf()));
    }

    #[test]
    fn managed_cache_scope_dirs_are_the_rendered_subdirs_never_the_root() {
        // The negative assertion is the one that matters, and it is what this function was created
        // to make testable: the grant it replaced was a single recursive `allow_directory` on the
        // cache root, and on Windows that root is `%LOCALAPPDATA%\<identifier>` - the parent of the
        // log directory and of the WebView2 profile. Granting the root therefore authorized the
        // renderer to read both, for no reason: only these two subdirectories are ever drawn.
        let root = Path::new("/cache");
        let dirs = managed_cache_scope_dirs(root);

        assert_eq!(dirs.len(), 2);
        assert!(dirs.contains(&root.join(crate::constants::TEMP_DIR_THUMBS)));
        assert!(dirs.contains(&root.join(crate::constants::TEMP_DIR_THUMB_DISPLAY)));

        assert!(
            !dirs.contains(&root.to_path_buf()),
            "the cache root must never be granted"
        );

        // The backend-only siblings, named explicitly rather than left to the length check: each
        // holds something the webview has no reason to read, and a future grant that widened this
        // list should have to delete an assertion that says so.
        for excluded in [
            crate::constants::TEMP_DIR_YT_DLP,
            crate::constants::TEMP_DIR_YT_DLP_THUMB,
            crate::constants::TEMP_DIR_PENDING_MEDIA,
            // Not one of ours to name as a constant, but it is the reason the root is refused: the
            // WebView2 user-data folder sits next to these on Windows.
            "EBWebView",
            "logs",
        ] {
            assert!(
                !dirs.contains(&root.join(excluded)),
                "{excluded} must not be authorized in the asset scope"
            );
        }
    }

    #[test]
    fn a_library_is_not_forbidden_until_one_of_its_managed_dirs_is() {
        let library = Path::new("/library");
        let mut forbidden = HashSet::new();

        assert!(
            !any_managed_dir_is_forbidden(library, &forbidden),
            "a library nothing has revoked must still be authorizable"
        );

        // A single revoked subdirectory is enough: the scope refuses that tree for the rest of the
        // session, so re-registering the library would leave part of it unreadable.
        forbidden.insert(library.join("video"));

        assert!(any_managed_dir_is_forbidden(library, &forbidden));
    }

    #[test]
    fn forbidding_one_library_leaves_a_different_one_authorizable() {
        // The normal migration is A -> B, and B must not inherit A's revocation - otherwise the
        // guard would break the very flow it is meant to protect. Also covers the prefix case: a
        // sibling whose path starts with the revoked one is a different library.
        let old_library = Path::new("/library");
        let forbidden: HashSet<PathBuf> =
            managed_asset_scope_dirs(old_library).into_iter().collect();

        assert!(any_managed_dir_is_forbidden(old_library, &forbidden));
        assert!(!any_managed_dir_is_forbidden(
            Path::new("/library-2"),
            &forbidden
        ));
        assert!(!any_managed_dir_is_forbidden(
            Path::new("/elsewhere"),
            &forbidden
        ));
    }

    #[test]
    fn recording_a_revoked_library_marks_every_managed_dir_it_owns() {
        // Pins that the recording side covers the same set the grant and the revoke walk, so a
        // library revoked through commands/library.rs is recognized whichever subdirectory the
        // re-registration would have started from.
        let library = unique_test_dir("forbidden-record");
        record_forbidden_library_dirs(&library);

        let forbidden = lock_forbidden_dirs();

        for managed_dir in managed_asset_scope_dirs(&library) {
            assert!(
                forbidden.contains(&managed_dir),
                "{} should be recorded as forbidden",
                managed_dir.display()
            );
        }
    }

    #[test]
    fn validate_asset_file_rejects_an_empty_path() {
        let error = validate_asset_file_for_preview("   ").unwrap_err();
        assert_eq!(error.code, AppErrorCode::InvalidTargetPath.as_str());
    }

    #[test]
    fn validate_asset_file_rejects_a_missing_file() {
        let missing = unique_test_dir("missing").join("nope.png");
        let error = validate_asset_file_for_preview(&missing.to_string_lossy()).unwrap_err();
        assert_eq!(error.code, AppErrorCode::InvalidThumbnailFile.as_str());
    }

    #[test]
    fn validate_asset_file_rejects_an_existing_non_image_file() {
        let dir = unique_test_dir("nonimage");
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("notes.txt");
        fs::write(&file, b"x").unwrap();

        let error = validate_asset_file_for_preview(&file.to_string_lossy()).unwrap_err();
        assert_eq!(error.code, AppErrorCode::InvalidThumbnailFile.as_str());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn validate_asset_file_rejects_a_directory_with_an_image_name() {
        // A directory named like an image must not be authorized - only regular files are.
        let dir = unique_test_dir("dir");
        let fake = dir.join("thumb.png");
        fs::create_dir_all(&fake).unwrap();

        let error = validate_asset_file_for_preview(&fake.to_string_lossy()).unwrap_err();
        assert_eq!(error.code, AppErrorCode::InvalidThumbnailFile.as_str());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn validate_asset_file_accepts_an_existing_image() {
        let dir = unique_test_dir("image");
        fs::create_dir_all(&dir).unwrap();

        for name in ["thumb.png", "photo.JPG", "art.webp"] {
            let file = dir.join(name);
            fs::write(&file, b"\x89PNG\r\n").unwrap();
            validate_asset_file_for_preview(&file.to_string_lossy())
                .unwrap_or_else(|error| panic!("{name} should be accepted: {error}"));
        }

        let _ = fs::remove_dir_all(&dir);
    }
}
