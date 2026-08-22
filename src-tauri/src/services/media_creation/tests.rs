// The tests for the parent module, kept in a file of their own so the module reads as its
// production code. Same module as before (`mod tests` declared under `#[cfg(test)]` in the
// parent), so `use super::*` still reaches every private item it did.

use super::*;

fn request(source_mode: MediaSourceMode) -> CreateMediaRequest {
    CreateMediaRequest {
        channel_id: 1,
        title: "A title".to_string(),
        source_mode,
        source_value: "https://www.youtube.com/watch?v=abc".to_string(),
        thumbnail_source_path: None,
        media_type: "video".to_string(),
        import_mode: ImportMode::Copy,
        library_path: "/library".to_string(),
        published_at: None,
        yt_dlp_run_id: "run-1".to_string(),
        yt_dlp_format_id: "137+140".to_string(),
        yt_dlp_youtube_video_id: None,
        download_live_chat: false,
        cookies_browser: None,
        cookies_path: None,
    }
}

fn with_video_id(source_mode: MediaSourceMode, video_id: Option<&str>) -> CreateMediaRequest {
    CreateMediaRequest {
        yt_dlp_youtube_video_id: video_id.map(str::to_string),
        ..request(source_mode)
    }
}

#[test]
fn a_managed_thumbnail_path_is_taken_as_it_is() {
    // The one case that must not be re-persisted: it already names a file in the library, so
    // treating it as a local path would copy that file onto itself under a new hash.
    assert_eq!(
        classify_thumbnail_source(Some("thumbnails/thumb_abc.jpg")),
        ThumbnailSource::Managed("thumbnails/thumb_abc.jpg".to_string())
    );

    // Padding is stripped, because the value is used as a stored path from here on.
    assert_eq!(
        classify_thumbnail_source(Some("  thumbnails/thumb_abc.jpg  ")),
        ThumbnailSource::Managed("thumbnails/thumb_abc.jpg".to_string())
    );
}

#[test]
fn a_remote_url_is_classified_before_anything_treats_it_as_a_path() {
    // Reading a URL as a local path would hand it to the persist step, which would refuse it as
    // a missing file, so the failure would be confusing rather than dangerous. The reverse
    // (a path read as a URL) is the one that matters, which is why both directions are pinned.
    for value in [
        "https://i.ytimg.com/vi/abc/maxresdefault.jpg",
        "http://i.ytimg.com/vi/abc/hqdefault.jpg",
        "HTTPS://I.YTIMG.COM/vi/abc/maxresdefault.jpg",
    ] {
        assert!(
            matches!(
                classify_thumbnail_source(Some(value)),
                ThumbnailSource::Remote(_)
            ),
            "{value} should be classified as a remote URL"
        );
    }
}

#[test]
fn an_absolute_path_is_classified_on_either_platforms_spelling() {
    // The value can come off a row written on another machine (an imported library), so a
    // Windows path reaching a Linux build must still read as a path rather than falling through
    // to "absent" and silently dropping the user's chosen thumbnail.
    for value in [
        "/home/me/cover.png",
        r"C:\Users\me\cover.png",
        "C:/Users/me/cover.png",
        r"\\?\C:\Users\me\cover.png",
    ] {
        assert!(
            matches!(
                classify_thumbnail_source(Some(value)),
                ThumbnailSource::Local(_)
            ),
            "{value} should be classified as a local path"
        );
    }
}

#[test]
fn a_network_path_is_classified_local_and_then_refused_by_the_persist_it_reaches() {
    // `is_absolute_file_path` reads `\\host\share` as a path (it starts with a separator),
    // so the UNC spelling reaches `ThumbnailSource::Local` rather than `Absent`. That is the
    // branch that calls `persist_thumbnail_file_sync`, which is where the refusal lives;
    // pinning both halves here is what keeps a change to the classifier from routing a share
    // around it. The library is a path that does not exist so the assertion can also show
    // nothing was created before the refusal.
    let library = std::env::temp_dir().join(format!(
        "kavynex-media-creation-unc-{}",
        crate::utils::naming::unique_temp_suffix()
    ));

    for value in [r"\\evil\share\cover.jpg", "//evil/share/cover.jpg"] {
        let ThumbnailSource::Local(path) = classify_thumbnail_source(Some(value)) else {
            panic!("{value} should be classified as a local path");
        };

        let error = crate::services::thumbnail::persist_thumbnail_file_sync(
            &path,
            &library.to_string_lossy(),
        )
        .expect_err("a UNC thumbnail source must be refused");

        assert_eq!(error.code, AppErrorCode::InvalidSourceThumbnail.as_str());
    }

    assert!(!library.exists());
}

