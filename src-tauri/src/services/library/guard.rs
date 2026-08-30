//! Cross-checks a `library_path` received over IPC against the library directory
//! persisted in the application settings.
//!
//! Commands that create or delete files inside the library receive the library path from
//! the frontend for convenience, but that value must never be trusted on its own. A
//! compromised frontend could otherwise point a destructive command (delete a media
//! file, remove a migrated directory tree) at an arbitrary location on disk. Every
//! mutating command re-derives the expected directory from the persisted settings and
//! rejects any request that does not point at it, mirroring the check done by
//! `register_library_asset_scope`.

use std::path::PathBuf;

use sqlx::SqlitePool;
use tauri::{AppHandle, Runtime};

use crate::services::database::{get_app_settings_from_pool, shared_pool};
use crate::services::logger;
use crate::utils::path::{is_network_path, network_share_prefix};
use crate::utils::task::run_blocking;
use crate::{AppError, AppErrorCode, AppResult};

/// Resolves the configured library directory from the persisted settings. Media,
/// thumbnails and live chat files all live under it, so commands never take the base
/// directory from the caller. A compromised frontend cannot redirect reads/writes to an
/// arbitrary location.
/// Generic over the runtime for the reason [`crate::services::database::shared_pool`] is. The bare
/// `AppHandle` alias is the real runtime, which a mock-runtime test cannot produce.
pub async fn configured_library_dir<R: tauri::Runtime>(app: &AppHandle<R>) -> AppResult<PathBuf> {
    let pool = shared_pool(app).await?;
    let settings = get_app_settings_from_pool(&pool).await?;

    let library_path = settings
        .library_path
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            AppError::from_code(
                AppErrorCode::InvalidLibraryPath,
                "no library folder is configured",
            )
        })?;

    Ok(PathBuf::from(library_path))
}

/// Returns true when both strings point at the same location on disk. Each side is
/// canonicalized so casing, trailing separators and the Windows `\\?\` extended-length
/// prefix do not cause a false mismatch; when a path cannot be canonicalized (e.g. it
/// does not exist), a trimmed string comparison is used as a fallback. Empty inputs
/// never match.
pub fn paths_refer_to_same_location(requested: &str, configured: &str) -> bool {
    let requested = requested.trim();
    let configured = configured.trim();

    if requested.is_empty() || configured.is_empty() {
        return false;
    }

    // A network (UNC) `requested` path forces an SMB/NTLM handshake the moment it is canonicalized
    // on Windows (see utils::path::is_network_path). Refuse it *before* the canonicalize below
    // unless it names the very share the configured library lives on. A caller-supplied UNC aimed
    // at a local library is the NTLM-leak vector, and the guard's whole job is to hold against a
    // hostile IPC path. When the library itself is on a share (a supported configuration), the
    // same hostile caller could name another host, and refusing only "network against local"
    // would let that reach canonicalize and authenticate to it before the canonical compare said
    // no. So the host and share are compared textually first. The user's own share keeps working,
    // and a different one is refused without any filesystem call.
    if is_network_path(requested) {
        if !is_network_path(configured) {
            return false;
        }

        match (
            network_share_prefix(requested),
            network_share_prefix(configured),
        ) {
            (Some(requested_share), Some(configured_share))
                if requested_share == configured_share => {}
            _ => return false,
        }
    }

    match (
        std::fs::canonicalize(requested),
        std::fs::canonicalize(configured),
    ) {
        (Ok(canonical_requested), Ok(canonical_configured)) => {
            canonical_requested == canonical_configured
        }
        _ => requested == configured,
    }
}

/// Ensures `requested` matches the library directory persisted in the app settings.
///
/// The frontend always persists the library path before invoking any command that
/// mutates the library (settings are written before the library path state that drives
/// those commands changes), so a legitimate request always matches. Library migration
/// relies on the same invariant from the other side. The settings still hold the old
/// path while the migration runs, and the new path is only persisted after the
/// migration succeeds.
pub async fn ensure_configured_library_path<R: Runtime>(
    app: &AppHandle<R>,
    requested: &str,
) -> AppResult<()> {
    let pool = shared_pool(app).await?;
    ensure_configured_library_path_in_pool(&pool, requested).await
}

