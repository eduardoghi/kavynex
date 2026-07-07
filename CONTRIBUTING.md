# Contributing

Kavynex is a solo-maintained, MIT-licensed project. Contributions are welcome, but keep in
mind there is a single maintainer reviewing everything - small, focused changes are easier
to review than large ones. This document covers dev setup, day-to-day commands, how the
generated TypeScript bindings work, the release flow, and commit conventions.

See also `docs/ARCHITECTURE.md`, `docs/DATABASE.md`, `docs/DIRECTORIES.md`, and
`SECURITY.md` for how the app is put together and why its safety checks exist.

## Prerequisites

- [Node.js](https://nodejs.org/) (an LTS version; CI uses `lts/*`)
- [pnpm](https://pnpm.io/) (CI pins `pnpm/action-setup` to major version 10)
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
   on tag or merge). It builds installers for Windows, Linux, and both macOS
   architectures (`aarch64-apple-darwin`, `x86_64-apple-darwin`), runs the same
   fmt/clippy/test/build checks CI does (the release is manually dispatched, so nothing
   guarantees the chosen commit already passed CI), and refuses to run if a tag named
   `v<version>` (matching `package.json`'s version, e.g. `v1.2.0`) already exists on the
   remote - bump the version again before re-releasing.
4. The workflow creates a **draft** GitHub release tagged `v<version>` with auto-generated
   notes (every commit subject since the previous tag) and uploads the built installers
   plus signed updater artifacts. A separate `checksums` job then downloads those assets
   and publishes `SHA256SUMS.txt` on the same release (see `SECURITY.md` for why this
   matters given installers are unsigned).
5. Review the draft release and publish it manually when ready.

Installers are intentionally not code-signed (see `SECURITY.md`); do not add code-signing
steps to the release workflow.

## Commit conventions

Commits follow [Conventional Commits](https://www.conventionalcommits.org/), with rules
specific to this project:

- Format: `<type>: <imperative, lowercase subject>` - **no scope**.
- Subject is imperative mood, lowercase, and has **no trailing period**.
- English only.
- Allowed types, and *only* these: `fix`, `feat`, `build`, `ci`, `refactor`, `docs`,
  `test`, `chore`. There is no `perf`, `style`, or `revert` type in this project - a
  performance optimization is committed as `refactor`, not `perf`.
- Dependency updates (e.g. bumping a package or crate version) are committed as `build`,
  never `chore`.
- Never add a `Co-Authored-By` trailer.

Examples from this repository's history:

```
fix: distinguish "no comments" from a failed comment fetch on refresh
refactor: extract pure comment-tree and format-rules modules, drop a dead use-case
build: pin the Rust toolchain to 1.96.0 and tighten CI
ci: audit rust dependencies with cargo-audit
```

## Pull requests

Keep changes focused and include tests for new behavior (Vitest for frontend, `#[test]`/
`#[tokio::test]` for Rust). CI runs on every push/PR: frontend lint/test/build, Rust
fmt/clippy/test across Linux/Windows/macOS, the TS-bindings-freshness check, and a
`cargo audit` pass over Rust dependencies (RUSTSEC advisories are not covered by
`pnpm audit`, so this is a separate job).