#[test]
fn a_value_that_names_nothing_the_app_wrote_is_absent() {
    // A bare relative name is not a managed path and not something this app can resolve, so it
    // reads as "no thumbnail supplied" and the normal derivation runs instead.
    for value in [
        None,
        Some(""),
        Some("   "),
        Some("cover.png"),
        Some("video/media_abc.mp4"),
        Some("thumbnails"),
    ] {
        assert_eq!(
            classify_thumbnail_source(value),
            ThumbnailSource::Absent,
            "should be absent: {value:?}"
        );
    }
}

#[test]
fn normalizing_trims_every_stored_value() {
    // A padded value validated in one form and stored in another is the validate-here/act-there
    // gap the database export gate documents; the same rule applies to everything persisted from
    // a creation.
    let padded = CreateMediaRequest {
        title: "  A title  ".to_string(),
        source_value: "  https://www.youtube.com/watch?v=abc  ".to_string(),
        library_path: "  /library  ".to_string(),
        thumbnail_source_path: Some("  thumbnails/thumb_abc.jpg  ".to_string()),
        published_at: Some("  2026-01-01  ".to_string()),
        yt_dlp_run_id: "  run-1  ".to_string(),
        yt_dlp_format_id: "  137  ".to_string(),
        yt_dlp_youtube_video_id: Some("  abc  ".to_string()),
        cookies_browser: Some("  firefox  ".to_string()),
        cookies_path: Some("  /tmp/cookies.txt  ".to_string()),
        ..request(MediaSourceMode::YtDlp)
    };

    let padded = CreateMediaRequest {
        media_type: "  video  ".to_string(),
        ..padded
    };

    let normalized = normalize_create_media_request(padded).unwrap();

    assert_eq!(normalized.title, "A title");
    // The media type is stored verbatim and compared verbatim by the `CHECK (media_type IN
    // ('video', 'audio'))` constraint, so a padded value would be validated (the validator
    // trims) and then rejected by the schema, or, worse on an older database without the
    // constraint, stored as a type nothing matches.
    assert_eq!(normalized.media_type, "video");
    assert_eq!(
        normalized.source_value,
        "https://www.youtube.com/watch?v=abc"
    );
    assert_eq!(normalized.library_path, "/library");
    assert_eq!(
        normalized.thumbnail_source_path.as_deref(),
        Some("thumbnails/thumb_abc.jpg")
    );
    assert_eq!(normalized.published_at.as_deref(), Some("2026-01-01"));
    assert_eq!(normalized.yt_dlp_run_id, "run-1");
    assert_eq!(normalized.yt_dlp_format_id, "137");
    assert_eq!(normalized.yt_dlp_youtube_video_id.as_deref(), Some("abc"));
    assert_eq!(normalized.cookies_browser.as_deref(), Some("firefox"));
    assert_eq!(normalized.cookies_path.as_deref(), Some("/tmp/cookies.txt"));
}

#[test]
fn a_blank_optional_value_normalizes_to_absent_rather_than_an_empty_string() {
    // An empty string is not the same as "not supplied" downstream: a blank youtube id stored
    // verbatim would sit in the partial unique index as a present value and collide with the
    // next blank one, which is exactly what insert_media normalizes away on its own side.
    let blanks = CreateMediaRequest {
        thumbnail_source_path: Some("   ".to_string()),
        published_at: Some("".to_string()),
        yt_dlp_youtube_video_id: Some("  ".to_string()),
        cookies_browser: Some("".to_string()),
        cookies_path: Some("   ".to_string()),
        ..request(MediaSourceMode::YtDlp)
    };

    let normalized = normalize_create_media_request(blanks).unwrap();

    assert_eq!(normalized.thumbnail_source_path, None);
    assert_eq!(normalized.published_at, None);
    assert_eq!(normalized.yt_dlp_youtube_video_id, None);
    assert_eq!(normalized.cookies_browser, None);
    assert_eq!(normalized.cookies_path, None);
}

#[test]
fn a_request_is_refused_before_anything_is_written() {
    // Each of these used to be checked by the frontend alone. They run here now, and they run
    // first: a rejected request must produce nothing to clean up, which is only true while no
    // download or import has started.
    let empty_title = CreateMediaRequest {
        title: "   ".to_string(),
        ..request(MediaSourceMode::Local)
    };
    assert_eq!(
        normalize_create_media_request(empty_title)
            .unwrap_err()
            .code,
        AppErrorCode::InvalidMediaTitle.as_str()
    );

    let bad_type = CreateMediaRequest {
        media_type: "image".to_string(),
        ..request(MediaSourceMode::Local)
    };
    assert_eq!(
        normalize_create_media_request(bad_type).unwrap_err().code,
        AppErrorCode::InvalidMediaCreationArguments.as_str()
    );

    let no_source = CreateMediaRequest {
        source_value: "  ".to_string(),
        ..request(MediaSourceMode::Local)
    };
    assert_eq!(
        normalize_create_media_request(no_source).unwrap_err().code,
        AppErrorCode::InvalidMediaCreationArguments.as_str()
    );

    let no_library = CreateMediaRequest {
        library_path: "".to_string(),
        ..request(MediaSourceMode::Local)
    };
    assert_eq!(
        normalize_create_media_request(no_library).unwrap_err().code,
        AppErrorCode::InvalidLibraryPath.as_str()
    );
}

