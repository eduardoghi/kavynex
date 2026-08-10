# Threat model

This document covers what Kavynex defends against **while it runs**: the IPC boundary, path
safety, the capabilities the renderer holds, the asset-protocol scope, the CSP, and how external
processes are invoked. Everything about *shipping* the app - the updater, signing, provenance and
the dependency supply chain - is in [`RELEASE-SECURITY.md`](RELEASE-SECURITY.md). To report a
vulnerability, see [`SECURITY.md`](../SECURITY.md).


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

## Path safety

`src-tauri/src/utils/path.rs` is the shared foundation: `sanitize_relative_path_strict`
rejects absolute paths and `..` parent segments in any relative path coming from the
database or IPC, and `ensure_existing_path_inside_dir` /
`ensure_path_parent_inside_dir` canonicalize both the target and the base directory and
require the target to be a `starts_with` descendant of the base *after* canonicalization -
so a symlink or a `..`-laden path can't walk a write or delete outside the intended
directory. Every command that reads or writes inside the library directory or the app's
cache/log directories goes through these helpers rather than joining strings by hand.

On top of that, `src-tauri/src/services/library/guard.rs` never trusts a `library_path`
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
past a literal prefix match), and the functions applying it are:

| Site | The path it gates |
|---|---|
| `library::resolve_path_inside_library` | reveal in file manager |
| `thumbnail::temp::validate_source_media_path` | the FFmpeg preview source |
| `thumbnail::temp::validate_temporary_thumbnail_delete_path` | the preview being discarded |
| `thumbnail::picked::validate_picked_thumbnail_path` | the image staged for a manual thumbnail |
| `library::media::import_media_file_cancellable_sync` | the import source |
| `library::guard::paths_refer_to_same_location` | a network path aimed at a local library |
| `yt_dlp::cookies::normalize_cookies_path` | the `--cookies` file |
| `commands/database.rs::prepare_import_source` | the database import source |
| `commands/database.rs::prepare_export_destination` | the database export destination |

A library or a cookies file the user deliberately keeps on a share is not blocked from *existing* -
only from being reached through a path the renderer supplies; copy it locally and the flow works.
When a new command takes a caller-supplied path, this is the list it joins.

**And joining it is enforced rather than remembered.** This table is what a review of a new command
is checked against, and keeping it in step with the code was left to discipline while the *command*
inventory next door already had a CI gate. That asymmetry was a real gap, not a tidy one: two sites
were wrong when an audit last looked. `thumbnail::picked::validate_picked_thumbnail_path` applied
the rule without appearing here at all, and `thumbnail::temp::validate_temporary_thumbnail_delete_path`
did not apply it - it called `exists()` straight on a path the renderer supplied, so the containment
check that follows refused the *delete* only after the SMB handshake had already been paid for.
Neither was visible to `scripts/verify-command-path-surface.js`, because both commands were, quite
correctly, in the inventory it did hold.

That script now holds both halves of the rule. Every `is_network_path` call in the backend has to
appear in this table, and every row here has to still exist in the code, so a guard added, removed
or renamed fails CI until the two agree. It is still not a claim that each site applies the *right*
guard - that needs the call chain, which the script deliberately does not try to follow - only that
the surface and its enforcement cannot drift apart silently again.

The export is the one entry where the refusal stops more than the NTLM leak. Everything else on
that list only *reads* through the supplied path; the export *writes the whole database* to it -
every channel, title, comment and stored local path - so a share there is an exfiltration primitive
reachable in one IPC call, not merely an authentication the user did not ask for. It went without
the check for a while after the import side gained it, which is why it is called out rather than
left to blend into the list.

**Two groups of commands deliberately do not apply the rule**, for different reasons. They are
enumerated rather than left implicit because this list is what a review of a new command is checked
against, and "everything not named above applies the rule" was the wrong reading to invite.

