# Where files are removed

Every path in the backend that deletes or moves away a file the user may still need, and what keeps
it from taking the wrong one. A change that adds a way to remove a file belongs in this table, and
the questions under it are the ones to answer before it lands.

The library folder holds the only copy of most of what Kavynex stores. Media can sometimes be
downloaded again, but comments and live chat saved for a video YouTube has since removed cannot.
So the rule is that a file nobody references is moved to the library's `.trash` folder when it may
still be wanted, and deleted outright only when it is certainly redundant.

## The removal paths

| Path | What it removes | Deleted or trashed | What protects the rest |
|---|---|---|---|
| Deleting a media or a channel (`library::cleanup::delete_media_with_artifacts`, `delete_channel_with_artifacts`) | The row's media file, thumbnail and live chat replay | Deleted | Reference count in the same `BEGIN IMMEDIATE` transaction as the row delete, recount right before the unlink, `MEDIA_REGISTRATION_LOCK`, refusal when the library cannot be reached |
| Remove orphan files in Diagnostics (`library::cleanup::remove_orphan_artifacts`) | `media_<sha256>` / `thumb_<sha256>` files no row names | Trashed (`.trash/<time>-<suffix>/`) | Digest match against every row, files written in the last hour skipped, refusal after an import or restore and when most such files are unreferenced (`orphan_removal_refusal`), `CREATION_GATE` held exclusively, recount before the move |
| A media creation that did not register (`media_creation::register_prepared_media` failure path) | What the creation wrote into the library | Trashed | Reference count, the only copy of a Move import is never named (`deletable_media_file`) |
| A thumbnail a creation stored and then did not keep (`media_creation::cleanup_artifacts_best_effort`, when the media fails to stage after its thumbnail was stored, or a supplied thumbnail replaces the fetched one) | That thumbnail | Deleted | Reference count, since the image is content-addressed and may already back a registered row, `MEDIA_REGISTRATION_LOCK` |
| A content-addressed write that fails its check (`filesystem::verify_content_addressed_write`) | The copy just written | Deleted | Only when the original still holds the expected bytes, which the error names, or when a file under the correct name already holds them |
| The startup sweep of crash markers (`pending_media::sweep_pending_media_artifacts`) | What a creation that died before its row wrote | Trashed | Markers this process wrote or newer than it are skipped (`marker_is_sweepable`), reference count, a database that will not open stops the sweep |
| A replaced channel avatar (`library::cleanup::replace_channel_avatar`, `commands::channels::remove_unused_avatar`) | The previous avatar | Deleted | Reference count across video thumbnails and every avatar |
| The library leftovers sweep (`temp_cleanup::cleanup_library_leftovers_sync`) | `.<name>.tmp-*`, `.<name>.backup-*` and older scratch shapes a week old, trash runs 30 days old | Deleted | Exact name shapes only, a `.backup-` whose live file is missing is kept, the library read guard |
| A library migration (`library::migration`) | The old library's managed folders | Deleted | Copy hashed on read and read back past the OS cache, size completeness check, commit marker written first, links refused, same-folder detection by file identity |
| The cache sweep (`temp_cleanup::cleanup_stale_temp_files_sync`) | Scratch folders, display derivatives, marker scratch files | Deleted | Seven days of age. Cache content is a copy of something else, with one exception. A finished download that could reach neither the library nor the recovered downloads folder is left in its run folder, and the download log tells the user to copy it out before the sweep clears it (`yt_dlp::download::placement::keep_unplaced_download`) |

Database files have their own rules in `docs/DATABASE.md`. Nothing deletes a database file the app
is not certain is redundant. A file the import recovery finds where it expected an empty one is set
aside as `kavynex.db.displaced-<suffix>`, and a restore keeps the damaged database as `.corrupt`.

## Before adding a removal

- Can the file be the only copy of something the user cares about? Then trash it, do not delete it.
- Is "unreferenced" decided against a database that can be wrong about this folder (a fresh import, a
  restored backup, another library's database)? Then the decision needs a guard like
  `orphan_removal_refusal`.
- Can a creation or an avatar write land between the decision and the removal? Take
  `MEDIA_REGISTRATION_LOCK`, or `CREATION_GATE` for a sweep of the whole folder, and recount right
  before acting.
- Does the path come from a row or the renderer? Resolve it with `absolute_path_from_relative` and
  the subtree it must stay in, then `ensure_existing_path_inside_dir`.
- Can the library folder be missing? Refuse rather than act on a path that may resolve elsewhere,
  and never create the library folder as a side effect (`library::paths::create_dir_in_existing_library`).