#[test]
fn the_yt_dlp_arguments_are_required_only_for_a_yt_dlp_source() {
    // A local import carries neither a run id nor a format id, so demanding them would reject
    // every local add, and not demanding them for a download would let an empty value reach the
    // argv builder, where the character-class filter is the next thing that would catch it.
    let local = CreateMediaRequest {
        source_mode: MediaSourceMode::Local,
        source_value: "/home/me/clip.mp4".to_string(),
        yt_dlp_run_id: String::new(),
        yt_dlp_format_id: String::new(),
        ..request(MediaSourceMode::Local)
    };
    normalize_create_media_request(local).expect("a local import needs no yt-dlp arguments");

    let no_run_id = CreateMediaRequest {
        yt_dlp_run_id: "   ".to_string(),
        ..request(MediaSourceMode::YtDlp)
    };
    assert_eq!(
        normalize_create_media_request(no_run_id).unwrap_err().code,
        AppErrorCode::InvalidRunId.as_str()
    );

    let no_format_id = CreateMediaRequest {
        yt_dlp_format_id: "".to_string(),
        ..request(MediaSourceMode::YtDlp)
    };
    assert_eq!(
        normalize_create_media_request(no_format_id)
            .unwrap_err()
            .code,
        AppErrorCode::InvalidFormatId.as_str()
    );
}

#[test]
fn every_prepared_path_has_to_be_a_managed_library_path() {
    // The last refusal before a path reaches a row. These paths come from this crate's own
    // producers, so it should never fire, and it is here rather than trusted because the
    // deletion path acts on whatever the row holds.
    let good = PreparedArtifacts {
        file_path: "video/media_abc.mp4".to_string(),
        thumbnail_path: Some("thumbnails/thumb_abc.jpg".to_string()),
        live_chat_file_path: Some("live_chat/abc.live_chat.json.gz".to_string()),
        media_type: "video".to_string(),
        ..PreparedArtifacts::default()
    };
    ensure_managed_prepared_paths(&good).unwrap();

    for escaping in [
        PreparedArtifacts {
            file_path: "../escape.mp4".to_string(),
            ..good.clone()
        },
        PreparedArtifacts {
            thumbnail_path: Some("/etc/passwd".to_string()),
            ..good.clone()
        },
        PreparedArtifacts {
            live_chat_file_path: Some("Documents/secret.txt".to_string()),
            ..good.clone()
        },
    ] {
        assert!(
            ensure_managed_prepared_paths(&escaping).is_err(),
            "a path outside the managed layout must never reach a row"
        );
    }
}

#[test]
fn a_fetched_thumbnail_is_discarded_only_when_it_is_not_the_one_that_was_stored() {
    // The direction that matters: this answer becomes an unlink. Inverted, it discards the
    // thumbnail the row is about to point at and keeps the one nothing references, which shows
    // up as a card with no image and nothing logged anywhere.
    assert_eq!(
        fetched_thumbnail_to_discard(
            Some("thumbnails/thumb_fetched.jpg".to_string()),
            Some("thumbnails/thumb_supplied.jpg")
        ),
        Some("thumbnails/thumb_fetched.jpg".to_string())
    );

    // The two resolved to the same content-addressed file, so there is nothing left over.
    // discarding it here would unlink the file the row points at.
    assert_eq!(
        fetched_thumbnail_to_discard(
            Some("thumbnails/thumb_same.jpg".to_string()),
            Some("thumbnails/thumb_same.jpg")
        ),
        None
    );

    // Nothing was fetched: the run skipped its own thumbnail, which is the normal case when the
    // user supplied one.
    assert_eq!(
        fetched_thumbnail_to_discard(None, Some("thumbnails/thumb_supplied.jpg")),
        None
    );

    // Nothing was stored, so the fetched file is unreferenced and does go.
    assert_eq!(
        fetched_thumbnail_to_discard(Some("thumbnails/thumb_fetched.jpg".to_string()), None),
        Some("thumbnails/thumb_fetched.jpg".to_string())
    );

    assert_eq!(fetched_thumbnail_to_discard(None, None), None);
}

#[test]
fn a_cleanup_is_skipped_only_when_no_artifact_was_named_at_all() {
    // Every combination that names something has to answer true. The failure this guards is the
    // `&&`/`||` flip: with `||` the guard reads "skip if any is absent", and the ordinary
    // creation (a media file with no live chat replay) would skip its cleanup entirely,
    // stranding the file it just wrote.
    assert!(nothing_to_clean_up(None, None, None));

    assert!(!nothing_to_clean_up(Some("video/media_a.mp4"), None, None));
    assert!(!nothing_to_clean_up(
        None,
        Some("thumbnails/thumb_a.jpg"),
        None
    ));
    assert!(!nothing_to_clean_up(
        None,
        None,
        Some("live_chat/a.json.gz")
    ));
    assert!(!nothing_to_clean_up(
        Some("video/media_a.mp4"),
        Some("thumbnails/thumb_a.jpg"),
        None
    ));
    assert!(!nothing_to_clean_up(
        Some("video/media_a.mp4"),
        Some("thumbnails/thumb_a.jpg"),
        Some("live_chat/a.json.gz")
    ));
}

