# Troubleshooting

What to do when Kavynex does not behave the way you expect. Every entry here is a case where
nothing is broken and the app is doing what it was told to, which is exactly why they are worth
writing down, since each one otherwise reads as a bug.

This was part of `README.md` until that file had grown to carry the pitch, the install
instructions, seven troubleshooting entries and the privacy statement at once, and a reader with a
problem was not going to scroll past the screenshots to find it.

For where the app keeps its files, see [`DIRECTORIES.md`](DIRECTORIES.md); for what it stores and
sends, [`PRIVACY.md`](PRIVACY.md). To report something not covered here, see
[`../SUPPORT.md`](../SUPPORT.md).

## "yt-dlp was not found" / "ffmpeg was not found"

Kavynex does not bundle yt-dlp or FFmpeg. It resolves both binaries by searching the
directories listed in your `PATH` environment variable (never the current working
directory, so a file dropped next to the app cannot shadow the real binary). On Windows
it also honors `PATHEXT`, so a bare `yt-dlp` on PATH resolves to `yt-dlp.exe` (batch
shims (`.bat`/`.cmd`) are deliberately skipped, so install yt-dlp and ffmpeg as real
executables rather than wrapper scripts). If both lookups fail, it falls back to an optional
`tools/yt-dlp(.exe)` and `tools/ffmpeg(.exe)` inside the app's data directory, so a
portable install can be dropped there instead of PATH.

If you see this error:

- Confirm `yt-dlp --version` and `ffmpeg -version` work from the same terminal you
  launched Kavynex from (a shell profile change may not have reached the process that
  started the app, e.g. a desktop shortcut on Windows).
- Restart the app after installing or updating either tool, since the resolved path is
  looked up fresh on each use but a stale terminal/session PATH will not update itself.
- Use the in-app Diagnostics dialog, which reports the resolved path and version for both
  tools (or the exact reason they failed the health check).

## Windows: the app window does not open / shows a blank window

Kavynex is a Tauri app and renders its UI with Microsoft Edge WebView2. Windows 11 and
most up-to-date Windows 10 installs already have it. If the window fails to open or stays
blank, install the [WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/)
and try again.

## macOS: "kavynex is damaged and can't be opened", or "unidentified developer"

Neither message means the download is corrupt. Kavynex's installers are not code-signed (see
[`RELEASE-SECURITY.md`](RELEASE-SECURITY.md) for why), so macOS quarantines the app on first launch
and reports it in whichever of those two ways your version prefers. The "damaged" wording is the one
a genuinely broken bundle gets too, which is exactly why this belongs here: it reads as a failed
download rather than as the expected first run of an unsigned app.

Confirm the file is authentic *before* clearing the quarantine, since that is the check Gatekeeper
is standing in for:

```bash
gh attestation verify kavynex_*_aarch64.dmg --repo eduardoghi/kavynex
```

