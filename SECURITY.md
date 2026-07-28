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

A third rule cuts across both, and is stated here as a rule rather than left to be inferred from
the places it appears: **every command that accepts a path from the caller refuses a UNC / network
location before any filesystem call touches it.** The reason is specific to Windows and easy to
miss - merely stat'ing or canonicalizing `\\host\share` makes the OS authenticate to `host` over
SMB, handing the user's NTLM hash to whoever controls it. So the refusal has to come *first*, ahead
of the `exists()`/`is_file()`/`canonicalize()` that would otherwise pay the cost the check exists to
avoid. `utils/path.rs::is_network_path` is the shared predicate (it normalizes separators, so the
mixed spellings Windows still resolves to a share - `/\host\share`, `\/host\share` - cannot slip
past a literal prefix match), and the commands applying it are
`library::resolve_path_inside_library` (reveal in file manager),
`thumbnail_temp::validate_source_media_path` (the FFmpeg preview source),
`library_media::import_media_file_sync` (the import source),
`library_guard::paths_refer_to_same_location` (a network path aimed at a local library),
`yt_dlp_cookies::normalize_cookies_path` (the `--cookies` file) and
`commands/database.rs::prepare_import_source` (the database import source). A library or a cookies
file the user deliberately keeps on a share is not blocked from *existing* - only from being
reached through a path the renderer supplies; copy it locally and the flow works. When a new
command takes a caller-supplied path, this is the list it joins.

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
  output lands inside the managed tree. The *source* path, though, is deliberately
  caller-supplied (the pre-import preview and import have to reach a file the user picked
  anywhere on disk, before it is in the library), which carries one residual worth stating:
  `generate_temporary_thumbnail` runs FFmpeg on that source and writes a single preview
  frame into the app cache directory, which is authorized in the asset scope - so a
  compromised frontend could drive it, path by path, to disclose one still frame (or the
  embedded cover art) of any media-extension file on disk, never one the user selected. It
  is disclosure only - never a write outside the managed tree, an arbitrary-file *content*
  read of a non-media file, or code execution - and it is bounded further: the source is
  rejected up front if it is a UNC/network location
  (`services/thumbnail_temp.rs::validate_source_media_path`), closing the NTLM-leak
  escalation the same way `open_path_in_system` does. Scoping the source to the library is
  not possible without breaking the preview, so this is recorded as an accepted residual in
  the same spirit as the file-existence oracle below.
- `export_database` - the destination is **extension-gated** to `.db`/`.sqlite`/
  `.sqlite3` (`commands/database.rs::validate_export_destination`) so the exported
  database cannot be written over an arbitrary file such as a document or a key, and it is
  additionally **refused if it resolves inside the app's own config directory**
  (`destination_is_inside_dir`), where the live `kavynex.db` and every backup generation live -
  those share the `.db` extension, so without this a save aimed there could clobber the live
  database or a recovery snapshot. The destination is otherwise caller-chosen (the backend cannot
  see the save dialog, and the pick-then-confirm import UX depends on the dialog staying on the
  frontend); overwriting *another* app's `.db`/`.sqlite` file remains the accepted, documented
  residual of that tradeoff.
- `import_database` - the mirror image of the export gate, on the way in
  (`commands/database.rs::prepare_import_source`). The source is **extension-gated** to the same
  `.db`/`.sqlite`/`.sqlite3` list the export uses (one shared `DATABASE_FILE_EXTENSIONS`, so the
  two directions cannot drift), and a **network location is refused outright** - `stage_database_import`
  stats and then opens this path, and on Windows the stat alone authenticates to the host over SMB
  (see `open_path_in_system` below for the same escalation). Importing a database off a share still
  works; it has to be copied locally first, which the staging copy does anyway. The extension gate is
  not a boundary on its own - the source is only ever read, and `validate_import_source` still has to
  recognize it as a kavynex database - but it turns a mistyped or hostile path into a clear refusal
  rather than an "is this a valid SQLite file?" probe of any path on disk. The gate lives on the
  command rather than in `stage_database_import` because the undo path
  (`stage_database_import_undo`) reuses that function with the `.pre-import` snapshot, whose
  extension it would reject; that source is written by the backend and never comes from IPC.