#[test]
fn the_duplicate_pre_check_applies_only_to_a_yt_dlp_source_with_a_resolved_video_id() {
    // Both halves, because both flips are silent: run it for a local import and the query
    // always answers "no" (there is no video id to match), skip it for a yt-dlp source and the
    // whole video downloads before the unique index refuses it.
    assert!(needs_youtube_duplicate_pre_check(&with_video_id(
        MediaSourceMode::YtDlp,
        Some("abc")
    )));

    assert!(!needs_youtube_duplicate_pre_check(&with_video_id(
        MediaSourceMode::YtDlp,
        None
    )));

    assert!(!needs_youtube_duplicate_pre_check(&with_video_id(
        MediaSourceMode::Local,
        Some("abc")
    )));

    assert!(!needs_youtube_duplicate_pre_check(&with_video_id(
        MediaSourceMode::Local,
        None
    )));
}

/// A run id no other test in this process uses, so registering it cannot collide with a
/// concurrently running test's entry in the process-wide download registry.
fn unique_run_id(label: &str) -> String {
    format!(
        "import-{label}-{}",
        crate::utils::naming::unique_temp_suffix()
    )
}

#[test]
fn a_well_formed_run_id_makes_a_local_import_cancellable() {
    // What the Cancel button rests on: the run has to reach the registry, because that is what
    // `cancel_media_download(runId)` looks the flag up in. Returning `None` here is a Cancel
    // button that silently does nothing. No error, no log the user sees, just a click that
    // does not land.
    //
    // The guard is bound rather than dropped immediately: dropping it unregisters the run, and
    // the flag would then belong to an id the cancel command can no longer find, which is the
    // same silent failure by a different route.
    let run_id = unique_run_id("valid");

    let cancellation = local_import_cancellation(&run_id)
        .expect("a well-formed run id should register and be cancellable");

    let (flag, _release) = cancellation;

    assert!(
        !flag.load(std::sync::atomic::Ordering::SeqCst),
        "a freshly registered run starts uncancelled"
    );
}

#[test]
fn a_malformed_run_id_is_refused_without_reaching_the_registry() {
    // The non-empty half of the guard, and the reason it is `||` rather than `&&`. An empty id
    // is refused either way, so it proves nothing: with `&&` the two conditions both hold for
    // `""` and the refusal still happens. Only a value that is *present but malformed* tells
    // the two apart (weakened to `&&` this falls through and registers a run id that
    // `is_valid_run_id` exists to keep out of a temp-directory name.
    // `..` is deliberately absent: it satisfies `is_valid_run_id`, and correctly so), the id
    // only ever becomes one component of `{run_id}-{suffix}`, so `..-<suffix>` is an ordinary
    // directory name and never a parent reference. What the rule keeps out is a separator.
    for malformed in ["has space", "a/b", "../evil", "x".repeat(200).as_str()] {
        assert!(
            local_import_cancellation(malformed).is_none(),
            "{malformed:?} should not be registered as a cancellable run"
        );
    }
}

#[test]
fn a_blank_run_id_simply_is_not_cancellable() {
    // The three ways a caller legitimately has no run id: an older frontend that sends none, a
    // caller with no Cancel button to offer, and whitespace that trims to nothing. None is an
    // error (the import still runs, it just cannot be cancelled), so this pins that the
    // function answers `None` rather than refusing the import.
    assert!(local_import_cancellation("").is_none());
    assert!(local_import_cancellation("   ").is_none());
}

#[test]
fn the_same_run_id_cannot_be_registered_twice() {
    // A duplicate id means this run is already registered, which the registry refuses, and the
    // documented response is an uncancellable import rather than a refused one. Holding the
    // first guard is what keeps the entry alive for the second call to collide with.
    let run_id = unique_run_id("duplicate");

    let first = local_import_cancellation(&run_id).expect("the first registration succeeds");

    assert!(
        local_import_cancellation(&run_id).is_none(),
        "a second registration of a live run id degrades to uncancellable"
    );

    drop(first);

    // Released with the guard, so the id is usable again. Otherwise a retried import of the
    // same file would be permanently uncancellable for the rest of the session.
    assert!(local_import_cancellation(&run_id).is_some());
}

