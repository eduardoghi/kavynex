//! Listing what a channel has on YouTube, to show the media its library entry does not have yet.
//!
//! Nothing is downloaded. Each tab (the videos, the past lives) is one `--flat-playlist` run that
//! prints the list as JSON, and the comparison with the library is by YouTube video id. Shorts are
//! not listed. The user imports what they want from the list through the usual add-media flow, one
//! media at a time, so the format is still theirs to pick and YouTube sees no burst of downloads.

use std::collections::HashSet;

use sqlx::SqlitePool;
use tauri::{AppHandle, Runtime};

use super::metadata::{
    is_valid_youtube_video_id, optional_cancellable_run, run_yt_dlp_and_capture_json,
};
use crate::models::yt_dlp::{
    ChannelMediaOnYoutube, ChannelTabKind, MissingChannelMedia, YtDlpChannelTab,
    YtDlpChannelTabEntry,
};
use crate::services::binaries::resolve_yt_dlp_binary_async;
use crate::{AppError, AppErrorCode, AppResult};

/// A large channel's tab is paged through on YouTube's side, a few thousand entries in a few dozen
/// requests, so this is longer than one video's metadata run.
const CHANNEL_LISTING_TIMEOUT_SECS: u64 = 180;

/// The tabs listed, in the order they are read.
const LISTED_TABS: [ChannelTabKind; 2] = [ChannelTabKind::Video, ChannelTabKind::Live];

/// The channel's page without a tab, query or trailing slash, so a stored handle that is a pasted
/// link to one of its tabs still gets the tab asked for. A suffix is taken off only when what is left
/// still names a channel, so a legacy channel whose name is a tab's (`/c/videos`, `/user/live`)
/// keeps it.
fn channel_root(channel_url: &str) -> &str {
    let without_query = channel_url.split(['?', '#']).next().unwrap_or_default();
    let trimmed = without_query.trim_end_matches('/');

    [
        "/videos",
        "/streams",
        "/shorts",
        "/featured",
        "/live",
        "/playlists",
    ]
    .iter()
    .find_map(|tab| {
        let root = trimmed.strip_suffix(tab)?;
        let last_segment = root.rsplit('/').next().unwrap_or_default();
        // Left a bare `/c`, `/user` or `/channel`, or only the host, the suffix was the name.
        let names_a_channel = !last_segment.is_empty()
            && !last_segment.contains('.')
            && !matches!(last_segment, "c" | "user" | "channel");

        names_a_channel.then_some(root)
    })
    .unwrap_or(trimmed)
}

/// The URL of one tab of the channel at `channel_url`.
pub(crate) fn tab_url(channel_url: &str, kind: ChannelTabKind) -> String {
    let tab = match kind {
        ChannelTabKind::Video => "videos",
        ChannelTabKind::Live => "streams",
    };

    format!("{}/{tab}", channel_root(channel_url))
}

/// The yt-dlp arguments that print one tab as a flat list. `approximate_date` gives each entry the
/// date the tab shows ("3 weeks ago"), which a flat list otherwise leaves out.
fn listing_args(url: &str) -> Vec<String> {
    let mut args = super::metadata::base_json_args();
    args.extend(
        [
            "-v",
            "--flat-playlist",
            "--extractor-args",
            "youtubetab:approximate_date",
            "--",
            url,
        ]
        .map(String::from),
    );
    args
}

/// Whether a failed listing was the channel not having that tab at all, which yt-dlp reports as an
/// error ("This channel does not have a streams tab") and which means the tab is empty.
fn is_missing_tab(error: &AppError) -> bool {
    error
        .details
        .as_deref()
        .is_some_and(|details| details.contains("does not have a") && details.contains(" tab"))
}

/// The media of every tab that could be listed. A tab the channel does not have is empty. A tab that
/// failed otherwise is left out with a warning in the log, so one tab yt-dlp could not read (a
/// changed error message, a timeout) does not take the whole list with it. The listing fails only
/// when no tab could be listed, or when it was cancelled.
pub(crate) fn combine_tab_listings(
    results: Vec<(ChannelTabKind, AppResult<Vec<ChannelMediaOnYoutube>>)>,
) -> AppResult<Vec<ChannelMediaOnYoutube>> {
    let mut listed = Vec::new();
    let mut any_listed = false;
    let mut first_error = None;

    for (kind, result) in results {
        match result {
            Ok(media) => {
                any_listed = true;
                listed.extend(media);
            }
            Err(error) if is_missing_tab(&error) => any_listed = true,
            Err(error) if error.code == AppErrorCode::YtDlpDownloadCancelled.as_str() => {
                return Err(error);
            }
            Err(error) => {
                crate::services::logger::warn(
                    "yt_dlp",
                    format!("channel listing: the {kind:?} tab could not be listed: {error}"),
                );
                first_error.get_or_insert(error);
            }
        }
    }

    match first_error {
        Some(error) if !any_listed => Err(error),
        _ => Ok(listed),
    }
}

