# No per-file grant in the asset-protocol scope

**2026-07-30**, commit `9376ec7` (*fix: preview a picked thumbnail without granting it in the asset
scope*).

## What the code does now

`commands::thumbnail::stage_manual_thumbnail` copies an image the user picked into `thumbs-temp/`,
which `register_cache_asset_scope` already authorizes as a directory, and returns the path of the
copy. The preview draws that copy through `convertFileSrc` and needs no grant of its own. The copy
is swept and deleted like every other preview, and the file that eventually lands in the library is
byte-identical because it is a copy.

## What it did before

An `allow_asset_file` command in `commands/security.rs` granted the picked file itself in the
asset-protocol scope, so the preview could draw it in place.

## What breaks if someone goes back

**The scope only grows.** Tauri offers no way to withdraw a grant, so every image a user previewed
stayed authorized for the rest of the session. A set that only accumulates, in the one command whose
purpose was to widen this app's arbitrary-local-file-read boundary to a caller-chosen path.

**The obvious cleanup is worse than the problem.** A forbid outranks every later allow, which is the
asymmetry `session_forbidden_dirs` exists to work around, so revoking a discarded preview would make
the same image, picked again for a second media, silently render nothing.

**It carried a gap of its own.** It called `is_file()` straight on the caller's path with no
network-location refusal, so a `\\host\share\x.png` arriving over IPC would have authenticated to
`host` over SMB and leaked the user's NTLM hash. That is the guard every other caller-supplied path
in this codebase applies before touching the filesystem; the replacement refuses one up front.

## Where the rule lives now

On `stage_manual_thumbnail`'s doc comment. The copy is what keeps the preview out of the asset
scope, and a per-file grant is the shape that command deliberately does not have.
[`../THREAT-MODEL.md`](../THREAT-MODEL.md)'s asset-protocol section states the resulting property,
that exactly one command widens the scope at runtime and it is checked against the persisted library
path.
