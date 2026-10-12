# Changelog

User-visible changes, newest first. Earlier releases are described on their GitHub release pages.

## [Unreleased]

### Added

- Diagnostics can remove orphan media and thumbnail files, the ones named by Kavynex that nothing in
  the library uses. They go to a `.trash` folder inside the library for 30 days rather than being
  deleted, the confirmation says how many and how much space, and the removal is not offered after
  an import or a restore, or while most files are unreferenced. Files you put in the library folder
  yourself are kept.
- A library page that failed to load can be tried again from the end of the list.
- Diagnostics reports channels whose handles differ only in letter case.
- Moving the library shows its progress and can be cancelled. It asks first, says what will be
  copied, and checks there is room before starting.
- yt-dlp is told where Deno is when it is installed, which some YouTube formats need.
- Add Media explains what the move import mode does to the original file.
- When the database file is missing but its backups are still there, Kavynex offers to restore one
  or to start with an empty library, instead of quietly creating an empty database.
- Diagnostics has a Compact database button that gives the space left by deleted media and comments
  back to the disk.
- When the full integrity check finds damage, Diagnostics offers to rebuild the database indexes,
  which repairs damage limited to an index without restoring a backup.
- While a database the integrity check found damaged is in use, the daily backup keeps the
  snapshots from before the damage and writes the day's copy to `kavynex.db.after-damage` (and
  `kavynex-backup.after-damage.db` in the external folder), so what you add meanwhile is backed up.
- Settings > Database says when the external backup folder cannot be reached and when the last copy
  was written, and calls out a copy more than three days old.
- Diagnostics shows the downloads kept after they could not be placed in the library and the files
  in the library's trash, with a button to open each folder.
- The import form can check for yt-dlp and FFmpeg again after you install them, without reopening.
- The import form warns when the built-in player usually cannot play the picked file type (AVI, WMV,
  FLV, MPEG, WMA, AIFF). The file is still added.
- The arrow keys, Home and End move between media cards, and the grid is a single Tab stop.

### Changed

- Deleting a media or a channel says when some of its files could not be removed.
- Installing an update waits while a download or import is running, and warns that the app will
  restart.
- The file pickers only list the file types each one accepts.
- An auto-filled title is replaced when you pick another file or paste another URL.
- Error messages queue instead of replacing the one on screen.
- The yt-dlp terminal stays where you scrolled it during a download, and keeps the destination,
  merge and "already downloaded" lines instead of replacing them with the next percentage.
- A media whose creation failed, or was interrupted by a crash, has its files moved to the library's
  trash instead of deleted.
- A local media's publication date must be a YYYY-MM-DD date.
- Times a media was added are shown in local time.
- Downloads kept after a failed placement are stored in the app's data folder instead of its cache,
  where the system could clear them.
- Cancel stays available until the media is in the library, and the import says what it is doing
  after the download ends.
- Comments are fetched and saved in one step, so closing the window during a refresh no longer
  loses it, and opening a media with many comments reads only what it shows.
- Settings opens on the update the startup check already found, instead of asking you to check
  again.
- The database import confirmation shows the picked file's name and takes keyboard focus.
- Two unused comment indexes are dropped from the database, which speeds up saving comments.

### Fixed

- An update download that stalls now ends with an error after ten minutes, which unlocks Settings.
  It used to keep Settings locked until the app was quit.
- After Fetch comments finds nothing, the button is no longer offered again for the same media, and
  Refresh comments is no longer in the player menu for a media without a YouTube source.
- A library move that finished but could not save the new folder says so and asks for a restart,
  instead of reporting that the move failed. A cancelled move is shown as a notice.
- Diagnostics no longer reports problems worked out from a check that could not run. A missing
  yt-dlp no longer reads as a missing FFmpeg too, and a library summary that failed no longer reads as
  an empty library.
- The Add media form warns when yt-dlp or FFmpeg is missing. The warning never showed, because a
  missing tool made the whole check fail instead of reporting that tool.
- A Move import that could not remove the original file says it copied the file instead. It used to
  look moved while the original stayed where it was.
- Cancel pressed right as an import or download starts now stops it, and one pressed once the media
  is being saved says it can no longer be cancelled instead of doing nothing.