- `open_path_in_system` - spawns the OS file manager on the resolved path. Because it
  takes both `path` and `library_path` from the caller, its containment check alone cannot
  be trusted (a caller can pass the same value as both). Two things follow from that, and
  each is handled where it has to be:
  - A UNC / network path (`\\host\share`): merely resolving one on Windows triggers an
    SMB/NTLM authentication handshake, leaking the user's NTLM hash to `host`.
    `services/library.rs::resolve_path_inside_library` therefore rejects network paths
    outright, *before* any `canonicalize` call can reach out over SMB. A library kept on a
    network share loses only the "reveal in file manager" convenience as a result.
  - On macOS, the command always uses `open -R` (reveal) and never a bare `open`. A `.app`
    bundle is a directory, so passing one to a bare `open` *launches* the application rather
    than showing it - and with both arguments caller-supplied, containment does not rule that
    out (`/Applications` as both `path` and `library_path` contains every installed app).
    `-R` reveals files and directories alike, so revealing unconditionally costs nothing and
    keeps the command's worst case at "a Finder window opened somewhere unexpected".

##### Accepted residual: these commands are a file-existence oracle

What the constraints above bound is *blast radius* (no write outside the managed tree, no
file-content read, no SMB reach-out), not the fact that a caller-supplied `path`/`library_path`
pair is honored at all. Because both arguments come from the caller, a compromised renderer can
still learn things it should not from the *outcome* of these read-only commands: `open_path_in_system`
returns `MEDIA_FILE_NOT_FOUND` for an absent path and a different code otherwise, and
`get_library_summary` / `check_library_integrity` succeed with metadata only when the given directory
exists - so any of the three can be driven, path by path, as an oracle for whether an arbitrary
absolute path exists on the machine (and, for the two summary/integrity commands, the filenames under
the four managed subfolders of any directory named). It is disclosure only - never a write, a
file-content read, or code execution - and the NTLM/`.app`-launch escalations that would make it
worse are closed above.

This one is not closed, on purpose: the whole reason these commands take a caller path is to
preview or reveal a *candidate* folder before it is persisted - onboarding, and the change-library
flow, both act on a directory that is not (yet) the configured library, so routing them through
`library_guard` would break the feature the exception exists for. There is no backend signal that
separates "the user picked this folder in the dialog" from "the renderer invoked this directly," so
the oracle is inherent to supporting the preview at all. It is recorded here as an accepted residual
rather than left implicit, in the same spirit as the export-overwrite and updater-rollback residuals
above.

##### Accepted residual: a move-import hashes the source once

`import_media_file` in move mode hashes the source file up front and reuses that hash through
the duplicate check, so when the destination already holds identical content the source is
deleted based on a hash computed slightly earlier
(`services/filesystem.rs::move_or_copy_file_with_known_source_hash`). A writer that changes the
source to different same-size content inside that in-process window would see the changed file
deleted as an "already-imported duplicate". No such concurrent writer exists in the app's
single-user desktop model - the import is user-triggered on a file the user just picked - and
re-hashing immediately before the delete would only narrow, not close, the window (the classic
TOCTOU shape). Recorded as an accepted residual rather than left implicit.

##### Accepted residual: unreferenced-artifact cleanup is not atomic against a concurrent creation

`cleanup_unreferenced_media_artifacts` reference-counts each artifact path against the database and
then unlinks the files nothing points at (`services/library_cleanup.rs`). Folding that count and the
unlink into one backend call closed the multi-round-trip race the frontend used to have, but the two
steps are still not atomic against a *concurrent* media creation that resolves to the same
content-addressed path. A wrapping transaction cannot help - the unlink necessarily happens after
any commit, since the filesystem cannot join a SQLite transaction - so only a lock keyed by artifact
path, held across both the count and the unlink and taken by `insert_media` too, would close it.

