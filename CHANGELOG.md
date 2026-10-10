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

### Fixed

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

### Security

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
