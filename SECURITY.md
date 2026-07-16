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

#### Commands that intentionally take a caller-supplied path

A handful of commands deliberately do *not* go through `library_guard`, because they are
used by the onboarding/settings UI to preview or act on a *candidate* library folder
before it is persisted (at which point there is no configured library to re-derive from).
These are a conscious exception, not an oversight, and each is constrained so the "the
renderer is compromised and sends a hostile path" case has limited blast radius:

- `get_library_summary`, `check_library_integrity` - **read-only**: they only read
  directory metadata / compare it against caller-supplied path lists. Worst case is
  narrow information disclosure (filenames under the four managed subfolders of the given
  directory), never a write or a file-content read.
- `import_media_file`, `generate_temporary_thumbnail` - **writes are content-addressed
  and extension-gated**: the destination filename is derived from the file's own SHA-256
  and an allowed media/image extension, so a hostile source path cannot choose where the
  output lands inside the managed tree.
- `export_database` - the destination is **extension-gated** to `.db`/`.sqlite`/
  `.sqlite3` (`commands/database.rs::validate_export_destination`) so the exported
  database cannot be written over an arbitrary file such as a document or a key. It is
  otherwise caller-chosen (the backend cannot see the save dialog); this is an accepted,
  documented tradeoff.
- `open_path_in_system` - spawns the OS file manager on the resolved path. Because it
  takes both `path` and `library_path` from the caller, its containment check alone cannot
  be trusted (a caller can pass the same value as both). The real risk there is a UNC /
  network path (`\\host\share`): merely resolving one on Windows triggers an SMB/NTLM
  authentication handshake, leaking the user's NTLM hash to `host`. `services/library.rs::
  resolve_path_inside_library` therefore rejects network paths outright, *before* any
  `canonicalize` call can reach out over SMB. A library kept on a network share loses only
  the "reveal in file manager" convenience as a result.

The security boundary these share is the same one this whole document is about: the Rust
command layer holds regardless of what the frontend sends. React's default escaping (see
above) is what keeps the renderer from being compromised in the first place; these
constraints are the defense-in-depth for if it ever were.

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

The scope decides *which files* may be served; the CSP decides *whether the webview may fetch
them at all*, and the two must agree. `tauri.conf.json`'s `img-src`/`media-src` therefore name
both `asset:` and `http://asset.localhost`: those are not two capabilities but one, spelled the
way each platform needs. Tauri's `convertFileSrc` returns `asset://localhost/<path>` everywhere
except Windows, which gets `http://asset.localhost/<path>`, and neither is covered by `'self'`
(the document is served from `http://tauri.localhost`). Dropping either token does not tighten
anything - it silently breaks every thumbnail and every video on the platforms that use that
form. Nothing in the normal loop catches it: `pnpm tauri dev` serves the page from the Vite
origin, where no CSP header is injected, so only a packaged build exercises this. That is why
`src/lib/tauri-platform.test.ts` pins both tokens.

### Updater

The updater (`tauri-plugin-updater`) checks a fixed HTTPS endpoint on GitHub
(`https://github.com/eduardoghi/kavynex/releases/latest/download/latest.json`,
`tauri.conf.json`). By default this happens only when the user opens Settings and explicitly
asks it to check - there is no automatic/background check. A single passive check on startup
is available as an **opt-in** setting (Settings > Application update,
`check_updates_on_startup`), off by default, so the app contacts the endpoint on launch only
after the user turns it on; when it does, an available update is surfaced as a non-intrusive
notice, never auto-downloaded. Downloaded update artifacts are verified against a minisign
public key embedded in `tauri.conf.json` before being installed; the matching private key is
held by the release workflow's GitHub secrets and never checked into the repository.

#### Accepted risk: the updater can be rolled back to an older signed release

The minisign signature covers the *bytes of each update artifact*, not the `latest.json` that
names which version is current. `latest.json` carries the version string and the artifact URL,
and the client only compares that version against the installed one - it has no notion of a
monotonic release counter or a signed timestamp (the `tauri-plugin-updater` protocol has no TUF-
style freeze/rollback protection). So an attacker who can *write to the GitHub release* - which
is a weaker capability than holding the minisign private key, since release assets stay editable
after publication - could repoint `latest.json` at an **older, already-signed** artifact from a
previous release while advertising a higher version number. Every already-published artifact keeps
a valid signature forever, so the client would accept it and effectively downgrade the app to a
prior (possibly vulnerable) version. The signature check is not bypassed here; it is simply not a
freshness check.