**`set_external_backup_dir`.** Its whole purpose is a copy of the database that survives a failure
of the volume the database lives on, and a NAS is the ordinary answer to that - the README's Privacy
section documents "another drive or a network share" as supported. So the SMB authentication is the
cost of the feature working at all rather than an oversight. What bounds it: the directory is
write-only (the mirror is never read back, and nothing serves it through the asset scope), it is
chosen through a folder dialog rather than derived from anything, and it is refused unless it
already exists as a directory outside the app config directory. Note also that
`mirror_database_to_external_dir` calls the `export_database` *service* function directly, so the
command-level refusal above does not reach the daily mirror - gating the export command costs this
feature nothing.

**The library-selection helpers: `ensure_directory_exists`, `resolve_existing_directory` and
`is_directory_empty`**, all reaching the filesystem through
`services/library/paths.rs::library_input_path`. These run on the *selection* path - onboarding and
the change-library flow both probe a candidate folder before it is persisted - and a library kept on
a share is a supported configuration, so refusing a UNC here would not harden anything, it would
remove the ability to choose such a library at all. The bound is what these three do rather than
where they point: two only read directory metadata, and the third creates an empty directory. The
NTLM exposure is real and accepted, narrowed by the path always coming from a folder dialog the user
drove rather than from an unattended caller redirecting a delete or a move. See the residual below
for what a compromised renderer can still do with them.

### Commands that intentionally take a caller-supplied path

A handful of commands deliberately do *not* go through `library::guard`, because the path they
act on is one no persisted setting can supply: a file the user picked anywhere on disk, or a
save/open destination chosen in a native dialog. These are a conscious exception, not an
oversight, and each is constrained so the "the renderer is compromised and sends a hostile path"
case has limited blast radius:

- `create_media` (via `source_value`), `generate_temporary_thumbnail` - **writes are content-addressed
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
  (`services/thumbnail/temp.rs::validate_source_media_path`), closing the NTLM-leak
  escalation the same way `open_path_in_system` does. Scoping the source to the library is
  not possible without breaking the preview, so this is recorded as an accepted residual in
  the same spirit as the file-existence oracle below.
- `export_database` - the destination is **extension-gated** to `.db`/`.sqlite`/
  `.sqlite3` (`commands/database.rs::validate_export_destination`) so the exported
  database cannot be written over an arbitrary file such as a document or a key, a
  **network location is refused outright** (`prepare_export_destination`, see the cross-cutting
  rule above - this is the direction where a share is an exfiltration of every row, not only an
  NTLM leak), and it is
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

### The three library-reading commands are guarded, and were not always

`get_library_summary`, `check_library_integrity` and `open_path_in_system` take a `library_path`
over IPC and verify it against the persisted setting
(`library::guard::ensure_configured_library_path_in_pool`), like every other command that takes
one. They are called out here because they used to be listed *above*, as a deliberate exception,
on the grounds that the onboarding and change-library flows needed them to act on a candidate
folder before it was persisted.

That premise did not hold. No caller ever passed a candidate: the settings modal and the
diagnostics summary both pass `settings.libraryPath` (the persisted value), and the
change-library flow (`src/use-cases/change-library-path.ts`) previews a candidate with
`ensure_directory_exists` / `is_directory_empty`, which are a different group with their own
residual below. The exception cost the project's central rule and bought nothing, so it is gone.

What it had cost, in order of severity:

- **`check_library_integrity` was a directory enumerator.** Its report carries up to five real
  filenames per category (`orphan_media_examples` and its siblings), gathered by walking
  `<library_path>/video`, `/audio`, `/thumbnails` and `/live_chat`. A trusted `library_path`
  therefore let a compromised renderer name files in any tree on disk holding one of those
  subdirectories. The names are worth reporting - Diagnostics exists to tell the user which of
  their own files are unreferenced - so the fix is the guard, not a poorer report.
- **`get_library_summary` disclosed directory sizes and counts** for any path.
- **`open_path_in_system`'s containment check was self-referential.**
  `resolve_path_inside_library` confines `path` to `library_path`, so a caller supplying both
  satisfied it trivially by passing the same directory as each. The guard is what makes that
  containment mean something.

Two platform-specific defenses inside `open_path_in_system` predate the guard and stay, because
defense in depth is the point and neither costs anything:

