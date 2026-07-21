<img width="767" height="432" alt="Kavynex logo" src="https://github.com/user-attachments/assets/d12c5c4f-4a78-4856-beca-9500c2f6bed7" />

# Kavynex

Kavynex is a desktop app for backing up and organizing media from YouTube channels and local files.

It was created to help preserve videos, audio, thumbnails, comments, and live chat data from channels I follow.

## Features

- Manage channels
- Import local video and audio files
- Download media using yt-dlp
- Save thumbnails, comments, and live chat
- Mark media as watched or unwatched
- Run library diagnostics

## Requirements

For normal use, Kavynex requires:

- yt-dlp
- FFmpeg

Make sure `yt-dlp` and `ffmpeg` are installed and available in your system PATH.

## Installation

Prebuilt installers and packages are available on the latest GitHub release:

[Download the latest release](https://github.com/eduardoghi/kavynex/releases/latest)

### Windows

Download the Windows installer from the latest release:

- `kavynex_*_x64-setup.exe`

The `.msi` package is also available if you prefer it:

- `kavynex_*_x64_en-US.msi`

### macOS

Download the package according to your Mac:

- Apple Silicon / M1, M2, M3, M4: `kavynex_*_aarch64.dmg`
- Intel Mac: `kavynex_*_x64.dmg`

### Linux

Choose the package according to your distribution:

- AppImage: `kavynex_*_amd64.AppImage`
- Debian/Ubuntu: `kavynex_*_amd64.deb`
- Fedora/RHEL/openSUSE: `kavynex-*.x86_64.rpm`

### Verifying a download

The installers are not code-signed (a deliberate tradeoff - see `SECURITY.md`), so
SmartScreen/Gatekeeper will warn on first run. To confirm a download is authentic:

- Compare its hash against `SHA256SUMS.txt`, published alongside the installers.
- Or, with the [GitHub CLI](https://cli.github.com/), verify its build provenance:

  ```
  gh attestation verify <installer-file> --repo eduardoghi/kavynex
  ```

  A successful check confirms the file was built by this repository's release workflow.

Both apply from the next release onward: the checksum and provenance steps were added to the
release workflow after v1.1.1 was published, so that release - the latest at the time of
writing - has neither, and `gh attestation verify` will report no attestation for it rather
than a failure to trust.

## Screenshots

### Channel library

<img width="2560" height="1392" alt="image" src="https://github.com/user-attachments/assets/8e4562bc-51bd-4c76-ad17-028e63fa646f" />

### YouTube import

<img width="2560" height="1392" alt="image" src="https://github.com/user-attachments/assets/1b8665a0-85d3-4e6a-9511-c649ce43eab6" />

### Video player

<img width="2560" height="1392" alt="image" src="https://github.com/user-attachments/assets/c6f51262-c5a1-49e0-9452-32b9a40acffe" />

### Live chat backup

<img width="2560" height="1392" alt="image" src="https://github.com/user-attachments/assets/51b2e41e-e857-4b32-9fa6-e7d49cf1b1b7" />

### Diagnostics

<img width="2560" height="1392" alt="image" src="https://github.com/user-attachments/assets/1218a24a-73b8-46af-ad71-0ac862caab6d" />

## Development

To run the project from source, you need Node.js, pnpm, Rust, yt-dlp, and FFmpeg.

```bash
pnpm install
pnpm tauri dev
```

## Build

```bash
pnpm tauri build
```

## Tests

```bash
pnpm test:run
```

(`pnpm test` runs the same suite in watch mode.) See `CONTRIBUTING.md` for the Rust suite and
the rest of the checks CI runs.

## Troubleshooting

### "yt-dlp was not found" / "ffmpeg was not found"

Kavynex does not bundle yt-dlp or FFmpeg. It resolves both binaries by searching the
directories listed in your `PATH` environment variable (never the current working
directory, so a file dropped next to the app cannot shadow the real binary). On Windows
it also honors `PATHEXT`, so a bare `yt-dlp` on PATH resolves to `yt-dlp.exe` (batch
shims - `.bat`/`.cmd` - are deliberately skipped, so install yt-dlp and ffmpeg as real
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

### Windows: the app window does not open / shows a blank window

Kavynex is a Tauri app and renders its UI with Microsoft Edge WebView2. Windows 11 and
most up-to-date Windows 10 installs already have it. If the window fails to open or stays
blank, install the [WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/)
and try again.

### Kavynex reports a corrupted database

This is handled automatically and nothing is silently lost. On the next launch Kavynex restores
the database from the most recent healthy snapshot (it keeps several daily `.bak` generations, and
an off-volume mirror if you configured one in Settings > Database). The broken file is preserved
next to the database as `kavynex.db.corrupt` rather than deleted, so it can still be inspected. See
`docs/DATABASE.md` for the full backup/restore model and `docs/DIRECTORIES.md` for where these files
live. If the library ever looks incomplete after a restore, run Diagnostics to reconcile the
database against the files on disk.

### Where logs live

Kavynex writes a rolling log file in addition to stderr. On the current platform's app
log directory (see `docs/DIRECTORIES.md`) look for `kavynex.log` (and `kavynex.log.1`,
the previous rotation, once the current file passes 5 MB). Attach the relevant lines when
reporting a bug. Logs can contain file paths and a reference to each video you download, so
they do reveal which videos were fetched - a run that succeeds records only a reduced
reference (the video id; the playlist and tracking parameters of the URL you pasted are
dropped), but one that fails also records yt-dlp's own verbose output, which can include the
full URL. When the cookies-from-browser feature is used they record only the fact that a
browser cookie source was used, never the cookie values; the path of a cookies *file* is
redacted as well. Still avoid pasting full logs in a public issue without a quick
read-through first.

## Privacy

Kavynex keeps all of your data (the database, downloaded media, thumbnails, comments, and
live chat) on your own disk, under the library directory and app data directories you
control. Nothing you back up is uploaded anywhere by the app itself. The only network
activity Kavynex initiates is:

- yt-dlp/FFmpeg downloading the video, audio, thumbnail, comments, or live chat data you
  explicitly requested, directly from YouTube.
- A check against the GitHub releases endpoint for a newer version. This is manual by
  default (only when you open Settings and click "Check update"). You can additionally
  opt in, under **Settings -> Application update**, to one passive check on startup;
  it is off by default, so the app contacts the update endpoint only when you ask.
- When viewing a saved video's comments or live chat, the player can load each comment/chat
  author's avatar and any custom emojis or super-sticker images on demand from Google's
  image servers (the same CDNs YouTube uses). This is **off by default**: unless you enable
  it in **Settings -> Privacy** ("Load comment and live chat images from Google"), avatars
  render as monograms, custom emojis fall back to their shortcut text, and viewing saved
  media makes no network requests at all. If you turn it on, only those small profile/emoji
  images are fetched - never the video, your library, or any of your data.

The optional "cookies from browser" option (used to back up member-only or otherwise
authenticated content) reads cookies directly from your local browser profile and hands
them to yt-dlp for that request only; Kavynex does not transmit, store, or display those
cookie values. See `docs/DATABASE.md` and `SECURITY.md` for more detail on what is stored
locally and how it is protected.

### Taking your data with you, or removing it

Everything Kavynex holds is a plain file on your disk, so both are file operations rather than
in-app flows:

- **Your media, thumbnails and live chat replays** live in the library folder you chose (Settings >
  Library folder shows the current path). They are ordinary files - copy the folder anywhere and it
  is a complete backup of the media itself.
- **The database** (channels, titles, watched state, comments) is a single SQLite file. Settings >
  Database > Export writes a snapshot of it wherever you choose, which is the portable copy to keep.

The database's automatic `.bak` snapshots live next to the database itself, on the same disk, so a
drive failure takes them with it. To guard against that, **Settings > Database > Automatic external
backup** lets you point Kavynex at an external folder (another drive or a network share); it copies
the database there once a day. Only the database is copied - the media files are large and are not
mirrored, so keep an off-drive copy of the library folder yourself (an external disk, or your own
cloud backup).

Uninstalling removes the app, not your data - by design, since the library is usually the point.
To remove everything, delete the library folder plus the three app directories (config, cache and
logs). The Diagnostics dialog shows the resolved library folder; `docs/DIRECTORIES.md` lists the
per-OS paths of the other three and what each one holds. Note that the config directory is the one
holding the database and its automatic backups, so deleting it discards the channel/watched/comment
data even though the media files live elsewhere.

## More documentation

- `docs/ARCHITECTURE.md` - the layered backend/frontend architecture and the IPC boundary.
- `docs/DATABASE.md` - the SQLite schema, migrations, and backup/restore/export/import model.
- `docs/DIRECTORIES.md` - the runtime directories and library layout the app uses on disk.
- `CONTRIBUTING.md` - development setup, commands, and the release flow.
- `SECURITY.md` - the threat model and how to report a vulnerability.

