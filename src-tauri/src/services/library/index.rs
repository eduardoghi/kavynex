//! A plain-text index of the library, written into the library folder.
//!
//! The files there are named after their content (`media_<sha256>.mp4`), which says nothing about
//! what each one is, and the titles and channels live only in the database, in another folder. If
//! the database and its backups are lost, this file is what still tells which file is which video.
//! It is regenerated from the database by the periodic backup loop (`lib.rs`), shortly after launch
//! and then every few hours, and rewritten only when what it lists changed. It is never read back.

use std::collections::HashMap;
use std::path::Path;

use serde::Serialize;
use sqlx::SqlitePool;

use crate::services::channel_repository::{list_channels, ChannelRow};
use crate::services::video_repository::{list_media_for_library_index, LibraryIndexMediaRow};
use crate::AppResult;

/// The index's name in the library folder. A library move removes the old folder's copy
/// (`library::migration`), and the next refresh writes it in the new one.
pub(crate) const LIBRARY_INDEX_FILE: &str = "kavynex-library-index.json";

const ABOUT: &str = "Written by Kavynex so the files in this folder can be identified without its \
database. Each file path is relative to this folder. Kavynex rewrites this file on its own, so \
editing it changes nothing.";

#[derive(Serialize)]
struct LibraryIndex<'a> {
    about: &'static str,
    channels: Vec<IndexedChannel<'a>>,
}

#[derive(Serialize)]
struct IndexedChannel<'a> {
    name: &'a str,
    youtube_handle: &'a str,
    media: Vec<IndexedMedia<'a>>,
}

#[derive(Serialize)]
struct IndexedMedia<'a> {
    title: &'a str,
    file: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    thumbnail: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    live_chat: Option<&'a str>,
    media_type: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    youtube_video_id: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    published_at: Option<&'a str>,
}

/// The index's bytes, channels in the order given and each channel's media in the order given.
/// A media whose channel is not among `channels` cannot happen (the foreign key), and is left out.
fn render_library_index(channels: &[ChannelRow], media: &[LibraryIndexMediaRow]) -> Vec<u8> {
    let mut by_channel: HashMap<i64, Vec<IndexedMedia<'_>>> = HashMap::new();

    for row in media {
        by_channel
            .entry(row.channel_id)
            .or_default()
            .push(IndexedMedia {
                title: &row.title,
                file: &row.file_path,
                thumbnail: row.thumbnail_path.as_deref(),
                live_chat: row.live_chat_file_path.as_deref(),
                media_type: &row.media_type,
                youtube_video_id: row.youtube_video_id.as_deref(),
                published_at: row.published_at.as_deref(),
            });
    }

    let index = LibraryIndex {
        about: ABOUT,
        channels: channels
            .iter()
            .map(|channel| IndexedChannel {
                name: &channel.name,
                youtube_handle: &channel.youtube_handle,
                media: by_channel.remove(&channel.id).unwrap_or_default(),
            })
            .collect(),
    };

    let mut bytes = serde_json::to_vec_pretty(&index).unwrap_or_default();
    bytes.push(b'\n');
    bytes
}

/// Writes `contents` as the index in `library_dir`, unless the file there already holds exactly
/// that. Returns whether it wrote.
fn write_if_changed(library_dir: &Path, contents: &[u8]) -> std::io::Result<bool> {
    let path = library_dir.join(LIBRARY_INDEX_FILE);

    if std::fs::read(&path).is_ok_and(|current| current == contents) {
        return Ok(false);
    }

    crate::services::filesystem::write_file_durably(&path, contents)?;
    Ok(true)
}