- A UNC / network path (`\\host\share`): merely resolving one on Windows triggers an
  SMB/NTLM authentication handshake, leaking the user's NTLM hash to `host`.
  `services/library/mod.rs::resolve_path_inside_library` rejects network paths outright, *before*
  any `canonicalize` call can reach out over SMB. A library kept on a network share loses only
  the "reveal in file manager" convenience as a result.
- On macOS, the command always uses `open -R` (reveal) and never a bare `open`. A `.app`
  bundle is a directory, so passing one to a bare `open` *launches* the application rather
  than showing it. `-R` reveals files and directories alike, so revealing unconditionally costs
  nothing and keeps the command's worst case at "a Finder window opened somewhere unexpected".

The guard also subsumes part of the cross-cutting UNC rule for the other two: a network
`library_path` aimed at a local configured library is refused by
`paths_refer_to_same_location` before anything is canonicalized. A genuinely network-hosted
library still resolves, which is the supported configuration.

Each command has an IPC-level test pinning the refusal
(`commands/library.rs::*_rejects_a_path_that_is_not_the_configured_library`), so the exception
cannot come back by accident.

#### The second file-manager command takes no path, which is why it needs no guard

`open_log_directory` (`commands/logging.rs`) reveals the app's log directory in the same file
manager, so the README's "attach the relevant lines when reporting a bug" does not start with the
user hunting for a per-OS path. It is in this document because it spawns the same thing
`open_path_in_system` does while satisfying none of the rules above - and the reason is that it has
nothing to satisfy them with. **It accepts no arguments.** The directory comes from
`app.path().app_log_dir()`, so there is no value a compromised renderer can supply and therefore
nothing to validate.

Reusing `open_path_in_system` was the obvious shortcut and is the one thing that must not be done
here. Its containment check confines `path` to `library_path`, so passing the log directory as both
would satisfy it trivially - the self-referential shape recorded above as the defect the settings
cross-check exists to close, not a pattern to reuse. The log directory is also not inside the
library, so there is no honest way to express it through that command at all.

The spawn itself is shared rather than copied: `services::file_manager` holds the file-manager
resolution (the PATH-only lookup described under "External binary resolution") and the per-platform
reveal, and its module comment states the contract this splits on - it reveals whatever canonical
path it is handed and decides nothing about whether that path is allowed. There are exactly two
callers, and each answers that question a different way: the library one guards a caller-supplied
path, this one accepts none. A third caller has to answer it too; neither existing answer
generalizes for free.

One rule it deliberately does not apply is the UNC refusal. That rule exists to stop a
*caller-supplied* path pointing at an attacker's host, and this path comes from the OS. A Windows
profile redirected onto a corporate share is a supported configuration where refusing would break
the feature for the user whose own share it is - the same reasoning as `set_external_backup_dir`
above.

#### Accepted residual: the library-selection helpers create and probe arbitrary directories

`ensure_directory_exists`, `resolve_existing_directory` and `is_directory_empty` are the group of
commands still acting on a caller-supplied path, and they are the ones easiest to miss: they read
as plumbing rather than as a boundary. They are also the group the candidate-folder argument
*actually* applies to, and the only one: onboarding and the change-library flow really do act
through them on a folder that is not yet the configured library, so there is nothing persisted to
re-derive from and no containment check that would not break the feature. (The three read
commands above were once justified the same way and should not have been; see that section.)

Two things follow, and both are accepted rather than closed:

- **They are a file-existence oracle.** All three answer, by succeeding or failing, whether an
  arbitrary absolute path exists and whether it is a directory; `is_directory_empty` additionally
  answers whether it holds anything. Disclosure only - never a write outside the directory named,
  a file-content read, or code execution. There is no backend signal separating "the user picked
  this folder in the dialog" from "the renderer invoked this directly," so the oracle is inherent
  to supporting the preview at all. It is recorded here as an accepted residual rather than left
  implicit, in the same spirit as the export-overwrite and updater-rollback residuals above.