That lock is deliberately not built. There are exactly two callers, and each is kept out of the
window by a different mechanism:

- The **manual/Diagnostics path** (`cleanup_unreferenced_media_artifacts`, and the failure path of an
  add-media run) needs two creations in flight at once resolving to the same path, and the add-media
  modal is locked for the duration of one (`isModalLocked` covers the whole run), so a second cannot
  start. This is the one guarantee in this document that rests on frontend behavior rather than on the
  Rust layer alone, so a later change to that locking - a queue, a batch import, a background
  re-download, or a compromised renderer firing `insert_media` /
  `cleanup_unreferenced_media_artifacts` directly - reopens it.
- The **startup sweep** (`services/pending_media.rs`, which hands a crashed creation's artifacts to
  the same cleanup) is a backend caller and is *not* covered by that modal lock, so it carries its own
  guard instead. Reference-counting cannot tell a creation that died before its row from one that has
  simply not reached `insert_media` yet, so the sweep refuses any marker that is either registered as
  in flight by this process or whose mtime is not older than the process itself
  (`pending_media::marker_is_sweepable`). Without that, a creation running while the sweep fires would
  have the file it just wrote unlinked and its marker deleted, leaving the row that lands moments
  later pointing at nothing with nothing left to reconcile it. Every uncertain input to that decision
  (an unreadable mtime, a same-tick write, a clock that moved backwards between runs) answers "leave
  it alone", since refusing only defers a leftover by one launch while acting wrongly deletes a file
  the user still wants.

It is called out here, against the rest of the document's "the Rust layer holds regardless of what the
frontend sends" posture, so the exception and the asymmetry between the two callers are explicit rather
than living only in the `plan_unreferenced_artifacts` code comment.

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
(the argv builder in `services/yt_dlp_download/command.rs`, and `services/yt_dlp_metadata.rs`
for the metadata calls), so the URL can never be reinterpreted as a
command-line flag by yt-dlp itself - defense-in-depth on top of the scheme/host check,
not a substitute for it. Binaries are always invoked via `std::process::Command`/
`tokio::process::Command` with an argument array, never a shell string, so there is no
shell-interpolation step for injection to exploit in the first place.

The optional cookies-file path (`--cookies <path>`) is similarly restricted: only an
existing, non-network `.txt` file is accepted (`services/yt_dlp_cookies.rs::normalize_cookies_path`),
mirroring the file picker's own filter, and the resolved path is redacted before it is
ever shown in the in-app terminal preview. The network-path refusal has to come *before* the
`is_file()` check rather than after it: stat'ing a UNC share is itself what makes Windows
authenticate to that host over SMB and leak the user's NTLM hash, so a check that ran later
would already have paid the cost it exists to avoid. This is the same guard, closing the same
escalation, as `library::resolve_path_inside_library` and
`thumbnail_temp::validate_source_media_path`; a cookies file kept on a share loses only the
ability to be pointed at directly. An invalid value is dropped rather than raised as an error,
matching how this function treats every other rejection - the run simply proceeds without
cookies (or falls back to `--cookies-from-browser`).

### Outbound image fetches (thumbnails and channel avatars)

Downloading a thumbnail is the one place the backend makes an HTTP request of its own rather than
delegating to yt-dlp, so it carries its own set of controls
(`services/thumbnail_download.rs`). `download_thumbnail_from_url` takes two paths depending on the
URL, and **both gate the host**:

- A URL whose *path* ends in an image extension is fetched directly, and is restricted to the
  image CDNs YouTube actually serves thumbnails from (`ALLOWED_THUMBNAIL_IMAGE_HOSTS`:
  `ytimg.com`, `ggpht.com`, `googleusercontent.com`, `youtube.com`, each suffix-matched on a
  leading `.` so a look-alike like `ytimg.com.evil.example` is refused). That list is a copy of the
  CSP's `img-src` hosts and is pinned against it by a test, on the principle that the backend
  should only fetch an image the webview would be permitted to render. Note this is deliberately
  *not* the yt-dlp allow-list below: real thumbnails live on ytimg/ggpht/googleusercontent, none of
  which is a `youtube.com` host, so reusing that list would reject every legitimate thumbnail.
