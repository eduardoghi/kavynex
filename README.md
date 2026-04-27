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

Prebuilt releases are not available yet.

Compiled installers/packages, such as `.exe` files for Windows, will be provided in a future release. For now, Kavynex needs to be run from source using the development setup below.

## Development

To run the project from source, you need Node.js, pnpm, Rust, yt-dlp, and FFmpeg.

```bash
pnpm install
pnpm tauri dev
````

## Build

```bash
pnpm tauri build
```

## Tests

```bash
pnpm test
```

## Screenshots

### Channel library

<img width="2560" height="1392" alt="Kavynex channel library" src="https://github.com/user-attachments/assets/c7162b7a-ebaa-473e-aacf-3d9444d2c2d3" />

### YouTube import

<img width="2560" height="1392" alt="Kavynex YouTube import modal" src="https://github.com/user-attachments/assets/9b6eaf7f-3463-4971-bb8e-be87c22cef7d" />

### Video player

<img width="2560" height="1392" alt="Kavynex video player" src="https://github.com/user-attachments/assets/e004690e-ed1d-426b-89fc-bc5394432834" />

### Live chat backup

<img width="2560" height="1392" alt="Kavynex live chat backup" src="https://github.com/user-attachments/assets/13930ddd-4a99-4ddb-a78b-458208f9ac80" />

### Diagnostics

<img width="2560" height="1392" alt="Kavynex diagnostics modal" src="https://github.com/user-attachments/assets/272615d4-fb55-459f-ab5c-7eb87cce08c1" />