- **`ensure_directory_exists` writes.** It is the one command in this document that creates
  something at a path the caller fully chooses, so it is worth stating plainly rather than leaving
  it inside the oracle bullet. What it creates is an empty directory: `create_dir_all` and nothing
  else. It writes no content, cannot overwrite an existing file (`create_dir_all` fails on one),
  and grants no later access - a directory it created is not in the asset scope, and no other
  command will act inside it unless it becomes the configured library, which requires the settings
  write that `validate_settings_library_path` gates. So the worst case is litter in writable
  locations, not a foothold.

These three also do not apply the UNC refusal, deliberately and for the reason given with the rule
above: a library on a share is supported, and the refusal would remove that. `is_network_path` is
therefore not the missing guard here - adding it would be a functional regression, not a fix.

#### Accepted residual: a move-import hashes the source once

`import_media_file` in move mode hashes the source file up front and reuses that hash through
the duplicate check, so when the destination already holds identical content the source is
deleted based on a hash computed slightly earlier
(`services/filesystem.rs::move_or_copy_file_with_known_source_hash`). A writer that changes the
source to different same-size content inside that in-process window would see the changed file
deleted as an "already-imported duplicate". No such concurrent writer exists in the app's
single-user desktop model - the import is user-triggered on a file the user just picked - and
re-hashing immediately before the delete would only narrow, not close, the window (the classic
TOCTOU shape). Recorded as an accepted residual rather than left implicit.

### Creating a media is one command, and that is a boundary decision

`create_media` (`commands/media.rs`, `services/media_creation.rs`) produces a media's artifacts,
records the crash marker, inserts the row and clears the marker as a single backend operation. It
replaced a sequence the renderer drove across seven IPC calls, and the reason it is in this document
rather than only in the architecture guide is that the sequence had two properties a security review
has to care about.

**It carries four caller-supplied paths, and each satisfies the cross-cutting rule above.** They are
listed here because the grouping is what made them easy to lose sight of: they arrive inside one
`CreateMediaRequest` rather than as four named parameters, so nothing about the signature says this
is the app's largest path surface.

| Field | How it satisfies the rule |
|---|---|
| `library_path` | Checked against the persisted setting by the command layer (`ensure_configured_library_path`) before any file is written, like every other library write. |
| `source_value` | An absolute path only in local-import mode; refused as a UNC/network location before any filesystem call (`services/library/media.rs::import_media_file_cancellable_sync`). In yt-dlp mode it is a URL and goes through the host allow-list instead. |
| `thumbnail_source_path` | Classified first (`classify_thumbnail_source`), so a remote URL and a local path cannot be confused for each other. The local branch refuses a network location and gates the extension (`services/thumbnail/picked.rs`); the remote branch goes through the image-CDN allow-list and the SSRF guard. |
| `cookies_path` | Refused as a network location and gated to `.txt` before it can reach a yt-dlp argv (`services/yt_dlp/cookies.rs::normalize_cookies_path`). |

Every path the creation *produces* is re-checked as a managed library-relative path before it can
reach a row (`ensure_managed_prepared_paths`), which is the last point at which a value that escaped
the managed layout can still be refused for free.

`scripts/verify-command-path-surface.js` holds this list against the code, and this command is the
reason it had to learn to follow a struct-typed parameter: it matched on parameter *names*, so
`create_media(app, request: CreateMediaRequest)` was reported as taking no path at all - the exact
silent growth that check exists to prevent, in the shape this codebase deliberately moved toward.
`source_value` needs a `// path-surface:` marker on the field even so, because its name is honest
about being a URL half the time and therefore says nothing about the other half.

**The artifacts-without-a-row window used to cross the process boundary.** Between the file landing
in the library and the row pointing at it, the library holds bytes nothing references. That window
still exists - it is inherent, since a file cannot join a SQLite transaction - but it is now the
inside of one function instead of the span of five round trips, and no step of it is separately
reachable.

**The steps are no longer exposed.** `import_media_file`, `download_media_from_url`,
`download_thumbnail_from_url`, `media_exists_for_channel_and_youtube_id` and the two crash-marker
commands (`record_pending_media_artifacts` / `clear_pending_media_artifacts`) were removed from the
IPC surface with the same change, because each existed only so the renderer could run one step of the
sequence. Two of them mattered more than the rest: a caller invoking the download or the import
directly wrote into the library and produced exactly that artifacts-with-no-row state, with no marker
behind it - the marker was the renderer's job to write. The rule for a command added later is that
the IPC surface exposes an operation, not its steps.