- Any other URL falls through to yt-dlp's generic extractor, which is restricted to YouTube by
  `is_allowed_youtube_url` - the same allow-list, for the same reason, as every other yt-dlp
  invocation: the extractor runs with access to the user's browser cookies.

The direct fetch is additionally constrained on the way back: a hard 10 MiB cap, an allow-listed
`Content-Type`, and a magic-byte sniff (the header is attacker-controlled, so it is only a first
filter). It follows redirects **manually**, re-running the address check on every hop, and dials
through a DNS resolver that drops every private/loopback/reserved answer
(`services::ssrf_guard`, `PublicOnlyResolver`) - so the address that is validated is the address
that is dialed, closing the rebinding window a pre-connection check alone leaves open. This is why
the module uses a hand-rolled hyper client rather than the `reqwest` already in the tree: automatic
redirect following would bypass the per-hop revalidation.

Worth stating plainly, because the two halves once differed: the host gate on the direct branch was
added after the fallback already had one. Until then the SSRF guard kept that branch off internal
addresses but nothing kept it off the open internet, which left a compromised frontend an outbound
channel (a path ending in `.jpg` on a host of its choosing). It cost no functionality to close - the
manual thumbnail control is a file picker, never a URL field, and the only remote value that reaches
the command is yt-dlp's own `thumbnail` metadata.

### External binary resolution (no working-directory hijack)

`services/binaries.rs` resolves `yt-dlp`/`ffmpeg` by walking only the directories listed
in the `PATH` environment variable (honoring `PATHEXT` on Windows) - it never searches
the process's current working directory, unlike Windows' own `where.exe`. This matters
because the app is not code-signed (see below) and could otherwise be tricked into
launching a malicious `yt-dlp.exe`/`ffmpeg.exe` planted next to a downloaded file if
directory search order included the CWD. See the README's Troubleshooting section for
the (documented, opt-in) fallback to a `tools/` folder inside the app data directory.

On Windows the `PATHEXT` expansion additionally **skips `.bat`/`.cmd` shims**: launching a
batch file routes through `cmd.exe`, which re-parses the command line and historically reopened
argument injection (CVE-2024-24576, "BatBadBut") even when the process is spawned as an argv array.
The pinned Rust toolchain (`rust-toolchain.toml`) already carries the compiler-side fix, but yt-dlp
and ffmpeg both ship as real executables, so a batch shim on `PATH` is refused outright rather than
resting the guarantee on the compiler version holding across every build. A real `.exe`/`.com`
alongside the shim still resolves; a lone shim resolves to nothing and surfaces the normal
"not found" guidance.

### Capabilities: what the renderer is allowed to call at all

Before any of the checks below apply, Tauri's ACL decides which *plugin* commands the webview
may invoke in the first place (`src-tauri/capabilities/`). Commands this app defines itself are
not gated there - a `#[tauri::command]` is reachable from the window it is registered for, which
is exactly why the Rust command layer, not the ACL, is the trust boundary this document is about.
What the ACL does bound is the surface Tauri and its plugins add on top.

That surface is granted as the exact list the app uses, not a preset:

- `core:app:allow-version` - `getVersion`, for the version shown in Settings.
- `core:event:allow-listen` / `core:event:allow-unlisten` - `listen`, for the yt-dlp progress and
  database-integrity events the backend emits.
- `opener:allow-open-url`, scoped to the three YouTube hosts; `dialog:allow-open` /
  `dialog:allow-save`; and, in `desktop.json`, `updater:default` and `process:allow-restart`.

`convertFileSrc` and `Channel` appear in no grant because they need none: the first builds a URL
string in the renderer, and the second is part of the IPC mechanism rather than a command. What
serves an `asset:` URL is the scope described below, not a permission.