#[test]
fn the_source_mode_deserializes_from_the_wire_spelling() {
    // The frontend has always sent these two literals; the enum has to accept exactly them, and
    // nothing else. An unrecognized mode must fail to deserialize rather than default to one.
    assert_eq!(
        serde_json::from_str::<MediaSourceMode>("\"local\"").unwrap(),
        MediaSourceMode::Local
    );
    assert_eq!(
        serde_json::from_str::<MediaSourceMode>("\"yt-dlp\"").unwrap(),
        MediaSourceMode::YtDlp
    );
    assert!(serde_json::from_str::<MediaSourceMode>("\"ytdlp\"").is_err());
    assert!(serde_json::from_str::<MediaSourceMode>("\"YtDlp\"").is_err());
}

// The registration half of a creation, driven end to end on a mock runtime.
//
// Everything above this point tests a pure decision. This block tests the *ordering* (the crash
// marker written after the artifacts and cleared only once the row has landed or their cleanup
// has run), which is the part of this module a mistake in costs a user their data, and which had
// no test at all. It could not have one: `AppHandle` alone is `AppHandle<Wry>`, so every
// function in the chain was unreachable from `tauri::test::mock_builder`'s `MockRuntime` app.
// Widening the chain to `R: Runtime` is what these assert against.
//
// Deliberately not covered here: the artifact *production* above it. That runs yt-dlp, FFmpeg
// and an HTTP fetch, none of which belongs in a unit test, and it is also the half where a
// failure is loud. The registration is the quiet one.
mod registration {
    use super::*;
    use crate::services::database::{get_app_settings_from_pool, set_app_settings_in_pool, Db};
    use crate::services::video_repository;
    use std::path::{Path, PathBuf};
    use tauri::test::{mock_builder, mock_context, noop_assets};
    use tauri::Manager;

    type MockApp = tauri::App<tauri::test::MockRuntime>;

    /// A mock app holding an in-memory database with the real schema and one channel, plus a
    /// library directory on disk whose path is persisted in settings.
    ///
    /// The library is real rather than mocked because the failure path unlinks from it: a
    /// cleanup that could not reach the library would report "unavailable" and the test would
    /// pass without proving anything was removed.
    /// `async` rather than blocking on the setup: these are `#[tokio::test]`s, so a
    /// `block_on` here starts a runtime from inside one and panics before any assertion runs.
    async fn app_with_library(label: &str) -> (MockApp, PathBuf) {
        let library = std::env::temp_dir().join(format!(
            "kavynex_mediareg_{label}_{}",
            crate::utils::naming::unique_temp_suffix()
        ));
        std::fs::create_dir_all(library.join(crate::constants::LIBRARY_DIR_VIDEO)).unwrap();

        let app = mock_builder().build(mock_context(noop_assets())).unwrap();

        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        crate::services::db_schema::ensure_schema(&pool)
            .await
            .unwrap();

        sqlx::query("INSERT INTO channels (id, name, youtube_handle) VALUES (1, 'C', '@c')")
            .execute(&pool)
            .await
            .unwrap();

        let mut settings = get_app_settings_from_pool(&pool).await.unwrap();
        settings.library_path = Some(library.to_string_lossy().to_string());
        set_app_settings_in_pool(&pool, &settings).await.unwrap();

        app.manage(Db::from_pool(pool));

        (app, library)
    }

    /// Writes a media file into the library and returns the artifacts naming it, exactly as the
    /// production step would have left them.
    fn artifacts_on_disk(library: &Path, name: &str) -> PreparedArtifacts {
        let relative = format!("{}/{name}", crate::constants::LIBRARY_DIR_VIDEO);
        std::fs::write(library.join(&relative), b"media bytes").unwrap();

        PreparedArtifacts {
            file_path: relative,
            thumbnail_path: None,
            media_type: "video".to_string(),
            youtube_video_id: None,
            published_at: None,
            is_live: false,
            live_chat_file_path: None,
        }
    }

    /// How many crash markers currently name `file_path`.
    ///
    /// Matched on the marker's contents rather than counted, because the cache directory is the
    /// real per-OS one: another test in this process (or a running app) has markers there too,
    /// and a bare count would make this assert about them.
    fn markers_naming(app: &MockApp, file_path: &str) -> usize {
        let dir = match app.path().app_cache_dir() {
            Ok(cache) => cache.join(crate::constants::TEMP_DIR_PENDING_MEDIA),
            Err(_) => return 0,
        };

        let Ok(entries) = std::fs::read_dir(&dir) else {
            return 0;
        };

        entries
            .flatten()
            .filter(|entry| {
                std::fs::read_to_string(entry.path())
                    .is_ok_and(|contents| contents.contains(file_path))
            })
            .count()
    }