/// The media of one tab's JSON. An entry without a valid video id, or one that cannot be imported
/// yet (a live still running, one only scheduled), is left out, as is one whose shape is off.
pub(crate) fn parse_channel_tab(
    json: &str,
    kind: ChannelTabKind,
) -> AppResult<Vec<ChannelMediaOnYoutube>> {
    let tab: YtDlpChannelTab = serde_json::from_str(json).map_err(|error| {
        AppError::from_code_with_details(
            AppErrorCode::YtDlpMetadataParseFailed,
            "yt-dlp returned a channel listing that could not be read.",
            format!("channel listing parse failed: {error}"),
        )
    })?;

    Ok(tab
        .entries
        .into_iter()
        .filter_map(|value| serde_json::from_value::<YtDlpChannelTabEntry>(value).ok())
        .filter_map(|entry| media_from_entry(entry, kind))
        .collect())
}

fn media_from_entry(
    entry: YtDlpChannelTabEntry,
    kind: ChannelTabKind,
) -> Option<ChannelMediaOnYoutube> {
    let youtube_video_id = entry.id?.trim().to_string();

    if !is_valid_youtube_video_id(&youtube_video_id) {
        return None;
    }

    if matches!(
        entry.live_status.as_deref(),
        Some("is_live" | "is_upcoming")
    ) {
        return None;
    }

    let title = entry
        .title
        .map(|title| title.trim().to_string())
        .filter(|title| !title.is_empty())
        .unwrap_or_else(|| youtube_video_id.clone());

    Some(ChannelMediaOnYoutube {
        youtube_video_id,
        title,
        kind,
        duration_seconds: entry
            .duration
            .filter(|seconds| *seconds >= 0.0)
            .map(|seconds| seconds.round() as i64),
        published_at: entry.timestamp,
    })
}

/// What `listed` has that `in_library` does not, newest first, with the ones in `ignored` apart. A
/// media listed on both tabs counts once, under the first. An ignored media the library holds after
/// all is in neither list.
pub(crate) fn missing_from_library(
    listed: Vec<ChannelMediaOnYoutube>,
    in_library: &HashSet<String>,
    ignored: &HashSet<String>,
) -> MissingChannelMedia {
    let mut seen = HashSet::new();
    let unique: Vec<ChannelMediaOnYoutube> = listed
        .into_iter()
        .filter(|media| seen.insert(media.youtube_video_id.clone()))
        .collect();
    let listed_count = u32::try_from(unique.len()).unwrap_or(u32::MAX);

    let mut missing: Vec<ChannelMediaOnYoutube> = unique
        .into_iter()
        .filter(|media| !in_library.contains(&media.youtube_video_id))
        .collect();
    // Newest first. A media with no date sorts last, and a stable sort keeps the tab's own order
    // among those and among equal dates.
    missing.sort_by_key(|media| std::cmp::Reverse(media.published_at));
    let (ignored, missing): (Vec<_>, Vec<_>) = missing
        .into_iter()
        .partition(|media| ignored.contains(&media.youtube_video_id));

    MissingChannelMedia {
        missing,
        ignored,
        listed: listed_count,
    }
}