The list started as the scaffolded `core:default` and stayed that way through four rounds of
capability hardening, because each of those rounds was framed as narrowing *plugin* permissions
(the opener's URL scope, dropping `reveal_item_in_dir`, replacing `dialog:default` and
`process:default` with the commands actually called) and `core:*` never came into view.
`core:default` is a set of sets: it expands to nine `core:<area>:default` sets and, on the pinned
Tauri, to 92 individual `allow-*` permissions - the whole of `core:window` (28), `core:menu` (22),
`core:tray` (12), `core:path` (8), `core:image` (5), `core:webview` (4) and more. None of it was
reachable from the two seam modules, so a renderer that had been compromised could move, resize
or enumerate windows, and resolve arbitrary paths, purely because a template said so.

The seam rule is what makes this auditable rather than a guess: `src/lib/tauri-client.ts` and
`src/lib/tauri-platform.ts` are the only files permitted to import `@tauri-apps` (enforced by
`eslint.config.js`), so the used surface is a two-file read. When a new Tauri API is added there,
its permission belongs in this list - and the failure mode if it is forgotten is loud and
immediate (the call rejects with a permission error), unlike the silent over-grant it replaces.

One trap worth naming, since it is the one case where the tight list could bite: the `Update`
object returned by the updater plugin extends `Resource`, and calling `.close()` on it would
invoke `plugin:resources|close`, which is **not** granted. Nothing calls it today - the flow is
`check()` then `downloadAndInstall()` then `relaunch()`, and the plugin closes the handle on the
Rust side - so adding `core:resources:allow-close` now would be granting an unused permission.
Add it if and when a `.close()` call appears.

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

One property of the scope itself is worth stating, because it differs from how containment is
decided everywhere else in this document: Tauri matches a request against the scope's **glob
patterns over the requested path string**, without canonicalizing it first. Every other containment
check here resolves symlinks and compares canonical paths
(`ensure_existing_path_inside_dir`, `library_guard`), so this is the one place the decision is
purely lexical. The practical consequence is that a symlink planted inside one of the four managed
subdirectories, pointing outside the library, would be served through `convertFileSrc`. That is
recorded rather than fixed because reaching it already requires write access to the user's library
folder, at which point an attacker has better options than reading a file back through the webview -
and because the paths the app itself serves are content-addressed names taken from the database,
never a name a symlink would carry. It matters if the scope is ever widened to a directory the user
did not choose, which is exactly what `register_library_asset_scope`'s settings cross-check and the
managed-subdirectory restriction above are there to prevent.

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

#### The one relaxed directive: `style-src 'unsafe-inline'`

Every other directive in the CSP is strict, so this one is worth stating rather than leaving to be
noticed. Mantine styles components at runtime: it sets inline `style` attributes (per-component
CSS variables, positioning for overlays/popovers) and injects `<style>` elements for its runtime
styles, both of which a strict `style-src` blocks. Removing the token does not harden the app, it
renders it unusable.

What keeps the cost low is that it is `style-src` and not `script-src`. `script-src` is not relaxed
- it inherits `default-src 'self'`, so no inline script runs, and `object-src 'none'`, `base-uri
'self'` and `frame-ancestors 'none'` close the usual ways around that. Injected CSS alone cannot
execute code; the realistic worst case is a styling/exfiltration trick, and that needs an injection
sink to begin with. There is none: YouTube-derived text (titles, comments, chat, author names) is
rendered as React children, never through `dangerouslySetInnerHTML` or `eval`, which is the same
property the threat model above rests on.

So the honest statement of the tradeoff is: this token is load-bearing for the UI framework, and the
thing that makes it acceptable is the absence of an injection sink rather than the token itself
being harmless. A future change that introduces raw-HTML rendering would have to revisit it.

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
`docs/RELEASING.md`), the endpoint is a fixed HTTPS URL under an account protected by the repository's
own access controls, and published release assets are never rewritten in the normal flow - the
`checksums` job only *adds* `SHA256SUMS.txt`. Rotating the minisign key does **not** address this
one (the old artifacts stay validly signed under the old key); the mitigations that matter are the
GitHub account controls and not tampering with an already-published release. It is recorded here
rather than left implicit because "the update is signed" reads as stronger than it is.

