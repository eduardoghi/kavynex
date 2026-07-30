// Service modules, grouped into a directory per feature family once a family outgrew a flat
// prefix. `library_*`, `thumbnail_*` and `yt_dlp_*` were nine, six and seven sibling files whose
// shared prefix was already naming a directory; making it one applies the same rule
// docs/ARCHITECTURE.md states for a file that outgrows itself (db_backup/, db_schema/,
// video_repository/, yt_dlp/download/) to a *concept* that outgrows itself. Within a family,
// siblings reach each other through `super::`, matching those existing directories.
pub mod binaries;
pub mod channel_repository;
pub mod cleanup;
pub mod database;
pub mod db_backup;
pub mod db_schema;
pub mod filesystem;
pub mod library;
pub mod live_chat_storage;
pub mod logger;
pub mod media_comments;
pub mod media_creation;
pub mod pending_media;
pub mod process_registry;
pub mod ssrf_guard;
pub mod temp_paths;
pub mod thumbnail;
pub mod video_repository;
pub mod yt_dlp;