`insert_media` and `find_media_by_channel_and_file_path` stayed registered for a while after that,
and are now gone too. The reason they lingered was not a security judgment: `insert_media` was what
every IPC test in `commands/videos.rs` seeded its rows with, so removing it was test surgery rather
than a line in the same change. Those tests seed through `services::video_repository` directly now,
which is what let the surface actually shrink to what the rule says.

The validation `insert_media` carried moved rather than being deleted with it, and where it moved to
is the point. As a command-layer check it was a property of *arriving over IPC*, which left
`media_creation` - the one remaining caller - trusted to have validated on its own. It mostly had,
with one gap: the `media_type` a yt-dlp creation stores is the download's own value and never passes
through `normalize_create_media_request`, so nothing but the table's `CHECK` stood behind it. The
checks now live in `video_repository::insert_media`, which is the write boundary every caller
reaches - the rule this document applies everywhere else, applied here.

#### Accepted residual: unreferenced-artifact cleanup is not atomic against a concurrent creation

`cleanup_unreferenced_media_artifacts` reference-counts each artifact path against the database and
then unlinks the files nothing points at (`services/library/cleanup.rs`). Folding that count and the
unlink into one backend call closed the multi-round-trip race the frontend used to have, but the two
steps are still not atomic against a *concurrent* media creation that resolves to the same
content-addressed path. A wrapping transaction cannot help - the unlink necessarily happens after
any commit, since the filesystem cannot join a SQLite transaction.

What closes it is a lock: `library::cleanup::MEDIA_REGISTRATION_LOCK`, taken by the cleanup around
its count-and-unlink and by `media_creation::register_prepared_media` around its
marker/duplicate-check/insert. A creation and a cleanup can therefore no longer interleave, whichever
order they arrive in. The lock is a single static rather than a map keyed by artifact path, because
the section it guards is milliseconds long - the download and the import run outside it - so
serializing it costs nothing a user waits on, and a keying scheme would only add a way to get the key
wrong.

This paragraph used to say that lock was deliberately not built, and that the exclusion rested
instead on the add-media modal refusing to start a second creation (`isModalLocked`) - the one
guarantee in this document that depended on frontend behavior. That is what the move above removed.
A queue, a batch import or a background re-download no longer reopens anything, because none of them
can produce a second creation that is not behind the same lock.

The **startup sweep** (`services/pending_media.rs`, which hands a crashed creation's artifacts to the
same cleanup) keeps its own, separate guard on top, because the lock cannot answer its question.
Reference-counting cannot tell a creation that died before its row from one that has simply not
reached `insert_media` yet, so the sweep refuses any marker that is either registered as in flight by
this process or whose mtime is not older than the process itself
(`pending_media::marker_is_sweepable`). Without that, a creation running while the sweep fires would
have the file it just wrote unlinked and its marker deleted, leaving the row that lands moments later
pointing at nothing with nothing left to reconcile it. Every uncertain input to that decision (an
unreadable mtime, a same-tick write, a clock that moved backwards between runs) answers "leave it
alone", since refusing only defers a leftover by one launch while acting wrongly deletes a file the
user still wants.

The residual that remains is the ordinary one: the unlink happens after the count, so a *third* party
writing into the managed tree outside the app entirely is not covered. Nothing in this app does that,
and reaching it requires write access to the library folder, at which point an attacker has better
options.

The security boundary these share is the same one this whole document is about: the Rust
command layer holds regardless of what the frontend sends. React's default escaping (see
above) is what keeps the renderer from being compromised in the first place; these
constraints are the defense-in-depth for if it ever were.

## The yt-dlp host allow-list and argument separator

