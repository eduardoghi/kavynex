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
pnpm test
```