- An imported or restored database gets the full integrity check on the next launch instead of up
  to a week later.
- A Move import onto a drive without hard links (FAT32, exFAT) that could not be added puts the file
  back where it was. It used to stay in the library unused, where Diagnostics offered to remove it.
- A media import that copies to another drive checks the copy before the original is moved away.
  A copy that came out different from the original stops the import and leaves the original where
  it was, instead of being kept in the library under a name that vouched for it.
- Changing the sort, filter or search while the library was loading more media could leave a run of
  media missing from the list until the next reload.
- Add media no longer shows a Cancel download button that did nothing while a finished download is
  saved to the library, and cancelling the format listing no longer opens an error dialog.
- Closing Diagnostics while Verify saved files runs stops the check. It used to keep reading the
  whole library in the background, and Diagnostics refused to start another until it finished.
- The duration of an added media is read through the same channel the player uses. On macOS and
  Linux it went through one that cuts reads at 1 MB, which can leave a long recording without a
  duration.
- A channel handle with a space after the @ is refused when the channel is saved. It could not be
  used to fetch the channel avatar.
- The log file writes your home folder as `~`, including in the errors the window reports and in
  yt-dlp's output, so the OS user name stays out of a log attached to a bug report. Each uncaught
  window error is logged once, with its stack, and the harmless ResizeObserver notice is no longer
  logged.
- The leftover files of an import that died midway are no longer forgotten when Kavynex starts with
  the library drive unplugged. They are moved to the library trash once the drive is back.
- A library move onto the current folder, reached by another name such as a network path or a
  mapped drive, is refused instead of deleting the library.
- A finished download is kept when it cannot be placed into the library, instead of being deleted
  with its temporary folder.
- A download is saved even when its thumbnail, its chosen thumbnail or its live chat replay cannot
  be fetched or stored.
- A cancelled download is killed again when the first attempt does not stop it, and yt-dlp and
  FFmpeg end with the app however it exits on Windows. A download still waiting for a slot stops
  waiting when it is cancelled.
- The deep library check no longer reports a clean result when it skipped files, and downloaded
  media are named after their content so the check can verify them.
- Warnings found at startup (database damage, unfinished imports, files missing after a database
  import) are shown even when they arrive before the window has loaded, and a database import that
  could not be applied is reported instead of only logged.
- The player's keyboard shortcuts work as soon as it opens, and leave Space and the arrow keys to a
  focused control outside it.
- Channel handles that differ only in letter case are treated as the same channel.
- Refreshing comments merges them with the stored ones instead of replacing them.
- Refreshing comments keeps the text a comment had when it was first saved, after its author edits
  or removes it on YouTube. "Show the first version" under the comment displays it.
- A playlist or channel link is refused where a single video is expected.
- The library list stops requesting more media after a page fails to load.
- Importing a database keeps this machine's library and backup folders.
- An import whose in-progress marker could not be removed no longer has its database deleted on a
  later start. The database found in its place is kept as `kavynex.db.displaced-*`.
- The warning that a database import could not be applied is no longer lost when several startup
  warnings are read at once.
- A database upgrade that fails on a damaged database offers a restore instead of reporting a full
  disk.
- A restore interrupted by a crash no longer replays the damaged database's log into the restored
  one.
- Moving the library verifies each copy from the drive rather than from memory, and refuses a
  library that holds a link to a file elsewhere instead of dropping it.
- A library folder on a drive that is not connected is never recreated empty.
- A finished download is covered by the crash recovery as soon as it is in the library.
- Channels whose handles differ only in case, from before that was checked, can be renamed again.
- A thumbnail preview cut short is no longer reused or saved as the media's thumbnail.
- Display thumbnails keep being resolved until every page has them.
- The daily backup no longer replaces backups that hold a library with a copy of an empty database,
  checks each new snapshot before rotating, and stops rotating after a failed integrity check.
- Restoring, exporting or importing a database that another program is holding says so instead of
  calling it damaged.
- A restore keeps this machine's library and backup folders, and reports media files missing from
  the restored library.
- The library's trash moves with the library, and its 30-day window counts from when the files were
  moved there.