`src-tauri/src/services/yt_dlp/url.rs` restricts every URL handed to yt-dlp to an
`http`/`https` URL whose host is `youtube.com`, `youtube-nocookie.com`, `youtu.be`, or a
subdomain of one of those - rejecting look-alike hosts (`youtube.com.evil.com`,
`notyoutube.com`, userinfo tricks like `youtube.com@evil.com`). This matters because
yt-dlp can be run with `--cookies-from-browser`, i.e. with access to the user's real
browser cookies; without the host check, a compromised frontend could point yt-dlp (and
those cookies) at an arbitrary site. The app only ever needs YouTube, so this closes the
gap without losing functionality.

Every yt-dlp invocation also places a literal `--` separator before the URL argument
(the argv builder in `services/yt_dlp/download/command.rs`, and `services/yt_dlp/metadata.rs`
for the metadata calls), so the URL can never be reinterpreted as a
command-line flag by yt-dlp itself - defense-in-depth on top of the scheme/host check,
not a substitute for it. Binaries are always invoked via `std::process::Command`/
`tokio::process::Command` with an argument array, never a shell string, so there is no
shell-interpolation step for injection to exploit in the first place.

The optional cookies-file path (`--cookies <path>`) is similarly restricted: only an
existing, non-network `.txt` file is accepted (`services/yt_dlp/cookies.rs::normalize_cookies_path`),
mirroring the file picker's own filter, and the resolved path is redacted before it is
ever shown in the in-app terminal preview. The network-path refusal has to come *before* the
`is_file()` check rather than after it: stat'ing a UNC share is itself what makes Windows
authenticate to that host over SMB and leak the user's NTLM hash, so a check that ran later
would already have paid the cost it exists to avoid. This is the same guard, closing the same
escalation, as `library::resolve_path_inside_library` and
`thumbnail::temp::validate_source_media_path`; a cookies file kept on a share loses only the
ability to be pointed at directly. An invalid value is dropped rather than raised as an error,
matching how this function treats every other rejection - the run simply proceeds without
cookies (or falls back to `--cookies-from-browser`).

## Outbound image fetches (thumbnails and channel avatars)

Downloading a thumbnail is the one place the backend makes an HTTP request of its own rather than
delegating to yt-dlp, so it carries its own set of controls
(`services/thumbnail/download.rs`). `download_thumbnail_from_url` takes two paths depending on the
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
filter). It follows redirects **manually**, re-running *both* checks on every hop - the address
check and the host allow-list - and dials
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

That gate was then per *fetch* rather than per *hop* for a while, which is a narrower version of the
same gap and worth recording separately, because the code read as though it were closed. The initial
URL was checked before the request went out, and only `assert_url_host_is_public` re-ran on each
redirect - so a `302` out of `i.ytimg.com` to `https://attacker.example/<data>.jpg` was followed. The
address guard does not cover that (the destination is perfectly public), and neither do the response
constraints, which all apply after the request has already been made. The check now lives in
`services::thumbnail::redirect::next_hop`, which decides the whole of a hop and is under the mutation
gate; the caller still gates the initial URL, since that is a different question (may this fetch
start at all) about a URI no redirect produced.

## External binary resolution (no working-directory hijack)

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

## Capabilities: what the renderer is allowed to call at all

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

**Two registered plugins hold no grant at all, and that is the correct state rather than an
omission.** `tauri-plugin-single-instance` and `tauri-plugin-window-state` (`lib.rs`) do their whole
job from the Rust side - a launch hook that focuses the existing window, and a window-event hook
that persists size and position. Neither is reachable from `src/lib/`, so neither belongs in
`capabilities/`, and adding one would be granting a permission nothing calls. This is stated rather
than left to be inferred from the absence, because the list above otherwise reads as a complete
accounting of the plugin surface and a reader counting six plugins against four grants deserves the
answer here rather than in a diff. If either ever grows a call from the seam, its permission joins
the list - and the failure mode if that is forgotten is the loud one described below.

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

### How the grant list is actually verified