/// Rewrites the index in `library_dir` from the database. Returns whether the file changed.
pub(crate) async fn refresh_library_index(
    pool: &SqlitePool,
    library_dir: &Path,
) -> AppResult<bool> {
    let channels = list_channels(pool).await?;
    let media = list_media_for_library_index(pool).await?;
    let contents = render_library_index(&channels, &media);
    let library_dir = library_dir.to_path_buf();

    crate::utils::task::run_blocking(move || {
        // Serialized against a library move, which would otherwise carry the folder away mid-write.
        let _library_guard = crate::services::library::lock::library_read_guard();

        write_if_changed(&library_dir, &contents).map_err(|error| {
            crate::AppError::fs_error(
                crate::AppErrorCode::AppError,
                "failed to write the library index",
                library_dir.join(LIBRARY_INDEX_FILE),
                &error,
            )
        })
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn channel(id: i64, name: &str) -> ChannelRow {
        ChannelRow {
            id,
            name: name.to_string(),
            youtube_handle: format!("@{}", name.to_lowercase()),
            avatar_path: None,
            banner_path: None,
            created_at: String::new(),
        }
    }

    fn media(channel_id: i64, title: &str, file: &str) -> LibraryIndexMediaRow {
        LibraryIndexMediaRow {
            channel_id,
            title: title.to_string(),
            file_path: file.to_string(),
            thumbnail_path: None,
            live_chat_file_path: None,
            media_type: "video".to_string(),
            youtube_video_id: Some("dQw4w9WgXcQ".to_string()),
            published_at: Some("2026-01-02".to_string()),
        }
    }

    #[test]
    fn lists_each_channel_with_its_media_in_the_order_given() {
        let channels = [channel(1, "Alpha"), channel(2, "Beta"), channel(3, "Empty")];
        let rows = [
            media(2, "B one", "video/media_b1.mp4"),
            media(1, "A one", "video/media_a1.mp4"),
            media(2, "B two", "audio/media_b2.m4a"),
        ];

        let index: serde_json::Value =
            serde_json::from_slice(&render_library_index(&channels, &rows)).unwrap();
        let channels = index["channels"].as_array().unwrap();

        assert_eq!(index["about"], ABOUT);
        assert_eq!(channels.len(), 3);
        assert_eq!(channels[0]["name"], "Alpha");
        assert_eq!(channels[0]["media"][0]["file"], "video/media_a1.mp4");
        assert_eq!(channels[1]["media"][0]["title"], "B one");
        assert_eq!(channels[1]["media"][1]["file"], "audio/media_b2.m4a");
        assert_eq!(channels[2]["media"].as_array().unwrap().len(), 0);
        // An absent thumbnail or live chat is left out rather than written as null.
        assert!(channels[0]["media"][0].get("thumbnail").is_none());
    }

    #[test]
    fn writes_only_when_the_contents_changed() {
        let dir = crate::test_support::unique_temp_path("library-index");
        std::fs::create_dir_all(&dir).unwrap();

        assert!(write_if_changed(&dir, b"one").unwrap());
        assert!(!write_if_changed(&dir, b"one").unwrap());
        assert!(write_if_changed(&dir, b"two").unwrap());
        assert_eq!(std::fs::read(dir.join(LIBRARY_INDEX_FILE)).unwrap(), b"two");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn refreshes_the_index_from_the_database() {
        let pool = crate::test_support::memory_pool().await;
        sqlx::query(
            "INSERT INTO channels (id, name, youtube_handle) VALUES (1, 'Alpha', '@alpha')",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO videos (channel_id, title, title_normalized, file_path, media_type) \
             VALUES (1, 'A one', 'a one', 'video/media_a1.mp4', 'video')",
        )
        .execute(&pool)
        .await
        .unwrap();
        let dir = crate::test_support::unique_temp_path("library-index-refresh");
        std::fs::create_dir_all(&dir).unwrap();

        assert!(refresh_library_index(&pool, &dir).await.unwrap());
        assert!(!refresh_library_index(&pool, &dir).await.unwrap());

        let index: serde_json::Value =
            serde_json::from_slice(&std::fs::read(dir.join(LIBRARY_INDEX_FILE)).unwrap()).unwrap();
        assert_eq!(index["channels"][0]["media"][0]["title"], "A one");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