/// [`ensure_configured_library_path`] against a pool the caller already holds.
///
/// This is the real implementation; the `AppHandle` version above only resolves the shared pool
/// and delegates. The split exists so a command can run the guard while taking `State<'_, Db>`
/// instead of an `AppHandle` at all (the pool-only commands do). It also predates the day the
/// `AppHandle` version became generic over `R: Runtime`. A bare `AppHandle` parameter resolved to
/// the concrete `AppHandle<Wry>`, which no mock-runtime test could produce, so a command taking one
/// could not be driven through a real IPC round trip. Both shapes are registerable now, and a
/// command picks whichever matches what else it needs from the app.
pub async fn ensure_configured_library_path_in_pool(
    pool: &SqlitePool,
    requested: &str,
) -> AppResult<()> {
    let trimmed = requested.trim();

    if trimmed.is_empty() {
        return Err(AppError::from_code(
            AppErrorCode::InvalidLibraryPath,
            "library path is empty",
        ));
    }

    let configured_library_path = get_app_settings_from_pool(pool)
        .await?
        .library_path
        .unwrap_or_default();

    // `paths_refer_to_same_location` and the fallback-detection canonicalize below both call
    // `std::fs::canonicalize`, a blocking filesystem call. A library the user put on a network
    // share (a supported configuration) can make it block for the OS timeout when the share is
    // offline, so run the comparison off the async runtime rather than occupying a tokio worker.
    // consistent with every other filesystem touch in the backend.
    let requested = trimmed.to_string();
    run_blocking(move || {
        if !paths_refer_to_same_location(&requested, &configured_library_path) {
            return Err(AppError::from_code(
                AppErrorCode::InvalidLibraryPath,
                "requested path does not match the configured library directory",
            ));
        }

        // The match above compares canonical paths, but falls back to exact-string equality when a
        // path cannot be canonicalized, typically because the library lives on a drive that is
        // currently offline. That fallback grants the match without confirming canonical
        // containment, so record when acceptance rested on it. It leaves the degraded check
        // observable in the log rather than silent; the request is still only accepted when the
        // strings match exactly. The two paths are equal here (they just matched), so canonicalizing
        // the requested one is enough to tell the fallback branch apart from the canonical one.
        if std::fs::canonicalize(&requested).is_err() {
            logger::warn(
                "library_guard",
                "accepted the library path by exact-string match; it could not be canonicalized \
                 (the library directory may be offline), so canonical containment was not confirmed",
            );
        }

        Ok(())
    })
    .await
}

/// Verifies that `library_path` matches the configured library directory, then runs `f` on a
/// blocking thread with the verified path handed back to it.
///
/// This exists so a command that mutates the library through a caller-provided path cannot
/// run its filesystem work without the guard passing first. Coupling the check with execution
/// here makes the check impossible to forget by construction, which is exactly the omission
/// that would turn a "delete a file inside the library" command into an arbitrary-file
/// primitive. `f` receives the same (verified) path so it does not need to capture a second
/// copy of it.
pub async fn verify_library_path_then_blocking<F, T, R: Runtime>(
    app: &AppHandle<R>,
    library_path: String,
    f: F,
) -> AppResult<T>
where
    F: FnOnce(String) -> AppResult<T> + Send + 'static,
    T: Send + 'static,
{
    ensure_configured_library_path(app, &library_path).await?;
    run_blocking(move || f(library_path)).await
}