- Cancelling a local import works during the thumbnail step too.
- Each yt-dlp run gets its own copy of the cookies file, so two runs cannot overwrite it.
- A download no longer leaves empty folders in the library when it fails.
- A failed copy, move or rename, a missing source file and a file that could not be deleted get an
  explanation instead of a pointer to the log.
- The channel's media stay on screen when reloading the list fails, with a Try again button.
- Creating a channel is no longer reported as failed when only reloading the channel list failed,
  and a YouTube avatar that cannot be downloaded no longer stops the channel from being created.
- A download's log keeps working when one of its event listeners fails to register, and says so.
- Download errors show the end of yt-dlp's output instead of all of it, and log lines can no longer
  span several lines or grow without bound.
- Files that an antivirus or the search indexer holds for a moment on Windows are retried instead of
  failing the import, download or backup.
- Media files are served with correct responses for out-of-range and empty requests.
- Starting with an empty library, when the database file is missing, asks a second time and no
  longer has the initial focus. The old backups are moved to a `set-aside-backups` folder that
  Diagnostics opens and Import can read, instead of being rotated out by the new library's backups.
- The external backup no longer replaces its copies with an empty or damaged database. Copies an
  earlier install left in the folder are renamed to `kavynex-backup-previous-*.db` and kept.
- A restore stops at a backup another program is holding instead of taking an older one, and the
  restore dialog stays open after a failed attempt.
- A database file emptied to zero bytes is treated like a missing one, with the restore offered.
- The weekly full database check runs weekly on Windows instead of at every launch.
- Compact database refuses a database the integrity check found damaged, or a disk without room for
  the rewrite, and Diagnostics stays open while it runs.
- A finished download is never lost when moving it into the library fails, and a scanner holding the
  file for a few seconds no longer makes the move fail.
- Cancelling after the download was placed no longer adds the media anyway.
- A live chat replay that was cut short is not saved.
- Refreshing comments refuses a video id that is not the media's own.
- A newly created channel opens, instead of the select-a-channel prompt.
- A channel list or settings that could not be read no longer shows the first-run screen.
- Importing a database or undoing an import waits for a library move or a download to finish.
- Settings shows an update the startup check found even when it was opened before the check ended.
- Focus no longer drops to the page after deleting a media, after Check again finds the tools, or
  after cancelling a database import.
- The library count is announced once per search or filter instead of on every page load.
- Thumbnail previews work in a cache folder whose path contains a percent sign.

### Security

- The log file no longer gets full file paths or a cookies browser profile from the app's interface.
  A path is written as its last part and the profile as redacted, as the rest of the log already did.
- Importing a database keeps this machine's choice about loading comment and live chat images from
  Google. The imported file could turn it on.
- File paths are accepted only when you picked them in a dialog, for imports, exports, thumbnails
  and cookies files.
- The app window cannot navigate away from Kavynex or open new windows.
- YouTube links are built by the app from the video or channel id instead of being taken as URLs.
- Network paths are refused before they are resolved, which on Windows would have sent your
  credentials to the host.
- An imported database cannot bring its own triggers or point at files outside the library.
- Local paths, the pasted URL and cookies settings are removed from yt-dlp's output in the terminal
  and the log, including the browser cookie database yt-dlp finds by itself.
- Only links to a single video are accepted, so a feed, a search or a playlist link never reaches
  yt-dlp with your cookies.
- yt-dlp runs that have no folder of their own start in an empty private folder instead of the
  shared temp folder, and child processes on Windows do not look for programs in their working
  folder.
- FFmpeg only opens local files, and a picked thumbnail has to be an image, whatever its name.
- A folder picked for the backup mirror is not accepted as the library, or the reverse.
- The window only navigates to the app's own address on each platform, drag and drop is off, and
  `Object.prototype` is frozen.
- The webview can no longer read the live chat folder directly. Live chat is streamed by the app.
- Relative folders in PATH are skipped when looking for tools, `taskkill` is run from the system
  folder, and yt-dlp plugins are disabled.
- Database files opened from outside (an import, the backup mirror) are opened with SQLite's
  defensive settings, and a thumbnail picked from disk has to be an image under 25 MB.
- The format probe's output no longer shows the path of its copy of your cookies file, the copy is
  written back only when it changed and your file did not, and a copy left by a run the app closed
  on is removed at the next launch.
