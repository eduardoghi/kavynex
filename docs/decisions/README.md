# Decisions

Why the code is shaped the way it is, for the cases where the shape is not obvious and reverting it
would be an easy mistake to make.

The rest of `docs/` describes what the app **is**: the schema it holds, the directories it writes,
what it defends against, how a release is cut. Those documents are read to answer a question about
the current system, so they are kept in the present tense, and anything in them that describes a
state the app is no longer in is a maintenance cost with no reader. This directory is where that
material goes instead.

## What belongs here

An entry per decision that a future change could plausibly undo by accident. Each one answers three
things:

- what the code does now,
- what it did before, or what the obvious alternative was,
- what breaks if someone goes back.

That third part is the reason the entry exists. A decision nobody would reverse does not need a
document; a decision that reads like an over-complication until you know what it prevents does.

## What does not belong here

**A rule that still applies goes in the code**, as a comment where the rule has to hold. "Do not
reuse `open_path_in_system` for the log directory, because its containment check compares `path`
against `library_path` and passing the same value as both satisfies it trivially" is a live warning
sitting exactly where someone would make that mistake. Moving it here would be filing it away from
its reader.

**A property of the current system goes in the reference documents.** The accepted residuals belong
in [`../THREAT-MODEL.md`](../THREAT-MODEL.md) and [`../RELEASE-SECURITY.md`](../RELEASE-SECURITY.md)
next to the control they qualify, not here, because a residual is something the app has today rather
than something it moved away from.

**A changelog entry is not a decision.** What changed for the user is release notes. What is here is
why a shape was chosen over another, which the user never sees.

## Naming

`YYYY-MM-DD-short-slug.md`, dated with the commit that made the change rather than with when the
entry was written. The date is what makes an entry safe to read years later: it says which version
of the codebase the alternative was rejected against.

## Entries

- [2026-07-30, the IPC surface exposes operations, not steps](2026-07-30-ipc-exposes-operations-not-steps.md)
- [2026-07-30, every command taking a library_path verifies it](2026-07-30-no-unguarded-library-path.md)
- [2026-07-30, no per-file grant in the asset-protocol scope](2026-07-30-no-per-file-asset-scope-grant.md)
- [2026-08-16, a command with no caller is removed, not kept for later](2026-08-16-no-command-without-a-caller.md)