/// [`verify_library_path_then_blocking`] against a pool the caller already holds, for the same
/// reason [`ensure_configured_library_path_in_pool`] exists. It lets a command keep `State<'_, Db>`
/// and stay drivable through a real IPC round trip.
///
/// The coupling is the point here too. These are read-only commands, so the risk they carry is not
/// a destructive write but a *read* through a base directory the caller chose. A directory listing
/// or a file-manager spawn aimed anywhere on disk. Pairing the check with the work makes running
/// one without the other impossible rather than merely discouraged.
pub async fn verify_library_path_then_blocking_in_pool<F, T>(
    pool: &SqlitePool,
    library_path: String,
    f: F,
) -> AppResult<T>
where
    F: FnOnce(String) -> AppResult<T> + Send + 'static,
    T: Send + 'static,
{
    ensure_configured_library_path_in_pool(pool, &library_path).await?;
    run_blocking(move || f(library_path)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    /// An in-memory pool with the schema applied, for the guard tests that need a persisted
    /// setting to cross-check against rather than only the pure comparison.
    async fn memory_pool() -> SqlitePool {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("open in-memory database");

        crate::services::db_schema::ensure_schema(&pool)
            .await
            .expect("apply schema");

        pool
    }

    async fn pool_with_library_path(library_path: &str) -> SqlitePool {
        let pool = memory_pool().await;

        crate::services::database::set_app_settings_in_pool(
            &pool,
            &crate::services::database::StoredAppSettings {
                library_path: Some(library_path.to_string()),
                ..Default::default()
            },
        )
        .await
        .expect("persist the configured library path");

        pool
    }

    /// The combination the two halves of this module are only tested apart. A library the app
    /// cannot see (an external disk that is not plugged in, the state a user is most likely to be
    /// in right after restoring a database) still has to be *usable* through the guard.
    ///
    /// `same_location_falls_back_to_string_equality_for_missing_paths` pins the comparison itself,
    /// but nothing drove the guard end to end against a pool, so nothing said the fallback actually
    /// reaches a caller. If it did not, every library command would refuse while the drive was
    /// away, and reconnecting it would be the only cure for what looks like a corrupted install.
    #[tokio::test]
    async fn an_offline_library_is_still_accepted_by_its_exact_stored_path() {
        let offline = unique_test_dir("offline-library");
        let offline_str = offline.to_string_lossy().to_string();
        assert!(
            !offline.exists(),
            "the point of this test is a path that cannot be canonicalized"
        );

        let pool = pool_with_library_path(&offline_str).await;

        ensure_configured_library_path_in_pool(&pool, &offline_str)
            .await
            .expect("the configured library must stay usable while its drive is away");

        // Trailing whitespace is trimmed on both sides, so the same path spelled loosely still
        // matches. This is the one leniency the fallback has, and it is the caller's own value.
        ensure_configured_library_path_in_pool(&pool, &format!("  {offline_str}  "))
            .await
            .expect("the trimmed form of the stored path must match");
    }

    /// The other direction, and the one that makes the leniency above safe to have. While the
    /// library is offline the guard cannot canonicalize anything, so it is comparing strings; a
    /// different path must still be refused, or the degraded mode would be an open door for exactly
    /// the redirection this module exists to stop.
    #[tokio::test]
    async fn an_offline_library_still_refuses_a_path_that_is_not_it() {
        let offline = unique_test_dir("offline-library-refuse");
        let offline_str = offline.to_string_lossy().to_string();
        let pool = pool_with_library_path(&offline_str).await;

        for requested in [
            // A sibling whose name merely starts with the configured one. The case a `starts_with`
            // comparison would wave through.
            format!("{offline_str}-evil"),
            format!("{offline_str}/nested"),
            "/some/other/missing".to_string(),
            // A UNC path aimed at a local library, refused ahead of any filesystem call.
            r"\\evil\share".to_string(),
            String::new(),
        ] {
            let error = ensure_configured_library_path_in_pool(&pool, &requested)
                .await
                .expect_err("a path that is not the configured library must be refused");

            assert_eq!(error.code, AppErrorCode::InvalidLibraryPath.as_str());
        }
    }

    /// A library that *is* reachable takes the canonical path rather than the string fallback, so
    /// the two spellings of one directory agree. Asserted through the pool for the same reason as
    /// above. This is the normal case, and if it regressed the app would be unusable outright.
    #[tokio::test]
    async fn a_reachable_library_matches_through_canonicalization() {
        let library = unique_test_dir("reachable-library");
        fs::create_dir_all(&library).unwrap();
        let pool = pool_with_library_path(&library.to_string_lossy()).await;

        // Routing through a `..` segment gives a different string for the same directory on every
        // platform, which only a canonicalizing comparison accepts.
        let indirect = library.join("sub").join("..");
        fs::create_dir_all(library.join("sub")).unwrap();

        ensure_configured_library_path_in_pool(&pool, &indirect.to_string_lossy())
            .await
            .expect("a different spelling of the same reachable directory must match");

        let _ = fs::remove_dir_all(&library);
    }

    fn unique_test_dir(suffix: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "kavynex-library-guard-test-{suffix}-{}",
            crate::utils::naming::unique_temp_suffix()
        ))
    }

    #[test]
    fn same_location_matches_identical_existing_directory() {
        let dir = unique_test_dir("same");
        fs::create_dir_all(&dir).unwrap();

        let as_string = dir.to_string_lossy().to_string();
        assert!(paths_refer_to_same_location(&as_string, &as_string));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn same_location_rejects_different_directories() {
        let library = unique_test_dir("library");
        let outside = unique_test_dir("outside");
        fs::create_dir_all(&library).unwrap();
        fs::create_dir_all(&outside).unwrap();

        assert!(!paths_refer_to_same_location(
            &outside.to_string_lossy(),
            &library.to_string_lossy()
        ));

        let _ = fs::remove_dir_all(&library);
        let _ = fs::remove_dir_all(&outside);
    }

    #[test]
    fn same_location_rejects_sibling_with_prefixed_name() {
        // Guards against a naive string `starts_with` style comparison. "library-evil"
        // must never be treated as the same location as "library".
        let base = unique_test_dir("prefix");
        let library = base.join("library");
        let sibling = base.join("library-evil");
        fs::create_dir_all(&library).unwrap();
        fs::create_dir_all(&sibling).unwrap();

        assert!(!paths_refer_to_same_location(
            &sibling.to_string_lossy(),
            &library.to_string_lossy()
        ));

        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn same_location_rejects_a_network_requested_path_against_a_local_library() {
        // A caller-supplied UNC (in any spelling, including the mixed separators Windows still
        // resolves to a share) must never match a local configured library, and must be refused
        // before the canonicalize that would trigger the SMB/NTLM handshake.
        let library = unique_test_dir("local-library");
        fs::create_dir_all(&library).unwrap();
        let library_str = library.to_string_lossy().to_string();

        for requested in [
            r"\\evil\share",
            "//evil/share",
            r"/\evil\share",
            r"\/evil\share",
        ] {
            assert!(
                !paths_refer_to_same_location(requested, &library_str),
                "network requested path should not match a local library: {requested}"
            );
        }

        let _ = fs::remove_dir_all(&library);
    }

    #[test]
    fn same_location_rejects_a_network_requested_path_on_another_share_than_the_network_library() {
        // The configured library lives on a share. A hostile caller naming a different host (or a
        // different share on the same host) must be refused before canonicalize, which on Windows
        // would authenticate to that host. This is the case the "network against local" refusal
        // alone did not cover. With both sides network, it fell straight through to canonicalize.
        let configured = r"\\nas\videos";

        for requested in [
            r"\\evil\videos",
            r"\\evil\share\videos",
            r"\\nas\other",
            "//evil/videos",
            r"/\evil\videos",
            r"\\?\UNC\evil\videos",
            r"\\evil",
        ] {
            assert!(
                !paths_refer_to_same_location(requested, configured),
                "a network path on another share should not match: {requested}"
            );
        }
    }

    #[test]
    fn same_location_lets_the_network_library_through_however_its_share_is_spelled() {
        // The share-prefix compare is case-insensitive and separator-agnostic, so the user's own
        // share is never refused over spelling. Asserted on the prefix rather than through
        // `paths_refer_to_same_location`, because past the prefix check the other spellings go to
        // canonicalize, which on Windows would try to reach a host named `nas` from the test.
        let configured = r"\\nas\videos";

        for requested in [r"\\NAS\Videos", "//nas/videos", r"\\?\UNC\nas\videos\"] {
            assert_eq!(
                network_share_prefix(requested),
                network_share_prefix(configured),
                "the prefix compare must accept the library's own share: {requested}"
            );
        }
    }

    #[test]
    fn same_location_matches_two_identical_network_paths() {
        // A library the user deliberately put on a share must still match itself. The network-path
        // guard only rejects a network `requested` aimed at a *local* configured library (the
        // NTLM-leak vector), never a genuinely network-hosted one. Without this case the guard's
        // `!is_network_path(configured)` condition is only ever exercised against a local library,
        // where inverting it changes nothing (the string fallback rejects a mismatch either way).
        // The share does not exist, so this resolves through the trimmed-string fallback the
        // canonicalize failure drops to (on Linux, where the mutation gate runs, canonicalize
        // treats the UNC as a plain non-existent filename, so no network lookup happens).
        let unc = r"\\evil\share";
        assert!(paths_refer_to_same_location(unc, unc));
    }

    #[test]
    fn same_location_rejects_empty_inputs() {
        assert!(!paths_refer_to_same_location("", "/library"));
        assert!(!paths_refer_to_same_location("/library", "   "));
        assert!(!paths_refer_to_same_location("", ""));
    }

    #[test]
    fn same_location_matches_two_string_forms_of_one_directory() {
        // Two different strings that resolve to the same existing directory must match through
        // the canonical comparison, not a raw string compare (which would see them as distinct).
        // This is what lets the guard accept the frontend's path even when it differs from the
        // stored form only by casing, a trailing separator, or a `.`/`..` segment.
        let dir = unique_test_dir("canonical");
        let nested = dir.join("sub");
        fs::create_dir_all(&nested).unwrap();

        let direct = dir.to_string_lossy().to_string();
        // `dir/sub/..` canonicalizes back to `dir`, but is a different string than `dir` itself.
        let indirect = nested.join("..").to_string_lossy().to_string();

        assert_ne!(direct.trim(), indirect.trim());
        assert!(paths_refer_to_same_location(&direct, &indirect));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn same_location_falls_back_to_string_equality_for_missing_paths() {
        let missing = unique_test_dir("missing");
        let missing_str = missing.to_string_lossy().to_string();

        // Neither path exists, so canonicalize fails on both sides and the comparison
        // falls back to a trimmed string match.
        assert!(paths_refer_to_same_location(&missing_str, &missing_str));
        assert!(!paths_refer_to_same_location(
            &missing_str,
            "/some/other/missing"
        ));
    }
}
