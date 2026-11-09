<img width="767" height="432" alt="Kavynex logo" src="https://github.com/user-attachments/assets/d12c5c4f-4a78-4856-beca-9500c2f6bed7" />

# Kavynex

Kavynex is a desktop app for archiving YouTube channels and playing back what you saved.

Downloading the video is the easy part. What goes with a channel and does not come back is
everything around it, so Kavynex saves the comment section and the live chat replay alongside the
media, keeps all of it in a library on your own disk, and plays it back offline. No server, no
container, no account. It is an application you install.

It was built to preserve the channels I follow, and it is what I use for that.

## Features

**Archiving**

- Back up a channel's video and audio with `yt-dlp`
- See which of a channel's videos and lives on YouTube are not in your library yet, import them
  one by one or a chosen few in a row, or set aside the ones you do not want
- Save the comment section, with the reply threads rebuilt as they were
- Save a stream's live chat and replay it alongside the video, in sync through seeks
- Save thumbnails with the media they belong to

**Your library**

- Organize media by channel, with the channel avatar and banner fetched from its handle
- Import video and audio files you already have on disk
- Search, filter and sort within a channel
- Mark media watched or unwatched
- Resume where you stopped
- Reconcile the database against the files on disk with the built-in diagnostics
- Everything stays local, so nothing is uploaded, and loading remote images is off by default

## Requirements

For normal use, Kavynex requires:

- yt-dlp
- FFmpeg
- Deno, which yt-dlp uses to read YouTube's videos. Without it yt-dlp still runs, but YouTube
  offers it fewer formats and some downloads fail.

Make sure `yt-dlp`, `ffmpeg` and `deno` are installed and available in your system PATH.

If you cannot change your PATH (a locked-down work machine, or a portable install you want to
keep self-contained), drop the executables into a `tools/` folder inside the app's data directory
instead. Kavynex falls back to it when the PATH lookup finds nothing. `docs/DIRECTORIES.md` lists
that directory per OS, and `docs/TROUBLESHOOTING.md` covers how the lookup works and what the
in-app Diagnostics dialog reports about it.

## Installation

Prebuilt installers and packages are available on the latest GitHub release:

[Download the latest release](https://github.com/eduardoghi/kavynex/releases/latest)

### Windows

Download the installer matching your processor, `arm64` for a Windows on ARM device (Snapdragon
and similar), `x64` for everything else:

- `kavynex_*_x64-setup.exe`
- `kavynex_*_arm64-setup.exe`

The `.msi` package is also available if you prefer it:

- `kavynex_*_x64_en-US.msi`
- `kavynex_*_arm64_en-US.msi`

### macOS

Download the package according to your Mac:

- Apple Silicon / M1, M2, M3, M4: `kavynex_*_aarch64.dmg`
- Intel Mac: `kavynex_*_x64.dmg`

### Linux

Choose the package according to your distribution, in the build matching your processor. The
`amd64`/`x86_64` files are for a normal 64-bit PC, the `arm64`/`aarch64` ones for an ARM machine
(a Raspberry Pi 5, an Ampere server, an ARM cloud VM):

- AppImage: `kavynex_*_amd64.AppImage` / `kavynex_*_aarch64.AppImage`
- Debian/Ubuntu: `kavynex_*_amd64.deb` / `kavynex_*_arm64.deb`
- Fedora/RHEL/openSUSE: `kavynex-*.x86_64.rpm` / `kavynex-*.aarch64.rpm`

The `.deb` and `.rpm` need glibc 2.39 or newer, which means Ubuntu 24.04, Debian 13, Fedora 40 or
later. The AppImage carries its own WebKitGTK and the libraries under it, built on Ubuntu 26.04, and
those need glibc 2.43 or newer (Ubuntu 26.04 or later). On an older system, use the `.deb` or `.rpm`.

The built-in player plays media through GStreamer. The AppImage carries the plugins it needs. The
`.deb` and `.rpm` use the system's and recommend the two packages most downloads need (the "good"
plugins and libav), which a package manager installs along with Kavynex unless told to skip them.

(The architecture is spelled differently by each packaging format. That is the format's convention,
not an inconsistency in the build.)

### Verifying a download

The installers are not code-signed (a deliberate tradeoff explained in
`docs/RELEASE-SECURITY.md`), so SmartScreen/Gatekeeper will warn on first run. To confirm a
download is authentic:

