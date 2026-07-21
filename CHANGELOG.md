# Changelog

All notable, user-facing changes to Kavynex are recorded here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Every tagged release also has auto-generated notes (every commit since the previous tag) on the
[GitHub Releases page](https://github.com/eduardoghi/kavynex/releases). This file curates the
user-facing highlights; the commit history is the exhaustive record.

## [Unreleased]

A large batch of work is staged for the next release. Highlights below; see the commit history for
the full set (hundreds of fixes, refactors and test/CI improvements not listed individually).

### Added

- Database backup and recovery: automatic pre-migration and periodic snapshots with multiple
  retained generations, restore-from-backup when the database fails to open, an optional off-volume
  external backup mirror with a folder picker, an on-demand and a throttled background integrity
  check, and database export/import with an undo path.
- Live chat replay: colored author names by role, inline custom channel emojis, super chats with
  amount and tier color, membership/gift/super-sticker events, a sticky pinned-message banner, and
  gzip-compressed replay storage.
- Media player: keyboard shortcuts with a shortcuts popover, and isolation behind its own error
  boundary; offer to fetch comments from the player when a YouTube media has none.
- Library and browsing: a server-side paginated media query with filters and sort, a publication
  date filter, and virtualized comment search that shows every match.
- Diagnostics: detection of orphan media/thumbnail files and zero-length (corrupted) files, example
  file paths for issues, and jump-to-media from a missing-media path.
- Privacy and settings: opt-in loading of remote comment/live-chat images, an opt-in passive update
  check on startup, a persisted external backup directory, and window size/position persistence.
- Robustness: a root error boundary that persists frontend crashes to the app log, zod validation of
  IPC responses and event payloads, single-instance focus instead of a second window, rotating file
  logs with cookie-path masking, and a warning when the installed yt-dlp is old.
- Supply chain: each release now publishes a CycloneDX SBOM of the Rust dependency tree, covered by
  SHA256SUMS.txt and the release asset-completeness check.

### Changed

- The yt-dlp browser list now covers all 9 officially supported browsers.
- The channel library is paginated through the server-side media query.

### Fixed

- External backup safety: reject a backup directory inside the app config directory, and keep the
  good copy when finalizing an export or mirror fails.
- Prevent silent comment loss when a duplicate comment id has blank text, and report a concurrently
  deleted media as not found on a zero-comment refresh.
- Verify the gzip round trip before removing a freshly downloaded live chat replay.
- Clear the live-chat database columns when deleting a replay file.
- Numerous additional bug fixes and hardening across downloads, backups, the player, live chat and
  the library (see the commit history).

## [1.1.1] - Released

See the [v1.1.1 release notes](https://github.com/eduardoghi/kavynex/releases/tag/v1.1.1).

## [1.1.0] - Released

See the [v1.1.0 release notes](https://github.com/eduardoghi/kavynex/releases/tag/v1.1.0).

## [1.0.0] - Released

First public release. See the
[v1.0.0 release notes](https://github.com/eduardoghi/kavynex/releases/tag/v1.0.0).

[Unreleased]: https://github.com/eduardoghi/kavynex/compare/v1.1.1...HEAD
[1.1.1]: https://github.com/eduardoghi/kavynex/releases/tag/v1.1.1
[1.1.0]: https://github.com/eduardoghi/kavynex/releases/tag/v1.1.0
[1.0.0]: https://github.com/eduardoghi/kavynex/releases/tag/v1.0.0
