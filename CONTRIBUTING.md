# Contributing

Kavynex is a solo-maintained, MIT-licensed project. Contributions are welcome, but keep in
mind there is a single maintainer reviewing everything - small, focused changes are easier
to review than large ones. This document covers dev setup, day-to-day commands, how the
generated TypeScript bindings work, the release flow, and commit conventions.

See also `docs/ARCHITECTURE.md`, `docs/DATABASE.md`, `docs/DIRECTORIES.md`, and
`SECURITY.md` for how the app is put together and why its safety checks exist.

## Prerequisites

- [Node.js](https://nodejs.org/) - match the range pinned in `package.json`'s `engines.node`
  field (currently `>=26 <27`; `.nvmrc` pins the exact patch the CI/release workflows use), so
  local builds and CI agree
- [pnpm](https://pnpm.io/) - match the `pnpm/action-setup` major those workflows pin
- [Rust](https://www.rust-lang.org/), via [rustup](https://rustup.rs/). The exact
  toolchain is pinned in `rust-toolchain.toml` (`1.96.0`, with `rustfmt` and `clippy`) -
  rustup will pick it up automatically when you run any `cargo`/`rustc` command inside the
  repo, so there is nothing to configure manually. Bump that file deliberately (and rerun
  `cargo fmt`/`clippy`/tests) rather than letting the toolchain drift.
- [yt-dlp](https://github.com/yt-dlp/yt-dlp) and [FFmpeg](https://ffmpeg.org/), available
  on `PATH` (see the README's Troubleshooting section for exactly how Kavynex resolves
  them).
- The OS-level Tauri prerequisites for your platform (WebView2 on Windows - usually
  already present; `libwebkit2gtk`, `libappindicator3`, `librsvg2` and `patchelf` on
  Linux, matching `ci.yml`'s Ubuntu setup step). See the
  [Tauri prerequisites guide](https://v2.tauri.app/start/prerequisites/) if your platform
  needs something not listed here.

## Setup and day-to-day commands

```bash
pnpm install
pnpm tauri dev
```

Frontend:

- `pnpm lint` - ESLint (`eslint.config.js`) over `src/**/*.{ts,tsx}`.
- `pnpm advisories:check` - fails on a high/critical security advisory in the production
  dependency tree, querying osv.dev (add `--dev` for the toolchain tree, which CI reports but
  does not gate on). This replaced `pnpm audit`, which npm's retired audit endpoints broke for
  every pnpm version - see `scripts/check-js-advisories.js`.
- `pnpm licenses:check` - fails on a production dependency whose license is not allow-listed.
- `pnpm test` - Vitest in watch mode.
- `pnpm test:run` - Vitest, single run (what CI uses).
- `pnpm test:mutation` - Stryker mutation testing (`stryker.config.json`); slower, run it
  when you want confidence in a test suite's actual coverage of behavior, not just line
  coverage.
- `pnpm build` - `tsc` (typecheck) then `vite build`.

Backend (run from the repo root; Cargo commands need `--manifest-path src-tauri/Cargo.toml`
unless you `cd src-tauri` first):

- `cargo test --manifest-path src-tauri/Cargo.toml` - the Rust test suite.
- `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings` - lint,
  matching CI (`-D warnings` fails the build on any clippy warning).
- `cargo fmt --manifest-path src-tauri/Cargo.toml --all` - format (CI runs
  `--check`, i.e. it fails if this would change anything, it does not auto-fix for you).

`pnpm tauri build` builds release installers for your current platform.

## Regenerating the TypeScript bindings

Rust types shared with the frontend derive `ts_rs::TS` and export to
`src/types/generated/`. After changing one of those types (or adding a new one), regenerate
the bindings and check the diff in:

```bash
cargo test --manifest-path src-tauri/Cargo.toml --lib export_bindings
```

CI (`ci.yml`, Ubuntu only) runs the same command and then `git diff --exit-code -- src/types/generated`
to fail the build if the checked-in bindings are stale. Never hand-edit a file under
`src/types/generated/` - change the Rust type instead and rerun the command above. See
`docs/ARCHITECTURE.md` for where these types fit in the IPC boundary.

### Field naming on IPC types

A **new** type crossing the IPC boundary uses camelCase field names on the wire: put
`#[serde(rename_all = "camelCase")]` on the struct/enum so the generated TypeScript reads
naturally on the frontend (`StoredAppSettingsPayload` and `MediaPageQuery` are the reference
examples). Do not mix per-field `#[serde(rename = ...)]` with unrenamed siblings on the same
type.

Many existing types (`Channel`, `MediaRow`, the yt-dlp event payloads, ...) predate this rule
and expose raw snake_case; the frontend consumes them as generated, so nothing is broken.
Migrating one is a deliberate, self-contained change - add the attribute, regenerate the
bindings, and update every frontend usage and test fixture in the same commit - not something
to do in passing while touching a type for another reason.

## Frontend hook conventions

The controller hooks under `src/hooks/` follow a small set of rules that keep the media grid and the
player from re-rendering on unrelated state changes. They are enforced by convention (and by
`eslint-plugin-react-hooks`), not by a dedicated lint rule, so they are collected here as the single
reference the inline comments point back to. A new hook that ignores them will usually still work,
just slower - the failure mode is extra renders, not a crash, which is exactly why it is easy to let
drift in unnoticed.

- **Return a reference-stable controller.** Build a hook's return value with `useMemoObject({...})`
  (`src/hooks/use-memo-object.ts`) rather than a bare object literal, so its identity only changes
  when one of its fields does. A fresh object every render invalidates every consumer that depends
  on the whole controller.
- **Depend on the specific stable fields, not the whole controller object.** When a hook receives
  another controller as input, destructure the individual fields it needs off it and list *those* in
  the `useCallback`/`useEffect`/`useMemo` dependency arrays - never the per-render controller object
  itself, whose identity changes every render and would recreate the callback (and, transitively,
  every per-card handler derived from it) on any unrelated change. `use-home-media-actions.ts` and
  `use-home-player-actions.ts` are the reference examples.
- **Do not reach for `eslint-disable react-hooks/exhaustive-deps`.** The destructure-stable-fields
  rule above is what lets the dependency arrays stay honest without it. The few genuine exceptions
  (`use-memo-object.ts`, `use-media-progress-persistence.ts`, `add-media-modal.tsx`) each carry a
  comment explaining why the omission is correct; a new one needs the same justification, not a bare
  disable.
- **Keep the latest value in a ref when a callback must read it without depending on it.** When a
  callback needs the current value of something that changes often (e.g. the active media) but must
  not be recreated when it changes, mirror it into a ref updated in an effect and read the ref inside
  the callback - see the `activeMediaRef` pattern in `use-media-actions.ts`.

## Release flow

1. Bump the version everywhere it needs to match (`package.json`, `src-tauri/tauri.conf.json`,
   `src-tauri/Cargo.toml`, and regenerate `src-tauri/Cargo.lock`) with:

   ```bash
   pnpm run version:bump 1.2.0
   # equivalent to: node scripts/bump-version.js 1.2.0
   ```

   `scripts/verify-release-version.js` (run in both `ci.yml` and `release.yml`) fails the
   build if these three files ever disagree, so always use the bump script rather than
   editing versions by hand.
2. Commit the version bump and push to `main`.
3. Manually trigger the `release` GitHub Actions workflow
   (`.github/workflows/release.yml`, `workflow_dispatch` - there is no automatic release
   on tag or merge). It builds installers across six matrix legs - Windows x64
   (`windows-2025`) and ARM64 (`windows-11-arm`), Linux x64 (`ubuntu-26.04`) and ARM64
   (`ubuntu-26.04-arm`), and both macOS architectures (`aarch64-apple-darwin`,
   `x86_64-apple-darwin` on `macos-26`) - runs the same
   lint/test/build and fmt/clippy/Rust-test/TS-bindings-freshness/dependency-audit checks CI
   does (the release is manually dispatched, so nothing guarantees the chosen commit already
   passed CI), and refuses to run if `v<version>` (matching `package.json`'s version, e.g.
   `v1.2.0`) already names a **published** release - bump the version again before
   re-releasing. A tag left behind by a dispatch that failed partway is handled instead of
   refused; see "When a release dispatch fails" below. The Windows-on-ARM and preview
   `ubuntu-26.04-arm` legs first shipped in v1.2.0 and are now proven end to end; the one
   thing that leg needed was `xdg-utils`, which the arm64 runner image does not carry and the
   AppImage bundler refuses to run without (the apt step installs it explicitly on both Linux
   legs for that reason).
4. The workflow creates a **draft** GitHub release tagged `v<version>` whose body is a single
   line pointing at the release page, and uploads the built installers plus signed updater
   artifacts. That body is deliberately short rather than a commit log: `tauri-action` copies
   it verbatim into `latest.json`'s `notes`, which the in-app update notice renders as one
   unscrolled block, so anything longer arrives as a wall of text in the update dialog. A
   release here can carry hundreds of commits, which is what made this a real problem rather
   than a stylistic one. A separate `sbom` job publishes a CycloneDX SBOM of the
   Rust dependency tree (`kavynex_<version>_sbom.cdx.json`), and a `checksums` job then
   downloads every asset, verifies the release is complete (the asset-completeness check -
   a missing installer or SBOM fails the release loudly rather than shipping silently), and
   publishes `SHA256SUMS.txt` on the same release (see `SECURITY.md` for why the checksums,
   SBOM and build provenance matter given installers are unsigned).
5. Write the release notes by hand on the draft, using `git log v<previous>..HEAD --oneline`
   as the raw material - the `feat:` and `fix:` subjects are the user-facing set, and the
   commit convention below is what keeps them legible enough to serve as that material. This
   is why there is no `CHANGELOG.md` to keep in step: the history already answers "what
   changed since the last release", and a second copy of it only had somewhere to drift.
   Writing it here rather than in the workflow body is what keeps it off the update notice -
   editing a draft does not regenerate `latest.json`, so the text reaches the release page
   without reaching the app.
6. Review the draft release and publish it manually when ready.

Installers are intentionally not code-signed (see `SECURITY.md`); do not add code-signing
steps to the release workflow.

### When a release dispatch fails

The tag is created by `tauri-action` in step 3, i.e. *before* the `sbom` and `checksums` jobs
run. A dispatch that built and signed everything and then failed one of those later gates
therefore leaves the tag behind on a release that is still a draft. That is a normal outcome,
not a corrupted state - and it does **not** cost a version number:

- **A later job failed (asset-completeness, `latest.json`, SBOM upload).** Fix the cause and
  re-dispatch the same version. The tag guard recognizes a tag whose release is still a draft
  and lets the run through with a warning; `tauri-action` reuses the existing draft and
  re-uploads its assets. The asset-completeness check is the most likely first failure whenever
  a bundler's naming shifts - the run echoes the actual asset names above the failure, which is
  what to compare the patterns against. Every name in that list was confirmed against the v1.2.0
  dispatch, and the lesson from it was that the list is perishable in both directions: the arm64
  names, flagged in the workflow as unconfirmed, all held, while the macOS `.app.tar.gz` names -
  the pair that *had* been observed on v1.1.1 - had since gained the version and were the ones
  that broke.
- **A build leg failed.** Same thing: re-dispatch. The `sbom` and `checksums` jobs deliberately
  run even when a leg fails (`if: ${{ !cancelled() }}`), so the incomplete draft is reported
  rather than silently left publishable.
- **The release was already published.** The guard refuses, correctly - a published release is
  final. Bump the version and release again.
- **The tag exists with no release behind it** (a draft deleted by hand). The guard refuses,
  since nothing proves what the tag points at. Delete the tag on the remote
  (`git push origin :refs/tags/v<version>`) and re-dispatch, or bump the version.

Never delete or re-upload an asset on an *already published* release: `latest.json` and the
minisign signatures are what the updater trusts, and rewriting a published release is the one
operation the updater's rollback exposure (see `SECURITY.md`) actually depends on not happening.

## Commit conventions

Commits follow [Conventional Commits](https://www.conventionalcommits.org/), with rules
specific to this project:

- Format: `<type>: <imperative, lowercase subject>` - **no scope**.
- Subject is imperative mood, lowercase, and has **no trailing period**. Keep it short.
- English only.

Allowed types, and *only* these:

| Type | For |
|---|---|
| `fix` | a bug fix |
| `feat` | a new feature |
| `build` | the build, packaging or dependencies |
| `ci` | the CI pipeline - workflows, triggers, matrix, cache, secrets |
| `refactor` | a code change that neither fixes a bug nor adds a feature |
| `perf` | a code change that improves performance |
| `docs` | documentation only |
| `test` | adding, fixing or adjusting tests |
| `style` | formatting that does not change behavior - whitespace, indentation, line breaks |
| `revert` | reverting an earlier commit |
| `chore` | general maintenance that is not functionality, build, CI or documentation |

Dependency updates (bumping a package or crate version) are `build`, never `chore`.

Examples from this repository's history:

```
fix: distinguish "no comments" from a failed comment fetch on refresh
refactor: extract pure comment-tree and format-rules modules, drop a dead use-case
perf: stop storing thumbnails as lossless png and trim the grid overscan
build: pin the Rust toolchain to 1.96.0 and tighten CI
ci: audit rust dependencies with cargo-audit
```

## Pull requests

Keep changes focused and include tests for new behavior (Vitest for frontend, `#[test]`/
`#[tokio::test]` for Rust). CI runs on every push/PR: frontend lint/test/build, Rust
fmt/clippy/test across Linux/Windows/macOS, the TS-bindings-freshness check, and a
`cargo audit` pass over Rust dependencies (RUSTSEC advisories are not covered by the JS
advisory check, so this is a separate job).