    /// A media file on disk outside the library, named so the import accepts its extension.
    fn source_media_outside_the_library(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "kavynex_mediasrc_{label}_{}",
            crate::utils::naming::unique_temp_suffix()
        ));
        std::fs::create_dir_all(&dir).unwrap();

        let source = dir.join("clip.mp4");
        std::fs::write(&source, b"media bytes").unwrap();

        source
    }

    /// A local-import request against `library`, carrying an already-managed thumbnail path.
    ///
    /// The thumbnail matters: `classify_thumbnail_source` returns `Managed` for it and
    /// `store_thumbnail_source` hands it back untouched, so this drives the whole creation
    /// without reaching the FFmpeg preview. Leaving it absent would make the test pass or fail
    /// depending on whether the machine running it happens to have FFmpeg installed.
    fn local_request(library: &Path, source: &Path, label: &str) -> CreateMediaRequest {
        CreateMediaRequest {
            channel_id: 1,
            title: "An imported clip".to_string(),
            source_mode: MediaSourceMode::Local,
            source_value: source.to_string_lossy().to_string(),
            thumbnail_source_path: Some("thumbnails/thumb_abc.jpg".to_string()),
            media_type: "video".to_string(),
            import_mode: ImportMode::Copy,
            library_path: library.to_string_lossy().to_string(),
            published_at: None,
            // Unique per test: the id goes into the process-global download registry, and two
            // tests sharing one would make the second uncancellable for a reason unrelated to
            // what it asserts.
            yt_dlp_run_id: format!("run-{label}-{}", crate::utils::naming::unique_temp_suffix()),
            yt_dlp_format_id: String::new(),
            yt_dlp_youtube_video_id: None,
            download_live_chat: false,
            cookies_browser: None,
            cookies_path: None,
        }
    }

    /// How many rows the videos table holds, so a refusal can assert that nothing was inserted.
    async fn media_row_count(app: &MockApp) -> i64 {
        let pool = shared_pool(app.handle()).await.unwrap();
        let (count,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM videos")
            .fetch_one(&pool)
            .await
            .unwrap();
        count
    }

    // The three tests below are the first that drive `create_media_async` itself rather than
    // the half of it `register_prepared_media` covers. What they pin is the *sequence*: which
    // step runs before which, which is the property that has no other guard. Reaching them at
    // all took generalizing the chain from `AppHandle` (i.e. `AppHandle<Wry>`) to `R: Runtime`
    // down through binaries, the thumbnail tree and the yt-dlp tree, because the mock runtime
    // is a different concrete type and one bare `AppHandle` anywhere in the chain put the whole
    // thing out of reach.
    //
    // Only the local mode runs to completion here, and deliberately: the yt-dlp mode's
    // preparation spawns yt-dlp and FFmpeg, which does not belong in a unit test. Its ordering
    // is pinned from the other side, by a refusal that has to happen *before* that spawn.

    #[tokio::test]
    async fn a_local_import_runs_the_whole_creation_and_lands_a_row() {
        let (app, library) = app_with_library("create-local").await;
        let source = source_media_outside_the_library("create-local");

        let created = create_media_async(app.handle(), local_request(&library, &source, "local"))
            .await
            .expect("a local import of a real file must succeed");

        // The file landed content-addressed under video/, which is the import step having run.
        let expected_hash = crate::utils::hash::file_hash(&source).unwrap();
        assert_eq!(
            created.file_path,
            format!("video/media_{expected_hash}.mp4")
        );
        assert!(library.join(&created.file_path).is_file());

        // Copy mode, so the source survives.
        assert!(source.is_file());

        // The supplied managed thumbnail was carried through rather than re-persisted.
        assert_eq!(
            created.thumbnail_path.as_deref(),
            Some("thumbnails/thumb_abc.jpg")
        );

        // The registration step ran to the end: a row exists and its marker is gone.
        let pool = shared_pool(app.handle()).await.unwrap();
        let row =
            video_repository::find_media_by_channel_and_file_path(&pool, 1, &created.file_path)
                .await
                .unwrap();
        assert!(row.is_some(), "the creation must have inserted a row");
        assert_eq!(markers_naming(&app, &created.file_path), 0);

        let _ = std::fs::remove_dir_all(&library);
        let _ = std::fs::remove_dir_all(source.parent().unwrap());
    }

    #[tokio::test]
    async fn an_invalid_request_is_refused_before_the_source_file_is_consumed() {
        // Normalization runs first, and a `move` import is what makes that observable rather
        // than merely tidy: the import removes the user's original once it is in the library,
        // so a request validated only at the write boundary would consume the source, fail the
        // insert, and have the cleanup unlink the library copy. The user's file would be gone
        // and no row would exist.
        //
        // The surviving source is therefore the assertion, and it is the one that discriminates.
        // Asserting an empty video/ directory does not: the failure path unlinks the imported
        // file either way, so that check passes whether the refusal came before the import or
        // after it. Verified by neutralizing `ensure_valid_media_title` and watching this test
        // keep passing on that assertion alone, which is why it is not the one relied on here.
        let (app, library) = app_with_library("create-invalid").await;
        let source = source_media_outside_the_library("create-invalid");

        let mut request = local_request(&library, &source, "invalid");
        request.title = "   ".to_string();
        request.import_mode = ImportMode::Move;

        let error = create_media_async(app.handle(), request)
            .await
            .expect_err("a blank title must be refused");

        assert_eq!(error.code, AppErrorCode::InvalidMediaTitle.as_str());
        assert!(
            source.is_file(),
            "the refusal must land before the import, or a move consumes the user's file"
        );
        assert_eq!(media_row_count(&app).await, 0);

        let _ = std::fs::remove_dir_all(&library);
        let _ = std::fs::remove_dir_all(source.parent().unwrap());
    }

    #[tokio::test]
    async fn an_already_registered_youtube_video_is_refused_before_the_download_starts() {
        // The ordering that saves a gigabyte. `needs_youtube_duplicate_pre_check` gates a query
        // that runs *before* `prepare_yt_dlp_artifacts`, so a video already registered for this
        // channel fails now rather than after the whole file has been fetched.
        //
        // It is also why the yt-dlp mode is drivable here at all: the refusal lands before
        // anything spawns. If the two steps were ever reordered this test would not merely
        // fail, it would try to run yt-dlp, which is the loud kind of failure.
        let (app, library) = app_with_library("create-duplicate").await;

        let pool = shared_pool(app.handle()).await.unwrap();
        video_repository::insert_media(
            &pool,
            1,
            "Already saved",
            "video/media_existing.mp4",
            None,
            "video",
            Some("dQw4w9WgXcQ"),
            None,
            None,
            false,
            None,
        )
        .await
        .unwrap();

        let request = CreateMediaRequest {
            source_mode: MediaSourceMode::YtDlp,
            source_value: "https://www.youtube.com/watch?v=dQw4w9WgXcQ".to_string(),
            yt_dlp_format_id: "137+140".to_string(),
            yt_dlp_youtube_video_id: Some("dQw4w9WgXcQ".to_string()),
            thumbnail_source_path: None,
            ..local_request(&library, Path::new("unused"), "duplicate")
        };

        let error = create_media_async(app.handle(), request)
            .await
            .expect_err("a video already registered for the channel must be refused");

        assert_eq!(
            error.code,
            AppErrorCode::VideoAlreadyExistsForChannel.as_str()
        );

        // Nothing beyond the pre-existing row, and nothing on disk: the refusal landed before
        // the preparation, which is the whole claim.
        assert_eq!(media_row_count(&app).await, 1);
        assert_eq!(
            std::fs::read_dir(library.join(crate::constants::LIBRARY_DIR_VIDEO))
                .unwrap()
                .count(),
            0
        );

        let _ = std::fs::remove_dir_all(&library);
    }

    #[tokio::test]
    async fn a_registered_media_lands_as_a_row_and_leaves_no_marker_behind() {
        // The happy path's whole contract in one place: the row exists afterwards, and the
        // marker that described the window before it does not. A marker left behind is not
        // cosmetic. The startup sweep reads it and hands its paths to a cleanup that unlinks
        // files, so a creation that succeeded but failed to clear its marker is a video the next
        // launch may delete.
        let (app, library) = app_with_library("registered").await;
        let prepared = artifacts_on_disk(&library, "media_ok.mp4");
        let file_path = prepared.file_path.clone();

        let created =
            register_prepared_media(app.handle(), &request(MediaSourceMode::Local), prepared)
                .await
                .expect("a valid registration should succeed");

        assert_eq!(created.file_path, file_path);
        assert!(created.id > 0);

        let pool = crate::services::database::shared_pool(app.handle())
            .await
            .unwrap();
        assert!(
            video_repository::find_media_by_channel_and_file_path(&pool, 1, &file_path)
                .await
                .unwrap()
                .is_some(),
            "the row the artifacts were registered as must exist"
        );

        assert_eq!(
            markers_naming(&app, &file_path),
            0,
            "a creation that reached its row must not leave a crash marker behind"
        );
        assert!(
            library.join(&file_path).exists(),
            "a successful registration must not touch the artifacts"
        );

        let _ = std::fs::remove_dir_all(&library);
    }

    #[tokio::test]
    async fn a_registration_whose_media_file_vanished_is_refused_rather_than_inserted() {
        // The window this covers is the one the lock structurally cannot. The artifacts land
        // *before* register_prepared_media takes MEDIA_REGISTRATION_LOCK, so a delete that
        // unlinks a content-addressed file this creation is adopting is not excluded by that
        // lock, and closing it there would mean holding the lock across a download. Removing
        // the file here is exactly what such a delete leaves behind.
        //
        // What must not happen is the insert going through regardless. A row pointing at a
        // file that is gone stays invisible until playback fails, and Diagnostics can only
        // report it as missing with nothing left to reconcile it against. A refusal is
        // recoverable: the user adds the media again.
        let (app, library) = app_with_library("vanished").await;
        let prepared = artifacts_on_disk(&library, "media_vanished.mp4");
        let file_path = prepared.file_path.clone();

        std::fs::remove_file(library.join(&file_path)).unwrap();

        let error =
            register_prepared_media(app.handle(), &request(MediaSourceMode::Local), prepared)
                .await
                .expect_err("a media file that is gone must not be registered");

        assert_eq!(error.code, AppErrorCode::MediaFileNotFound.as_str());

        let pool = crate::services::database::shared_pool(app.handle())
            .await
            .unwrap();
        assert!(
            video_repository::find_media_by_channel_and_file_path(&pool, 1, &file_path)
                .await
                .unwrap()
                .is_none(),
            "no row may be left pointing at a media file that is not there"
        );

        assert_eq!(
            markers_naming(&app, &file_path),
            0,
            "a refused registration must not leave a crash marker behind"
        );

        let _ = std::fs::remove_dir_all(&library);
    }

    #[tokio::test]
    async fn a_refused_duplicate_keeps_the_file_the_existing_row_points_at() {
        // A refused registration cleans up "its" artifacts, and this pins what that must not
        // mean. The artifacts are content-addressed, so the duplicate the insert refuses
        // resolves to the *same file* the row already there points at, and the cleanup is
        // reference-counted precisely so it keeps that one. Deleting it would take the existing
        // media's file away as a side effect of refusing to add it twice, which is the worst
        // outcome available on this path: an error the user shrugs off, and a video gone.
        let (app, library) = app_with_library("duplicate").await;
        let prepared = artifacts_on_disk(&library, "media_dup.mp4");
        let file_path = prepared.file_path.clone();

        let pool = crate::services::database::shared_pool(app.handle())
            .await
            .unwrap();
        video_repository::insert_media(
            &pool,
            1,
            "Already there",
            &file_path,
            None,
            "video",
            None,
            None,
            None,
            false,
            None,
        )
        .await
        .unwrap();

        let error =
            register_prepared_media(app.handle(), &request(MediaSourceMode::Local), prepared)
                .await
                .expect_err("a file path this channel already holds must be refused");

        assert_eq!(
            error.code,
            AppErrorCode::VideoAlreadyExistsForChannel.as_str()
        );
        assert!(
            library.join(&file_path).exists(),
            "the file the registered row points at must survive the refusal"
        );
        assert_eq!(
            markers_naming(&app, &file_path),
            0,
            "the marker must be cleared once the cleanup it covered has run"
        );

        let _ = std::fs::remove_dir_all(&library);
    }

    #[tokio::test]
    async fn a_registration_that_cannot_insert_removes_the_artifacts_nothing_references() {
        // The other half of the failure path: an insert that fails with no row anywhere pointing
        // at the file, so the reference count really is zero and the artifacts have to go. The
        // channel is gone (deleted while the download ran, which is how this happens in
        // practice), so the insert fails on the foreign key.
        //
        // All three consequences are asserted together because any one alone can pass while the
        // ordering is wrong: the error reaches the caller, the unreferenced file is gone, and
        // the marker is cleared. The marker last, because until the cleanup has run it is the
        // only record of what is on disk.
        let (app, library) = app_with_library("orphaned").await;
        let prepared = artifacts_on_disk(&library, "media_orphan.mp4");
        let file_path = prepared.file_path.clone();

        let missing_channel = CreateMediaRequest {
            channel_id: 4242,
            ..request(MediaSourceMode::Local)
        };

        register_prepared_media(app.handle(), &missing_channel, prepared)
            .await
            .expect_err("an insert against a channel that does not exist must fail");

        assert!(
            !library.join(&file_path).exists(),
            "artifacts no row references must not be left in the library"
        );
        assert_eq!(
            markers_naming(&app, &file_path),
            0,
            "the marker must be cleared once the cleanup it covered has run"
        );

        let _ = std::fs::remove_dir_all(&library);
    }

    #[tokio::test]
    async fn a_path_outside_the_managed_layout_is_refused_before_a_marker_exists() {
        // `ensure_managed_prepared_paths` runs before the lock and before the marker, and that
        // order is the point: a marker naming a path the layout does not own would hand the
        // startup sweep something to reconcile that this run should never have produced. So the
        // refusal has to leave nothing at all behind, not merely fail.
        let (app, library) = app_with_library("escaped").await;
        let prepared = PreparedArtifacts {
            file_path: "../outside/media_escape.mp4".to_string(),
            media_type: "video".to_string(),
            ..PreparedArtifacts::default()
        };

        let error =
            register_prepared_media(app.handle(), &request(MediaSourceMode::Local), prepared)
                .await
                .expect_err("a path outside the managed layout must be refused");

        assert_eq!(
            markers_naming(&app, "media_escape.mp4"),
            0,
            "nothing may be recorded for a request refused before the marker is written"
        );
        assert!(!error.code.is_empty());

        let _ = std::fs::remove_dir_all(&library);
    }
}
