# A command with no caller is removed, not kept for later

**2026-08-16**, commit `360a9f6` (*refactor: drop the two commands nothing in the app calls*).

## What the code does now

Every command registered in `generate_handler!` (`src-tauri/src/lib.rs`) is reached by a wrapper in
`src/` that at least one hook, use case, service or component calls. Two that were not are gone:

| Command | Effect it exposed |
|---|---|
| `cleanup_unreferenced_media_artifacts` | reference-counted unlink of a media file, a thumbnail and a live chat replay |
| `delete_live_chat_file` | clears a row's live-chat columns, then unlinks the replay file |

The work behind both stayed. `library::cleanup::cleanup_unreferenced_artifacts` is still what
`media_creation`'s failure path and `pending_media`'s startup sweep run, and a media delete still
removes its replay through `library::cleanup::delete_media_row_and_plan_cleanup`, which plans the
`LiveChat` artifact alongside the media file and the thumbnail. Only the way in from the renderer
is closed.

## What it did before

Both were registered and both were unreachable from the app.

`cleanup_unreferenced_media_artifacts` lost its caller in `eed1ea6`, the same commit that moved the
creation sequence into the backend (see
[the IPC surface exposes operations, not steps](2026-07-30-ipc-exposes-operations-not-steps.md)).
That commit named which commands it dropped and which two it kept for another day, and this one was
in neither list, because the renderer stopped calling it and nothing noticed.
`delete_live_chat_file` was never wired to a UI at all. Nothing in the app deletes a replay on its
own; the only delete that touches one is the media delete, which does it through the plan.

They still carried their guards the whole time, and one of them was hardened five days before it was
removed (`6875498`, confining the cleanup's three paths to the managed subdirectories). That is the
cost worth naming. The effort went into defending a door nothing walks through.

## What breaks if someone goes back

**A renderer that is compromised gets two destructive verbs it has no other way to reach.** This
project's threat model treats the frontend as untrusted and measures the surface by what a
compromised one can invoke ([`../THREAT-MODEL.md`](../THREAT-MODEL.md)). `delete_live_chat_file` is
the sharper of the two, since `list_live_chat_files` enumerates the replays and the delete clears
the referencing row's columns before unlinking, so a loop over the two destroys every replay in the
library *and* the record that they existed, which is what leaves the library diagnostics with
nothing to reconcile. `cleanup_unreferenced_media_artifacts` is bounded by its reference count, so
the most it reaches is the artifacts of a creation whose row has not landed yet.

**Neither can be argued for by pointing at its guards.** Both had them, both were correct, and a
guard on a command nothing calls is a guard whose only job is to survive an attacker. The reason to
keep a command is a caller.

**Reintroducing one needs a UI, not a wrapper.** A wrapper with no caller is what produced this
state twice. If a "delete just the replay" action is ever wanted, it arrives with the button that
invokes it.

## A third and a fourth, a week later

The gate did not catch everything at once. `delete_thumbnail_file` (unlink of a thumbnail, no
reference count, confined to `thumbnails/`) had lost its last caller in `feb89e1` on 2026-07-06, when
the avatar and thumbnail cleanup moved into `library::cleanup`'s transactional plan, and
`resolve_default_library_directory` (create and return `<video_dir>/Kavynex Library`) had no caller
in this history at all. Both were registered and shipped through v1.4.0.

What hid them was `src/services/index.ts`. The barrel re-exported every service function, and the
gate counted a file that names the wrapper as a caller of it, so a re-export line satisfied the
check. The commit that dropped the barrel (`0d07bb6`) is what turned the gate red, and both were
removed end to end in the commit after it, taking the Rust function, its `generate_handler!` line,
the wrapper, the `TAURI_COMMANDS` constant, the return type, and the two error codes only the
default directory path produced. `docs/DIRECTORIES.md` stopped describing a default library
location, since the app never applied one.

The lesson is about the gate, not the commands. A re-export is not a call, and an inventory check
that cannot tell the two apart has a false negative for as long as a barrel exists. The script now
drops every `export { ... } from` and `export * from` statement before it looks for a caller
(`stripReExports`), with a test that feeds it a barrel and expects no caller back, so a future
barrel cannot reopen the gap.

## Where the rule lives now

Two places, deliberately. `commands/media.rs` already carries the forward-stated rule this one
extends ("the IPC surface exposes an operation, not its steps"). The counted version of it,
"a registered command has a caller", is enforced by `scripts/verify-command-surface-is-used.js`,
run in CI. An inventory checked by nothing is how both of these survived, and this repository
already answers that with a gate rather than with a note.
