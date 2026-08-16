# Every command taking a `library_path` verifies it, with no exceptions

**2026-07-30**, commit `7826b89` (*fix: verify the library path the three reading commands are
given*).

## What the code does now

`get_library_summary`, `check_library_integrity` and `open_path_in_system` verify the
`library_path` they receive over IPC against the persisted setting
(`library::guard::ensure_configured_library_path_in_pool`), like every other command that takes one.
Each has an IPC-level test pinning the refusal
(`commands/library.rs::*_rejects_a_path_that_is_not_the_configured_library`).

## What it did before

Those three were a documented exception. The argument was that onboarding and the change-library
flow needed them to act on a candidate folder before it was persisted, so re-deriving the directory
from settings would break both.

The premise did not hold, and that is the part worth keeping. **No caller ever passed a candidate.**
The settings modal and the diagnostics summary both pass `settings.libraryPath`, which is the
persisted value, and the change-library flow (`src/use-cases/change-library-path.ts`) previews a
candidate with `ensure_directory_exists` / `is_directory_empty`, a different group of commands with
their own residual. The exception cost the central rule of the whole backend and bought nothing.

## What breaks if someone goes back

In order of severity:

- **`check_library_integrity` becomes a directory enumerator.** Its report carries up to five real
  filenames per category (`orphan_media_examples` and its siblings), gathered by walking
  `<library_path>/video`, `/audio`, `/thumbnails` and `/live_chat`. With the path trusted, a
  compromised renderer can name files in any tree on disk holding one of those subdirectories. The
  names are worth reporting, since Diagnostics exists to tell the user which of their own files are
  unreferenced, so the answer is the guard rather than a poorer report.
- **`get_library_summary` discloses directory sizes and counts** for any path.
- **`open_path_in_system`'s containment check becomes self-referential.**
  `resolve_path_inside_library` confines `path` to `library_path`, so a caller that supplies both
  satisfies it trivially by passing the same directory as each. The guard is what makes that
  containment mean anything.

## The general shape

An exception justified by a caller nobody checked. The lesson generalizes past these three: before
granting one, confirm the flow that supposedly needs it actually calls the command that way.
[`../THREAT-MODEL.md`](../THREAT-MODEL.md) keeps the current rule and enumerates the commands that
*do* legitimately take a caller-supplied path, each with what bounds it.