- Compare its hash against `SHA256SUMS.txt`, published alongside the installers.
- Or, with the [GitHub CLI](https://cli.github.com/), verify its build provenance:

  ```
  gh attestation verify <installer-file> --repo eduardoghi/kavynex \
      --signer-workflow eduardoghi/kavynex/.github/workflows/release.yml \
      --source-ref refs/heads/main
  ```

  A successful check confirms the file was built by this repository's release workflow, from
  `main`. With `--repo` alone, any workflow of the repository from any branch would pass.

Both apply from v1.2.0 onward. The checksum and provenance steps were added to the release
workflow after v1.1.1 was published, so v1.1.1 and earlier have neither, and `gh attestation
verify` will report *no attestation* for those installers rather than a failure to trust.

## Screenshots

### Channel library

<img width="2110" height="1450" alt="image" src="https://github.com/user-attachments/assets/a1e8d805-6ce7-48f2-bf94-a80b09881124" />

### YouTube import

<img width="2110" height="1450" alt="image" src="https://github.com/user-attachments/assets/93ea80fe-d1b2-478e-8838-024ba52f998f" />

### Video player

<img width="2110" height="1450" alt="image" src="https://github.com/user-attachments/assets/6217d56d-b7d9-44ef-a2bc-2b5315645ed4" />

### Live chat backup

<img width="2110" height="1450" alt="image" src="https://github.com/user-attachments/assets/7a752957-0bca-41cd-9626-7b0e48544ecf" />

### Diagnostics

<img width="2110" height="1450" alt="image" src="https://github.com/user-attachments/assets/8b834774-4ddd-4778-84d8-22477f48d920" />

### Light theme

<img width="2110" height="1450" alt="image" src="https://github.com/user-attachments/assets/d7eb0cf5-345f-4bfb-9884-f8450685c365" />


## Development

To run the project from source, you need Node.js, pnpm, Rust, yt-dlp, FFmpeg and Deno.

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

## Troubleshooting and privacy

Both outgrew being README sections and now have documents of their own:

- [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md): yt-dlp/FFmpeg not being found, the app not
  starting (WebView2 on Windows, Gatekeeper on macOS, FUSE and WebKitGTK on Linux), a library on a
  drive that is not connected, why adding a video again downloads nothing or keeps the file you
  already have, a corrupted database, why "Open file location" behaves differently on each
  platform, and where the log file lives.
- [`docs/PRIVACY.md`](docs/PRIVACY.md): everything Kavynex stores, everything it sends over the
  network, and how to take your data with you or remove it.

## Third-party assets

Kavynex's own code is MIT (see `LICENSE`). The one bundled asset under a different license is the
display typeface used for headings, **Bricolage Grotesque**, licensed under the SIL Open Font
License 1.1. The OFL permits bundling a font inside an application without affecting that
application's own license, but it does require the copyright notice and license text to travel with
the distribution, so the font's license is shipped verbatim as
`licenses/bricolage-grotesque-OFL-1.1.txt` inside the app bundle (from `public/licenses/` in this
repository), and applies to the font files only, not to Kavynex itself.

## More documentation

- `docs/ARCHITECTURE.md`: the layered backend/frontend architecture, the IPC boundary, and a
  walk-through of the main flows (adding media, changing the library folder, database recovery).
- `docs/FILE-REMOVAL.md`: every place the app removes or moves away a file, and what keeps it from
  taking one that is still needed.
- `docs/decisions/`: why a handful of non-obvious shapes were chosen, and what breaks if one of
  them is reverted.
- `docs/DATABASE.md`: the SQLite schema, migrations, and backup/restore/export/import model.
- `docs/DIRECTORIES.md`: the runtime directories and library layout the app uses on disk.
- `docs/TROUBLESHOOTING.md`: what to do when something does not behave the way you expect, and
  where the log file lives.
- `docs/PRIVACY.md`: what Kavynex stores, what it sends over the network, and how to take your
  data with you or remove it.
- `docs/RELEASING.md`: how a release is cut and published (needs repository write access).
- `CONTRIBUTING.md`: development setup, commands, and commit conventions.
- `docs/THREAT-MODEL.md`: what the app defends against at runtime: the IPC trust boundary, path
  safety, the capability grants, the asset-protocol scope and the CSP.
- `docs/RELEASE-SECURITY.md`: what makes a shipped build verifiable: the updater, why installers
  are unsigned, checksums, build provenance, the SBOM, static analysis and the dependency supply
  chain.
- `SECURITY.md`: how to report a vulnerability, and which versions are supported.
- `SUPPORT.md`: where to report a bug, what to include, and what to expect.
- `CODE_OF_CONDUCT.md`: the standard expected of everyone taking part, and how to report a problem.