#### Windows install mode and automatic relaunch

On Windows the updater runs the downloaded installer in `passive` mode (`installMode`,
`tauri.conf.json`): the NSIS installer shows a minimal progress bar and proceeds without a wizard
click, and once it finishes the app calls `relaunch()` itself (`src/services/app-update-service.ts`).
So the full sequence - signature-verified download, install, restart - completes from the single
click the user makes on "Download and install update"; there is no second "install now?" prompt in
between. This is deliberate rather than an oversight. The trust decision has already been made by
then: the artifact's minisign signature is verified before the installer runs (see above), so the
bytes being installed are the key holder's, and a second confirmation would gate a step that is
already cryptographically gated. `passive` (rather than the fully silent `quiet`) is chosen so the
install still shows progress and cannot run entirely invisibly, and the update path is only ever
entered from an explicit user action - never a background auto-install (the optional startup check
only *surfaces a notice*, it does not download or install). It is recorded here because every other
security-relevant default in Kavynex has its reasoning written down, and "installs and relaunches
from one click" is the kind of behavior a reviewer should find explained rather than infer.

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
v1.1.1 shipped (the `checksums` job and `actions/attest-build-provenance` respectively), so
**v1.2.0 is the first release carrying either**. On v1.1.1 and earlier, `gh attestation verify`
reports *no attestation* for an installer rather than a failed check. The minisign signature on
the updater artifacts predates both and applies to every release. This is recorded rather than
quietly implied, because "verify the hash" is useless advice if the file it names is not there.

Both were exercised against v1.2.0 after it was published: the published `SHA256SUMS.txt` matches
a freshly downloaded installer, and `gh attestation verify` on that installer resolves to this
repository's `release.yml` at the commit the release was built from.

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

### Software Bill of Materials (SBOM)

Every release also publishes a CycloneDX SBOM (`kavynex_<version>_sbom.cdx.json`,
`.github/workflows/release.yml`'s `sbom` job) of the Rust dependency tree that goes into the
shipped binary. It is generated with `cargo-cyclonedx` from the committed `Cargo.lock`, so it lists
the exact crate versions a given release contains - the machine-readable answer to "does this
release ship crate X at version Y?" when an advisory lands after the fact, without recompiling or
walking the dependency graph by hand. Its hash is part of `SHA256SUMS.txt` and its presence is
enforced by the `checksums` job's asset-completeness check, so a release missing it fails loudly
rather than shipping silently.

The SBOM covers the *native* dependency tree only. The frontend's build-time npm tree is bundled
into the webview assets rather than being a runtime dependency of the binary, and is already
advisory- and license-gated (`frontend-audit` job, `scripts/check-js-advisories.js` /
`scripts/check-js-licenses.js`) and pinned in `pnpm-lock.yaml`. Like `SHA256SUMS.txt` and the
provenance attestation, the SBOM applies from v1.2.0 onward, not retroactively (see "When these
three controls started applying" above).

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

One asymmetry is worth stating plainly: the `minimumReleaseAge` cooling-off (refuse a package
published in the last two days, so a freshly-compromised release is not picked up before the
community flags it) applies **only to the npm tree**. The Cargo tree has no equivalent - `cargo-deny`
restricts the *source* (crates.io only), the license and duplicate/wildcard bans, not the *publish
age* - so a newly-published malicious version of an already-allowed crate is a residual gap on the
Rust side. What limits it there is the pinned `Cargo.lock` (a bump is a reviewed, deliberate commit,
never an automatic resolution) plus the same draft-and-publish-by-hand release flow.

## Reporting a vulnerability

If you find a security issue, please open a
[private GitHub security advisory](https://github.com/eduardoghi/kavynex/security/advisories/new)
on this repository rather than a public issue. If that is not workable, contact the
maintainer directly through their GitHub profile. As a single-maintainer project there is
no formal SLA, but security reports are prioritized over other work.
