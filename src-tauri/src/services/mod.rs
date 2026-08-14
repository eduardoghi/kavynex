// Service modules, grouped into a directory per feature family once a family outgrew a flat
// prefix. `library_*`, `thumbnail_*` and `yt_dlp_*` were nine, six and seven sibling files whose
// shared prefix was already naming a directory; making it one applies the same rule
// docs/ARCHITECTURE.md states for a file that outgrows itself (db_backup/, db_schema/,
// video_repository/, yt_dlp/download/) to a *concept* that outgrows itself. Within a family,
// siblings reach each other through `super::`, matching those existing directories.
pub mod binaries;
pub mod channel_repository;
pub mod database;
pub mod db_backup;
pub mod db_schema;
// The OS file-manager spawn, which lived in `library` while that was its only caller. It is not a
// library concern (resolving `explorer.exe`/`open`/`xdg-open` has nothing to do with the user's
// media directory), and a second caller (the Diagnostics "Open log folder" button) made keeping it
// there mean either a cross-family import or a second copy of the three platform branches.
pub mod file_manager;
pub mod filesystem;
pub mod library;
pub mod live_chat_storage;
pub mod logger;
pub mod media_comments;
pub mod media_creation;
pub mod pending_media;
pub mod process_registry;
pub mod ssrf_guard;
// `temp_cleanup` rather than `cleanup`, because `library::cleanup` already owns that name for a
// different job: this one sweeps the disposable cache directories, that one reference-counts and
// unlinks the user's media. docs/ARCHITECTURE.md used to resolve the collision by convention (reach
// a family sibling through `super::`, everything else by full path), which worked but left the two
// distinguishable only by how they were imported. Naming them apart makes a call site say which is
// meant without the reader having to know the rule.
pub mod temp_cleanup;
pub mod temp_paths;
pub mod thumbnail;
pub mod video_repository;
pub mod yt_dlp;