This is a structural limitation of the updater protocol rather than a defect in Kavynex, and a
full fix (a signed version counter, or TUF metadata) is disproportionate for a solo project. What
reduces the exposure: the release is always created as a draft and published by hand (`release.yml`,
`CONTRIBUTING.md`), the endpoint is a fixed HTTPS URL under an account protected by the repository's
own access controls, and published release assets are never rewritten in the normal flow - the
`checksums` job only *adds* `SHA256SUMS.txt`. Rotating the minisign key does **not** address this
one (the old artifacts stay validly signed under the old key); the mitigations that matter are the
GitHub account controls and not tampering with an already-published release. It is recorded here
rather than left implicit because "the update is signed" reads as stronger than it is.

### Installers are unsigned by design

Kavynex's installers (the `.exe`/`.msi` on Windows, the `.dmg` on macOS, the
`.AppImage`/`.deb`/`.rpm` on Linux) are **not code-signed**. This is a deliberate,
accepted tradeoff for a solo-maintained, MIT-licensed project - a code-signing
certificate is a recurring cost that is hard to justify here. In practice this means:

- Windows SmartScreen and macOS Gatekeeper will warn on first run; this is expected and
  is not evidence of tampering.
- *Download* integrity for a manually downloaded installer is provided by `SHA256SUMS.txt`,
  published alongside the installers (`.github/workflows/release.yml`'s `checksums` job) -
  compare the hash of what you downloaded against that file. Note what this does and does
  not prove: the `checksums` job hashes the assets already attached to the release, so the
  file tells you your copy matches what the release page serves (it catches a truncated or
  corrupted download), not that those assets are what the build produced. Tying an installer
  back to the source and the CI run that built it is what the build provenance below is for.
- The updater path (in-app update, once installed) does not rely on installer signing at
  all; it relies on the minisign signature described above, which is independent of OS
  code-signing.

### When these three controls started applying

`SHA256SUMS.txt` and the provenance attestation were both added to the release workflow after
v1.1.1 shipped (the `checksums` job and `actions/attest-build-provenance` respectively), so no
release published before them carries either, and `gh attestation verify` reports *no
attestation* for those installers rather than a failed check. The minisign signature on the
updater artifacts predates both and applies to every release. This section is what the next
release onward looks like; it is recorded here rather than quietly implied, because "verify the
hash" is useless advice if the file it names is not there.

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

### Accepted risk: the signing key is present while dependencies build

The release workflow's build step (`.github/workflows/release.yml`, `tauri-apps/tauri-action`)
runs `cargo build` and signs the resulting artifacts in one invocation, so
`TAURI_SIGNING_PRIVATE_KEY` and a `contents: write` `GITHUB_TOKEN` are in the environment while
the whole transitive Rust dependency tree compiles - including every crate's `build.rs`. A
compromised transitive dependency, or a compromised release of the action itself, could read
both during the compile phase, before any signing happens.

This is a known, accepted risk rather than an oversight, and it is structural: `tauri-action`
does not separate building from signing, so the two cannot be split into a job that holds the
secret and a job that does not. What is done about it:

- Every action is pinned to a full commit SHA, so a tag cannot be repointed at new code.
- The `permissions:` blocks are per-job; only the build job holds `contents: write` /
  `id-token: write`, and the dependency-audit job (which installs and runs `cargo-audit` /
  `cargo-deny`) is a separate job with no access to the signing secrets.
- The release build deliberately skips the Rust build cache that CI uses, so a poisoned cache
  entry cannot reach the job that holds the key.
- Releases are always created as drafts and published by hand, so a build is inspected before
  the updater endpoint can ever serve it.

The residual exposure is a malicious `build.rs` in a dependency the lockfile already pins,
reading the environment during a release build. `minimumReleaseAge` and `blockExoticSubdeps`
(`pnpm-workspace.yaml`) plus `cargo-deny`'s source allow-list are what reduce the chance of such
a dependency arriving in the first place; nothing in the current workflow removes the exposure
itself. Rotating the minisign key is the response if a compromise is ever suspected.

## Reporting a vulnerability

If you find a security issue, please open a
[private GitHub security advisory](https://github.com/eduardoghi/kavynex/security/advisories/new)
on this repository rather than a public issue. If that is not workable, contact the
maintainer directly through their GitHub profile. As a single-maintainer project there is
no formal SLA, but security reports are prioritized over other work.
