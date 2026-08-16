# The IPC surface exposes operations, not steps

**2026-07-30**, commit `eed1ea6` (*refactor: create a media in one backend command instead of
seven*), completed by `303f072` on 2026-07-31.

## What the code does now

`create_media` (`src-tauri/src/commands/media.rs`) is one command. It produces the artifacts,
records the crash marker, inserts the row and clears the marker, and `services::media_creation`
holds the ordering. The steps are internal: nothing in `src/` can run one of them on its own.

## What it did before

The renderer drove the sequence across seven IPC calls, so every step had to be a registered
command. Eight were removed as the sequence moved:

| Command | Where it lived |
|---|---|
| `import_media_file` | `commands/media.rs` |
| `download_media_from_url` | `commands/media.rs` |
| `download_thumbnail_from_url` | `commands/thumbnail.rs` |
| `media_exists_for_channel_and_youtube_id` | `commands/videos.rs` |
| `record_pending_media_artifacts` | `commands/media.rs` |
| `clear_pending_media_artifacts` | `commands/media.rs` |
| `insert_media` | `commands/videos.rs` |
| `find_media_by_channel_and_file_path` | `commands/videos.rs` |

The last two outlived the change by a day. Every IPC test in `commands/videos.rs` seeded its rows
through `insert_media`, so removing it was test surgery rather than a line in the same commit. Those
tests seed through `services::video_repository` directly now.

## What breaks if someone goes back

**The crash marker is the sharpest case.** A marker names artifacts in the library, and the startup
sweep (`services::pending_media`) acts on what it names. A caller able to write one could name files
it never created and have the next launch reconcile them; a caller able to clear one could drop the
record of a creation that really did die, leaving artifacts nothing will ever reconcile.

**The download and the import are the same argument one step down.** Both write into the library.
Reaching either directly produces exactly the artifacts-with-no-row state the whole module exists to
bound, with no marker behind it, because writing the marker was the renderer's job.

**The window stops being containable.** Between the file landing in the library and the row pointing
at it, the library holds bytes nothing references. That window is inherent (a file cannot join a
SQLite transaction) but it is now the inside of one function instead of the span of five round
trips, and no step of it is separately reachable.

**The exclusion stops being a backend property.** Nothing kept two creations from resolving to the
same content-addressed path except the add-media modal refusing to open twice, which
[`../THREAT-MODEL.md`](../THREAT-MODEL.md) recorded as the one guarantee in that document resting on
renderer behavior. It is `library::cleanup::media_registration_guard` now, a lock the
reference-counted cleanup takes too, so a queue or a batch import cannot reopen it.

## A related move, one day later

`303f072` did not only delete `insert_media` from the command list. The validation it performed
moved down into `video_repository::insert_media` rather than being deleted with it.

The distinction matters. As a command-layer check it was a property of *arriving over IPC*, which
left `media_creation`, the one remaining caller, trusted to have validated on its own. It mostly
had, with one gap: the `media_type` a yt-dlp creation stores is the download's own value and never
passes through `normalize_create_media_request`, so nothing but the table's `CHECK` stood behind it.
At the repository it is a property of writing a row, which is what every caller does.

## Where the rule lives now

As a comment on `commands/media.rs`, at the file the rule was established for, stated forward: the
IPC surface exposes an operation, not its steps.
