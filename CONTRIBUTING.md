# Contributing

Kavynex is a solo-maintained, MIT-licensed project. Contributions are welcome, but keep in
mind there is a single maintainer reviewing everything - small, focused changes are easier
to review than large ones. This document covers dev setup, day-to-day commands, how the
generated TypeScript bindings work, and commit conventions.

See also `docs/ARCHITECTURE.md`, `docs/DATABASE.md`, `docs/DIRECTORIES.md`, and
`SECURITY.md` for how the app is put together and why its safety checks exist.
`CODE_OF_CONDUCT.md` covers what is expected of everyone taking part, and `SUPPORT.md` is where
to send someone who has a bug to report rather than a change to propose.

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
