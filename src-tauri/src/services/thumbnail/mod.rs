//! The thumbnail feature family: producing, fetching, persisting and serving the images the grid
//! and the player draw. Each concern is a submodule here rather than a `thumbnail_*` sibling of
//! this file; see `services/mod.rs` for why the grouping exists.
//!
//! This module holds only re-exports: the command layer imports the entry points from here, so it
//! does not have to know which submodule produces a preview, which persists one into the library,
//! and which resolves a display-sized copy.

pub mod display;
pub mod download;
pub mod persist;
pub mod picked;
pub mod redirect;
pub mod temp;
pub mod url;

pub use display::resolve_display_thumbnails_sync;
pub use download::{download_channel_avatar_from_handle_async, download_thumbnail_from_url_async};
pub use persist::{
    delete_thumbnail_file_sync, persist_thumbnail_file_sync, persist_thumbnail_from_source,
};
pub use temp::{
    delete_temporary_thumbnail_sync, generate_temporary_thumbnail_sync, stage_manual_thumbnail_sync,
};
