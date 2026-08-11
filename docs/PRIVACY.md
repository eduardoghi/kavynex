# Privacy

What Kavynex stores, where it stores it, and the only three things it ever sends over the network.
Also how to take your data with you, and how to remove it.

This was part of `README.md` until that file had grown to carry the pitch, the install instructions,
the troubleshooting guide and this at once. It is a statement about the app's behavior and deserves
to be findable on its own rather than as a section someone scrolls past.

[`DIRECTORIES.md`](DIRECTORIES.md) lists the directories named below, per OS.
[`THREAT-MODEL.md`](THREAT-MODEL.md) covers how the app protects them at runtime.

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
cookie values. See `DATABASE.md` and `THREAT-MODEL.md` for more detail on what is stored
locally and how it is protected.

## Taking your data with you, or removing it

Everything Kavynex holds is a plain file on your disk, so both are file operations rather than
in-app flows:

- **Your media, thumbnails and live chat replays** live in the library folder you chose (Settings >
  Library folder shows the current path). They are ordinary files - copy the folder anywhere and it
  is a complete backup of the media itself.
- **The database** (channels, titles, watched state, comments) is a single SQLite file. Settings >
  Database > Export writes a snapshot of it wherever you choose, which is the portable copy to keep.
- **The cache folder** holds nothing of yours that is not already in one of those two: temporary
  previews, and a smaller copy of each thumbnail the grid has drawn, so a card decodes a few hundred
  pixels instead of the stored image's full resolution. Deleting a media removes its copy along with
  it, and the whole folder is safe to delete at any time - anything still needed is regenerated the
  next time it is drawn. `DIRECTORIES.md` lists where it is per OS.

The database's automatic `.bak` snapshots live next to the database itself, on the same disk, so a
drive failure takes them with it. To guard against that, **Settings > Database > Automatic external
backup** lets you point Kavynex at an external folder (another drive or a network share); it copies
the database there once a day. Only the database is copied - the media files are large and are not
mirrored, so keep an off-drive copy of the library folder yourself (an external disk, or your own
cloud backup).

Uninstalling removes the app, not your data - by design, since the library is usually the point.
To remove everything, delete the library folder plus the three app directories (config, cache and
logs). The Diagnostics dialog shows the resolved library folder; `DIRECTORIES.md` lists the
per-OS paths of the other three and what each one holds. Note that the config directory is the one
holding the database and its automatic backups, so deleting it discards the channel/watched/comment
data even though the media files live elsewhere.
