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

<img width="2560" height="1392" alt="image" src="https://github.com/user-attachments/assets/8e4562bc-51bd-4c76-ad17-028e63fa646f" />

### YouTube import

<img width="2560" height="1392" alt="image" src="https://github.com/user-attachments/assets/1b8665a0-85d3-4e6a-9511-c649ce43eab6" />

### Video player

<img width="2560" height="1392" alt="image" src="https://github.com/user-attachments/assets/c6f51262-c5a1-49e0-9452-32b9a40acffe" />

### Live chat backup

<img width="2560" height="1392" alt="image" src="https://github.com/user-attachments/assets/51b2e41e-e857-4b32-9fa6-e7d49cf1b1b7" />

### Diagnostics

<img width="2560" height="1392" alt="image" src="https://github.com/user-attachments/assets/1218a24a-73b8-46af-ad71-0ac862caab6d" />

