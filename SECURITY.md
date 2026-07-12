# Security

Kavynex is a solo-maintained, MIT-licensed desktop app. This document explains the threat
model behind its guardrails so contributors understand *why* they exist, not just that
they do, and how to report a vulnerability.

## Threat model

The webview renders content that ultimately comes from YouTube - video/channel titles,
comments, live chat messages, author names - none of which the app controls. That content
is rendered as plain React text (props/children), never through
`dangerouslySetInnerHTML` or `eval`, so it cannot execute as HTML/JS in the webview. Given
that, the primary realistic attack the backend defends against is not "YouTube serves a
malicious payload that runs in the webview" (React's default escaping already closes
that), but **a compromised or buggy frontend sending an unexpected IPC call** - a wrong
path, a wrong host, a wrong file - and the Rust command layer is the actual trust
boundary that has to hold regardless of what the frontend sends. Everything below is
defense-in-depth against that scenario, not just correctness plumbing.

### Path safety

`src-tauri/src/utils/path.rs` is the shared foundation: `sanitize_relative_path_strict`
rejects absolute paths and `..` parent segments in any relative path coming from the
database or IPC, and `ensure_existing_path_inside_dir` /
`ensure_path_parent_inside_dir` canonicalize both the target and the base directory and
require the target to be a `starts_with` descendant of the base *after* canonicalization -
so a symlink or a `..`-laden path can't walk a write or delete outside the intended
directory. Every command that reads or writes inside the library directory or the app's
cache/log directories goes through these helpers rather than joining strings by hand.

On top of that, `src-tauri/src/services/library_guard.rs` never trusts a `library_path`
argument received over IPC on its own: `ensure_configured_library_path` re-derives the
library directory from the persisted `app_settings` row and rejects any request whose
path does not canonicalize to the same location - comparing canonical paths (not string
prefixes) so a sibling directory like `library-evil` next to `library` can never be
mistaken for it. This is what stops a compromised frontend from redirecting a delete/move
operation at an arbitrary directory by simply passing a different `library_path`.

### The yt-dlp host allow-list and argument separator

`src-tauri/src/services/yt_dlp_url.rs` restricts every URL handed to yt-dlp to an
`http`/`https` URL whose host is `youtube.com`, `youtube-nocookie.com`, `youtu.be`, or a
subdomain of one of those - rejecting look-alike hosts (`youtube.com.evil.com`,
`notyoutube.com`, userinfo tricks like `youtube.com@evil.com`). This matters because
yt-dlp can be run with `--cookies-from-browser`, i.e. with access to the user's real
browser cookies; without the host check, a compromised frontend could point yt-dlp (and
those cookies) at an arbitrary site. The app only ever needs YouTube, so this closes the
gap without losing functionality.

Every yt-dlp invocation also places a literal `--` separator before the URL argument
(see `services/yt_dlp_download.rs`), so the URL can never be reinterpreted as a
command-line flag by yt-dlp itself - defense-in-depth on top of the scheme/host check,
not a substitute for it. Binaries are always invoked via `std::process::Command`/
`tokio::process::Command` with an argument array, never a shell string, so there is no
shell-interpolation step for injection to exploit in the first place.

The optional cookies-file path (`--cookies <path>`) is similarly restricted: only an
existing `.txt` file is accepted (`services/yt_dlp_cookies.rs::normalize_cookies_path`),
mirroring the file picker's own filter, and the resolved path is redacted before it is
ever shown in the in-app terminal preview.

### External binary resolution (no working-directory hijack)

`services/binaries.rs` resolves `yt-dlp`/`ffmpeg` by walking only the directories listed
in the `PATH` environment variable (honoring `PATHEXT` on Windows) - it never searches
the process's current working directory, unlike Windows' own `where.exe`. This matters
because the app is not code-signed (see below) and could otherwise be tricked into
launching a malicious `yt-dlp.exe`/`ffmpeg.exe` planted next to a downloaded file if
directory search order included the CWD. See the README's Troubleshooting section for
the (documented, opt-in) fallback to a `tools/` folder inside the app data directory.

### Asset-protocol scope

The webview loads local files (video/audio/thumbnails) through Tauri's `asset:` protocol
plus `convertFileSrc`, which only serves files inside directories/files explicitly
"allowed" in the asset-protocol scope (`tauri.conf.json`'s `assetProtocol.scope` starts
empty). Two commands populate that scope at runtime, and both are careful about what they
grant, because the scope plus `convertFileSrc` is effectively an arbitrary local-file-read
primitive if it is ever widened too far:

- `register_library_asset_scope` (`commands/security.rs`) authorizes the *library*
  directory, but only after `ensure_configured_library_path` confirms the requested path
  matches the persisted settings (the same check described above) - so a compromised
  frontend cannot widen the scope to an arbitrary directory.
- `allow_asset_file` authorizes exactly one file (never its containing directory) for the
  manual-thumbnail-preview flow, and only after confirming it is an existing regular file
  with an allowed image extension.

The app's cache directory (for temporary thumbnail previews) is authorized once, in
`lib.rs`'s `setup()`, since it never contains anything but app-generated temp files.

### Updater

The updater (`tauri-plugin-updater`) checks a fixed HTTPS endpoint on GitHub
(`https://github.com/eduardoghi/kavynex/releases/latest/download/latest.json`,
`tauri.conf.json`), only when the user opens Settings and explicitly asks it to check -
there is no automatic/background check. Downloaded update artifacts are verified against
a minisign public key embedded in `tauri.conf.json` before being installed; the matching
private key is held by the release workflow's GitHub secrets and never checked into the
repository.

### Installers are unsigned by design

Kavynex's installers (the `.exe`/`.msi` on Windows, the `.dmg` on macOS, the
`.AppImage`/`.deb`/`.rpm` on Linux) are **not code-signed**. This is a deliberate,
accepted tradeoff for a solo-maintained, MIT-licensed project - a code-signing
certificate is a recurring cost that is hard to justify here. In practice this means:

- Windows SmartScreen and macOS Gatekeeper will warn on first run; this is expected and
  is not evidence of tampering.
- Release integrity for a manually downloaded installer is instead provided by
  `SHA256SUMS.txt`, published alongside every release (`.github/workflows/release.yml`'s
  `checksums` job) - compare the hash of what you downloaded against that file.
- The updater path (in-app update, once installed) does not rely on installer signing at
  all; it relies on the minisign signature described above, which is independent of OS
  code-signing.

### Build provenance

Every released installer also carries a build provenance attestation
(`.github/workflows/release.yml`, `actions/attest-build-provenance`): a signed, keyless
(Sigstore) statement that those exact bytes were built by this repository's release workflow,
from a specific commit. It complements the other two controls rather than replacing them -
`SHA256SUMS.txt` only proves a download was not corrupted, and the minisign signature proves
the *update* artifact was signed by the key holder, whereas provenance ties an *installer* back
to the source and CI run that produced it. It is independent of OS code-signing and needs no
certificate.

To verify a downloaded installer, with the [GitHub CLI](https://cli.github.com/) installed:

```
gh attestation verify <installer-file> --repo eduardoghi/kavynex
```

A successful check confirms the file was built by this repository's release workflow.

## Reporting a vulnerability

If you find a security issue, please open a
[private GitHub security advisory](https://github.com/eduardoghi/kavynex/security/advisories/new)
on this repository rather than a public issue. If that is not workable, contact the
maintainer directly through their GitHub profile. As a single-maintainer project there is
no formal SLA, but security reports are prioritized over other work.