"Loud and immediate" is true for whoever hits the refused call, and that used to be the whole
story - which was the weak point of a hand-picked list. The ACL is evaluated at runtime and only
in the renderer, so nothing in the pipeline reached it: `cargo test` links the `rlib` and never
initializes the Tauri runtime or the webview, `pnpm build` only emits the frontend bundle, and
`--smoke-test` (the release workflow's startup self-check) exits inside `setup()` before the event
loop starts. A permission missing from the list above would therefore have crossed six green build
legs and surfaced on the first click a user made.

`--webview-check` closes that. It is a second startup flag
(`src-tauri/src/commands/webview_check.rs`) that lets the launch proceed normally and has the
renderer report what it could actually do, then exits 0 or 1. The release workflow runs it on the
built binary on every leg it can execute one, right after `--smoke-test` and before the build
provenance is attested, so a binary that fails it is never vouched for. Three probes:

- `getVersion()`, for `core:app:allow-version`.
- `listen()` followed by its unsubscribe, for `core:event:allow-listen` and
  `core:event:allow-unlisten` - both, since they are separate grants and a build holding only the
  first must not pass.
- an `<img>` pointed at `convertFileSrc` of a real file in the granted cache directory, which is
  the only automated exercise of the asset-protocol scope *and* of the CSP (see below for why a
  packaged build is the only thing that applies one).

A renderer that never loads at all reports nothing, which a watchdog turns into a non-zero exit
naming that outcome rather than a hang - the case that covers a bundle the webview refuses or a
CSP that blocks the entry script.

The four plugin grants are **not** covered and stay a manual check, because none can be exercised
without a side effect: `dialog:allow-open`/`allow-save` would open a file picker,
`opener:allow-open-url` would launch a browser, `updater:default` would reach the network, and
`process:allow-restart` would restart the app.

One trap worth naming, since it is the one case where the tight list could bite: the `Update`
object returned by the updater plugin extends `Resource`, and calling `.close()` on it would
invoke `plugin:resources|close`, which is **not** granted. Nothing calls it today - the flow is
`check()` then `downloadAndInstall()` then `relaunch()`, and the plugin closes the handle on the
Rust side - so adding `core:resources:allow-close` now would be granting an unused permission.
Add it if and when a `.close()` call appears.

## Asset-protocol scope

The webview loads local files (video/audio/thumbnails) through Tauri's `asset:` protocol
plus `convertFileSrc`, which only serves files inside directories/files explicitly
"allowed" in the asset-protocol scope (`tauri.conf.json`'s `assetProtocol.scope` starts
empty). Exactly one command populates that scope at runtime, and it is careful about what it grants,
because the scope plus `convertFileSrc` is effectively an arbitrary local-file-read primitive if it
is ever widened too far:

- `register_library_asset_scope` (`commands/security.rs`) authorizes the *library*
  directory, but only after `ensure_configured_library_path` confirms the requested path
  matches the persisted settings (the same check described above) - so a compromised
  frontend cannot widen the scope to an arbitrary directory.

There used to be a second one, `allow_asset_file`, which granted a single user-picked image so the
manual-thumbnail preview could draw it. It is gone rather than tightened, and the reasoning is the
useful part. Tauri's scope has no way to *withdraw* a grant, so every image a user previewed stayed
authorized for the rest of the session - a set that only ever grew, in the one command whose purpose
was to widen this boundary to a caller-chosen path. The obvious cleanup is worse than the problem: a
forbid outranks every later allow (the same asymmetry `session_forbidden_dirs` exists to work
around), so revoking a discarded preview would make the same image, picked again for a second media,
silently render nothing.

`commands::thumbnail::stage_manual_thumbnail` replaced it by copying the picked image into
`thumbs-temp/`, which is already authorized as a directory (below). The preview then needs no grant
at all, the copy is swept and deleted like every other preview, and the file that eventually reaches
the library is byte-identical because the copy is. Removing the command also closed a gap it
carried: it called `is_file()` directly on the caller's path with no network-location refusal, so a
`\\host\share\x.png` arriving over IPC would have authenticated to `host` over SMB and leaked the
user's NTLM hash - the guard every other caller-supplied path here applies. The replacement refuses
one before it touches the filesystem.

Two subdirectories of the app's cache directory are authorized once, in `lib.rs`'s `setup()`
(`register_cache_asset_scope`): `thumbs-temp/`, which holds the preview shown before a thumbnail is
committed to the library, and `thumb-display/`, which holds the display-sized thumbnail derivatives
the grid draws. Those are the only two the webview renders from - `yt-dlp-temp/` and
`yt-dlp-thumb-temp/` are scratch whose output is moved into the library before any path reaches the
frontend, and `pending-media/` is read by the startup sweep alone.

The **cache root is deliberately not granted**, and that distinction is not cosmetic. This used to
be a single recursive `allow_directory` on the root, justified by the root holding nothing but
app-generated temp files. That justification was wrong on Windows, where `app_cache_dir()` resolves
to `%LOCALAPPDATA%\com.kavynex.app` and is therefore also the parent of the log directory
(`app_log_dir()` = `<cache root>\logs`) and of `EBWebView/`, the WebView2 user-data folder. So the
grant reached a log file the README asks users to attach to bug reports, and the browser profile of
the app's own webview, neither of which has anything to do with rendering a thumbnail.

The residual exposure while that grant was in place was small - `connect-src` does not include
`asset:`, so the renderer could *display* such a file as an `<img>`/`<video>` but never read its
bytes back through `fetch`/XHR, and there is no injection sink in `src/` to reach it from - but the
scope is this app's arbitrary-local-file-read boundary, and it should not be wider than the two
directories it serves. Naming the subdirectories is the same rule
`managed_asset_scope_dirs` already applies to the library, applied to the cache tree
(`constants::WEBVIEW_READABLE_CACHE_DIRS`).

One property of the scope itself is worth stating, because it differs from how containment is
decided everywhere else in this document: Tauri matches a request against the scope's **glob
patterns over the requested path string**, without canonicalizing it first. Every other containment
check here resolves symlinks and compares canonical paths
(`ensure_existing_path_inside_dir`, `library::guard`), so this is the one place the decision is
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

### The one relaxed directive: `style-src 'unsafe-inline'`

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

### Where the remote-images privacy setting is enforced (and where it is not)

The README states that with **Settings > Privacy > "Load comment and live chat images from
Google"** off - which is the default - viewing saved media makes no network requests at all. That
is accurate, and it is worth being precise about which layer delivers it, because it is not the
CSP.

`img-src` names `https://*.ggpht.com`, `https://*.googleusercontent.com`, `https://*.ytimg.com`
and `https://*.youtube.com` **unconditionally, in both modes**. The setting is enforced one layer
up, in the renderer: `RemoteImage` (`src/components/player/remote-image.tsx`) reads the preference
from context and renders a monogram or the emoji shortcut text instead of emitting an `<img>` at
all, and `SafeAvatar` routes through it so a caller cannot forget the gate. No request is made,
so nothing reaches the CSP to be judged.

Two consequences follow, and both are accepted:

- The guarantee is an application-layer one. A renderer that ran attacker-controlled code could
  emit an `<img>` at one of those hosts and the CSP would allow it, which makes those four hosts a
  low-bandwidth outbound channel (a URL path, no response read back - `connect-src` is `'self' ipc:`,
  so the bytes cannot be fetched). Reaching it requires an injection sink, and there is none: every
  YouTube-derived string is rendered as a React child, never through `dangerouslySetInnerHTML` or
  `eval`. This is the same property the `style-src` tradeoff above rests on, and it fails in the
  same way if raw-HTML rendering is ever introduced.
- Tightening it is not a config change. Tauri applies the CSP as a static header from
  `tauri.conf.json`; making it track a database-backed setting would mean intercepting web-resource
  requests at runtime and rewriting the header per response, which is a real amount of machinery to
  duplicate a check the renderer already performs correctly.

The narrower statement is therefore the true one: **with the setting off, Kavynex makes no remote
image requests; the CSP is what would constrain such a request if one were ever made, not what
prevents it.** Recorded because "off by default" reads as a transport-level guarantee and it is not
one - unlike the host allow-list on the backend's own fetches (`services/thumbnail/url.rs`), which
*is* enforced below the renderer and is pinned against this same `img-src` list by
`allowed_thumbnail_hosts_match_the_csp_img_src`.