/// Lists the videos and past lives of the channel `channel_id` on YouTube and returns the ones the
/// library does not hold for it. `run_id` registers the listing so `cancel_media_download` can
/// stop it, the way a format probe is.
pub async fn list_channel_missing_media_async<R: Runtime>(
    app: &AppHandle<R>,
    pool: &SqlitePool,
    channel_id: i64,
    run_id: Option<&str>,
) -> AppResult<MissingChannelMedia> {
    // Before anything awaits, so a cancel sent right after the listing starts finds it.
    let (cancel_flag, _run_release_guard) = optional_cancellable_run(run_id)?;

    let channel = crate::services::channel_repository::get_channel_by_id(pool, channel_id)
        .await?
        .ok_or_else(|| AppError::from_code(AppErrorCode::ChannelNotFound, "channel not found"))?;
    // The handle as the database holds it, not one the renderer sends, and through the same
    // YouTube-only gate the avatar and banner lookups use.
    let channel_url = crate::services::thumbnail::download::normalize_channel_handle_to_url(
        &channel.youtube_handle,
    )?;
    let yt_dlp = resolve_yt_dlp_binary_async(app).await?;

    let mut results = Vec::new();

    for kind in LISTED_TABS {
        let args = listing_args(&tab_url(&channel_url, kind));
        let run = run_yt_dlp_and_capture_json(
            &yt_dlp,
            &args,
            CHANNEL_LISTING_TIMEOUT_SECS,
            AppErrorCode::YtDlpMetadataTimeout,
            AppErrorCode::YtDlpMetadataExecFailed,
            AppErrorCode::YtDlpMetadataFailed,
            "yt-dlp channel listing timed out",
            "failed to execute yt-dlp for the channel listing",
            "yt-dlp could not list this channel's media.",
            cancel_flag.clone(),
        )
        .await;

        let cancelled = run
            .as_ref()
            .is_err_and(|error| error.code == AppErrorCode::YtDlpDownloadCancelled.as_str());
        results.push((
            kind,
            run.and_then(|(json, _stdout_logs, _stderr_logs)| parse_channel_tab(&json, kind)),
        ));

        // A cancel stops the listing here rather than starting the next tab.
        if cancelled {
            break;
        }
    }

    let listed = combine_tab_listings(results)?;

    let in_library =
        crate::services::video_repository::list_channel_youtube_video_ids(pool, channel_id).await?;
    let ignored =
        crate::services::channel_repository::list_ignored_channel_media_ids(pool, channel_id)
            .await?;

    Ok(missing_from_library(listed, &in_library, &ignored))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn media(id: &str, published_at: Option<i64>) -> ChannelMediaOnYoutube {
        ChannelMediaOnYoutube {
            youtube_video_id: id.to_string(),
            title: id.to_string(),
            kind: ChannelTabKind::Video,
            duration_seconds: None,
            published_at,
        }
    }

    #[test]
    fn a_tab_url_is_built_from_the_channel_page_whatever_tab_the_handle_named() {
        assert_eq!(
            tab_url("https://www.youtube.com/@chan", ChannelTabKind::Video),
            "https://www.youtube.com/@chan/videos"
        );
        assert_eq!(
            tab_url(
                "https://www.youtube.com/@chan/videos/",
                ChannelTabKind::Live
            ),
            "https://www.youtube.com/@chan/streams"
        );
        assert_eq!(
            tab_url(
                "https://www.youtube.com/channel/UCx/featured?x=1",
                ChannelTabKind::Video
            ),
            "https://www.youtube.com/channel/UCx/videos"
        );
    }

    #[test]
    fn a_legacy_channel_named_like_a_tab_keeps_its_name() {
        assert_eq!(
            tab_url("https://www.youtube.com/c/videos", ChannelTabKind::Live),
            "https://www.youtube.com/c/videos/streams"
        );
        assert_eq!(
            tab_url("https://www.youtube.com/user/live/", ChannelTabKind::Video),
            "https://www.youtube.com/user/live/videos"
        );
        // The same name followed by a tab still loses only the tab.
        assert_eq!(
            tab_url(
                "https://www.youtube.com/c/videos/videos",
                ChannelTabKind::Live
            ),
            "https://www.youtube.com/c/videos/streams"
        );
    }

    #[test]
    fn the_listing_asks_for_a_flat_list_with_dates_and_the_url_last() {
        let args = listing_args("https://www.youtube.com/@chan/videos");

        assert!(args.contains(&"--flat-playlist".to_string()));
        assert!(args.contains(&"youtubetab:approximate_date".to_string()));
        assert!(!args.contains(&"--no-playlist".to_string()));
        assert_eq!(args[args.len() - 2], "--");
        assert_eq!(args.last().unwrap(), "https://www.youtube.com/@chan/videos");
    }

    #[test]
    fn a_tab_is_read_leniently_and_leaves_out_what_cannot_be_imported() {
        let json = serde_json::json!({
            "_type": "playlist",
            "entries": [
                { "id": "aaaaaaaaaaa", "title": " First ", "duration": 61.6, "timestamp": 1700000000 },
                { "id": "bbbbbbbbbbb", "title": "Live now", "live_status": "is_live" },
                { "id": "ccccccccccc", "title": "Soon", "live_status": "is_upcoming" },
                { "id": "not-an-id", "title": "Odd" },
                { "id": "ddddddddddd", "title": "", "duration": "n/a", "timestamp": "x" },
                "not an object",
                { "id": "eeeeeeeeeee", "title": "Was live", "live_status": "was_live" }
            ]
        })
        .to_string();

        let parsed = parse_channel_tab(&json, ChannelTabKind::Live).unwrap();

        assert_eq!(
            parsed,
            vec![
                ChannelMediaOnYoutube {
                    youtube_video_id: "aaaaaaaaaaa".to_string(),
                    title: "First".to_string(),
                    kind: ChannelTabKind::Live,
                    duration_seconds: Some(62),
                    published_at: Some(1_700_000_000),
                },
                ChannelMediaOnYoutube {
                    youtube_video_id: "ddddddddddd".to_string(),
                    title: "ddddddddddd".to_string(),
                    kind: ChannelTabKind::Live,
                    duration_seconds: None,
                    published_at: None,
                },
                ChannelMediaOnYoutube {
                    youtube_video_id: "eeeeeeeeeee".to_string(),
                    title: "Was live".to_string(),
                    kind: ChannelTabKind::Live,
                    duration_seconds: None,
                    published_at: None,
                },
            ]
        );
    }

    #[test]
    fn a_listing_that_is_not_json_is_an_error() {
        assert!(parse_channel_tab("null", ChannelTabKind::Video).is_err());
        assert!(parse_channel_tab("{", ChannelTabKind::Video).is_err());
    }

    #[test]
    fn what_is_missing_leaves_out_the_library_counts_each_media_once_and_puts_the_newest_first() {
        let listed = vec![
            media("aaaaaaaaaaa", Some(10)),
            media("bbbbbbbbbbb", None),
            media("ccccccccccc", Some(30)),
            media("aaaaaaaaaaa", Some(10)),
            media("ddddddddddd", Some(20)),
        ];
        let in_library = HashSet::from(["ddddddddddd".to_string()]);
        let ignored = HashSet::from(["aaaaaaaaaaa".to_string(), "ddddddddddd".to_string()]);

        let result = missing_from_library(listed, &in_library, &ignored);

        assert_eq!(result.listed, 4);
        let ids = |list: &[ChannelMediaOnYoutube]| -> Vec<String> {
            list.iter()
                .map(|media| media.youtube_video_id.clone())
                .collect()
        };
        assert_eq!(ids(&result.missing), ["ccccccccccc", "bbbbbbbbbbb"]);
        // Ignored and missing, so set apart. The ignored one the library holds is in neither.
        assert_eq!(ids(&result.ignored), ["aaaaaaaaaaa"]);
    }

    #[test]
    fn a_channel_without_the_tab_reads_as_an_empty_tab() {
        let missing = AppError::from_code_with_details(
            AppErrorCode::YtDlpMetadataFailed,
            "yt-dlp could not list this channel's media.",
            "yt-dlp could not list this channel's media.: ERROR: [youtube:tab] @chan: This channel does not have a streams tab",
        );
        let other = AppError::from_code_with_details(
            AppErrorCode::YtDlpMetadataFailed,
            "yt-dlp could not list this channel's media.",
            "yt-dlp could not list this channel's media.: ERROR: HTTP Error 429",
        );

        assert!(is_missing_tab(&missing));
        assert!(!is_missing_tab(&other));
    }

    fn tab_error(details: &str) -> AppError {
        AppError::from_code_with_details(
            AppErrorCode::YtDlpMetadataFailed,
            "yt-dlp could not list this channel's media.",
            details,
        )
    }

    #[test]
    fn a_tab_that_fails_is_left_out_when_another_was_listed() {
        // An error the missing-tab check does not recognize (a reworded message, a timeout) on
        // the lives tab keeps the videos instead of failing the whole list.
        let listed = combine_tab_listings(vec![
            (ChannelTabKind::Video, Ok(vec![media("aaaaaaaaaaa", None)])),
            (ChannelTabKind::Live, Err(tab_error("ERROR: something new"))),
        ])
        .unwrap();

        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].youtube_video_id, "aaaaaaaaaaa");
    }

    #[test]
    fn the_listing_fails_only_when_no_tab_was_listed() {
        let error = combine_tab_listings(vec![
            (
                ChannelTabKind::Video,
                Err(tab_error("ERROR: HTTP Error 429")),
            ),
            (
                ChannelTabKind::Live,
                Err(tab_error("ERROR: HTTP Error 429")),
            ),
        ])
        .unwrap_err();
        assert_eq!(error.code, AppErrorCode::YtDlpMetadataFailed.as_str());

        // A tab the channel does not have counts as listed, so the other one failing is not all.
        let listed = combine_tab_listings(vec![
            (
                ChannelTabKind::Video,
                Err(tab_error("ERROR: HTTP Error 429")),
            ),
            (
                ChannelTabKind::Live,
                Err(tab_error("ERROR: This channel does not have a streams tab")),
            ),
        ])
        .unwrap();
        assert!(listed.is_empty());
    }

    #[test]
    fn a_cancelled_listing_stays_cancelled() {
        let cancelled = AppError::from_code(
            AppErrorCode::YtDlpDownloadCancelled,
            "yt-dlp download cancelled",
        );

        let error = combine_tab_listings(vec![
            (ChannelTabKind::Video, Ok(vec![media("aaaaaaaaaaa", None)])),
            (ChannelTabKind::Live, Err(cancelled)),
        ])
        .unwrap_err();

        assert_eq!(error.code, AppErrorCode::YtDlpDownloadCancelled.as_str());
    }
}