(Or compare its hash against `SHA256SUMS.txt` on the release page. Both apply from v1.2.0 onward;
see the README's "Verifying a download".)

Then drag the app into Applications and let it open, either way:

- **Without a terminal.** Try to open the app once, so macOS records the block. Then open System
  Settings > Privacy & Security, scroll to the Security section, and click **Open Anyway** next to
  the line naming kavynex. On macOS 15 and later this is the only route, since Apple removed the
  Control-click > Open bypass earlier versions offered.
- **With a terminal.** Clear the quarantine attribute directly:

  ```bash
  xattr -dr com.apple.quarantine /Applications/kavynex.app
  ```

Either one is a once-per-install step. An update installed through Settings > Application update
does not bring it back: that artifact is fetched by Kavynex itself rather than by a browser, so
nothing marks it as quarantined, and the updater verifies its minisign signature before installing
it.

## Linux: the AppImage does not start

Two things stop it, both about the AppImage format rather than about Kavynex, and neither says much
on its own.

**It is not executable yet.** A file downloaded through a browser has no execute bit, so a
double-click does nothing at all:

```bash
chmod +x kavynex_*_amd64.AppImage
./kavynex_*_amd64.AppImage
```

**FUSE 2 is missing.** An AppImage mounts itself in order to run, and the failure names the library
it could not load (`dlopen(): error loading libfuse.so.2`). Current distributions ship FUSE 3 and no
longer install FUSE 2 alongside it, so it has to be added:

```bash
sudo apt install libfuse2      # Debian/Ubuntu (libfuse2t64 on Ubuntu 24.04 and later)
sudo dnf install fuse-libs     # Fedora/RHEL
sudo pacman -S fuse2           # Arch
```

Or skip the mount entirely, which needs nothing installed:

```bash
./kavynex_*_amd64.AppImage --appimage-extract-and-run
```

If neither appeals, the `.deb` and `.rpm` on the release page carry no FUSE requirement.

## Linux: the window opens blank, or the app exits immediately

The Linux counterpart of the WebView2 entry above. Kavynex renders its UI with WebKitGTK, and these
are the two ways that dependency goes wrong.

**WebKitGTK is missing or too old.** Tauri v2 needs the 4.1 series (`libwebkit2gtk-4.1-0`), not the
4.0 one an older distribution may be the only thing carrying. Installing the `.deb`/`.rpm` through
the package manager rather than by double-clicking it is what pulls the dependency in, and what
reports it when it cannot:

```bash
sudo apt install ./kavynex_*_amd64.deb
```

Ubuntu 22.04 and Debian 12 are the oldest releases carrying the 4.1 series. On anything older the
AppImage is the way out, since it brings its own copy.

**The GPU driver and WebKitGTK's compositing disagree.** On some setups, most often the proprietary
NVIDIA driver, the window opens and stays blank, or the process dies at launch. Two environment
variables turn off the rendering paths that fail; try them one at a time:

```bash
WEBKIT_DISABLE_DMABUF_RENDERER=1 kavynex
WEBKIT_DISABLE_COMPOSITING_MODE=1 kavynex
```

If one of them works, set it for this app alone (a `.desktop` file's `Exec=` line, or a shell alias)
rather than globally, so it does not change how every other WebKitGTK app on the machine renders.

Launch from a terminal while working through either case. A fatal startup failure (a database
directory that cannot be resolved, a plugin that fails to register) is written to stderr, and
unlike Windows there is no dialog for it, so the terminal is the only place that line appears.

## "This library was released earlier in this session" after changing the library folder

Restart Kavynex and it works again. Nothing is lost and nothing needs to be repaired. The media,
the database and your settings are all untouched.

This appears if you move the library folder to a new location and then move it back within the same
session. Kavynex authorizes the library's folders with the webview so it can display your videos and
thumbnails, and that authorization can be withdrawn but not re-granted while the app is running (a
limitation of the underlying framework, not a state Kavynex chose). Rather than accept the move and
leave you with a library where every thumbnail and video silently fails to load, it refuses up front
and asks for the restart. After restarting, the folder is authorized normally.

## The library is on a drive or share that is not connected

Your media list looks normal, but no thumbnail draws, nothing plays, and Diagnostics reports the
library summary check as failed and *every* media file as missing, with real filenames listed as
examples. That reads like the library was wiped. It was not, and the reason the two halves disagree
is where each one lives: the database sits with the app's own data, not in the library folder, so
the rows survive a disconnected drive intact while the files they point at are simply out of reach.

Reconnect the drive (or bring the network share back online) and **restart Kavynex**. The restart is
the part worth knowing about: the library folder is authorized with the webview once, when the
library path is loaded at startup, and reconnecting the drive mid-session does not re-run that, so
without a restart the files are reachable again while the thumbnails and the player still refuse
them.

Nothing needs repairing afterwards. If you want to confirm, run Diagnostics once the library is back
and the same checks report the real numbers.

One thing to *not* do while the drive is away: do not point Settings > Library folder at a new
location to "fix" it. Kavynex cannot tell a library that is temporarily unreachable from one that
was never there, so instead of refusing it treats the move as a first-time setup. It reports
success, copies nothing, and adopts the new empty folder as your library. Your media is not deleted
(the disconnected drive is never touched), but the app is now pointed somewhere else and every item
reads as missing until you point Settings > Library folder back at the original path. Reconnect the
drive first and the whole situation does not arise.

(The log records this too, as a `library_guard` line saying the library path was accepted by an
exact-string match because it could not be canonicalized. That line is the app noting it could not
confirm where the folder really is, which is exactly what an absent drive looks like from inside.)

## Adding a video again downloads nothing, or downloads and then keeps the old file

Both are deliberate, and which one you see depends on whether the video is going back into the
*same* channel.

- **Same channel.** The add is refused before anything is downloaded, with "this media is already
  registered for the selected channel". The check is on the video's YouTube id, so it applies
  whichever format you pick, and no bytes are fetched.

- **A different channel.** This is allowed, because the same video can legitimately belong to two
  channels, so the download runs normally. If the library already holds that video *in that same
  format*, the finished download is then discarded and the file already on disk is reused. The
  terminal says so: "A file for this video and format already existed in the library; kept the
  existing copy and discarded the new download." A live chat replay is handled the same way, with
  its own message. Both entries now point at one file, and deleting either one leaves the file
  alone while the other still references it; it is removed when the last reference goes.

What this is **not** is a reason a higher-quality download fails to appear. A downloaded file is
named after the video *and* the format you chose (`youtube_<id>_<format>.mp4`), so a different
format is a different file and downloads normally. If a re-download seems to have been ignored,
check that you picked a different format and not the same one.

To genuinely replace a file rather than reuse it (an interrupted download left it truncated, say),
delete the media in Kavynex first. That removes the file too, unless another entry still points at
it, and the next add downloads fresh. `DIRECTORIES.md` has the naming rules behind all of this.

## Kavynex reports a corrupted database

This is handled automatically and nothing is silently lost. On the next launch Kavynex restores
the database from the most recent healthy snapshot (it keeps several daily `.bak` generations, and
an off-volume mirror if you configured one in Settings > Database). The broken file is preserved
next to the database as `kavynex.db.corrupt` rather than deleted, so it can still be inspected. See
`DATABASE.md` for the full backup/restore model and `DIRECTORIES.md` for where these files
live. If the library ever looks incomplete after a restore, run Diagnostics to reconcile the
database against the files on disk.

## "Open file location" or "Open folder" does not do quite what you expect

Both buttons hand the path to your operating system's own file manager, and the three
platforms disagree about what "show me this" means. Nothing is broken in the cases below;
this is the best each file manager offers.

- **Linux: the file is not highlighted.** "Open file location" opens the folder containing
  the media, but does not select the file inside it. Windows and macOS both highlight it.
  `xdg-open` has no "reveal this item" mode (it only opens a target), so the folder is
  opened instead. With many files in `video/`, sorting by modification date is usually the
  quickest way to spot the one you came for.
- **macOS: "Open folder" shows the library folder rather than opening it.** Finder opens the
  folder *containing* your library, with the library itself highlighted; double-click to go
  in. This is deliberate. A macOS application bundle is a directory, so the plain "open"
  command would *launch* a folder that happens to be an `.app` instead of showing it, and
  Kavynex always reveals rather than opens so that can never happen. Windows and Linux open
  the folder directly.

There is also one case where both buttons fail outright rather than behaving differently:

- **A library reached through a UNC path** (`\\server\share\...`, e.g. a NAS addressed that
  way). Kavynex refuses to hand such a location to the file manager. On Windows, merely
  resolving one makes the system authenticate to whatever host is named and hand over your
  account's password hash, so the path is rejected before it is touched. Everything else about
  a library on a share is unaffected. Playing, downloading, importing and thumbnails all work.
  The refusal is specific to the `\\server\share` form: a share mounted as a drive letter
  (`Z:\...`) is an ordinary local path as far as this check is concerned, so mapping the share
  and pointing the library at the drive letter keeps both buttons working. See `THREAT-MODEL.md`
  for the full reasoning.

## Where logs live

Kavynex writes a rolling log file in addition to stderr. The quickest way there is the
**Open log folder** button in the Diagnostics dialog, which reveals the directory in your file
manager. Failing that, it is the current platform's app log directory (see `DIRECTORIES.md`):
look for `kavynex.log` (and `kavynex.log.1`, the previous rotation, once the current file passes
5 MB). Attach the relevant lines when reporting a bug. Logs can contain file paths and a reference to each video you download, so
they do reveal which videos were fetched. A run that succeeds records only a reduced
reference (the video id; the playlist and tracking parameters of the URL you pasted are
dropped), but one that fails also records yt-dlp's own verbose output, which can include the
full URL. When the cookies-from-browser feature is used they record only the fact that a
browser cookie source was used, never the cookie values; the path of a cookies *file* is
redacted as well. Still avoid pasting full logs in a public issue without a quick
read-through first.
