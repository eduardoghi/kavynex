# Contributing

Kavynex is a solo-maintained, MIT-licensed project. Contributions are welcome, but keep in
mind there is a single maintainer reviewing everything. Small, focused changes are easier
to review than large ones. This document covers dev setup, day-to-day commands, how the
generated TypeScript bindings work, and commit conventions.

See also `docs/ARCHITECTURE.md`, `docs/DATABASE.md`, `docs/DIRECTORIES.md`, and
`docs/THREAT-MODEL.md` for how the app is put together and why its safety checks exist.
`CODE_OF_CONDUCT.md` covers what is expected of everyone taking part, and `SUPPORT.md` is where
to send someone who has a bug to report rather than a change to propose.

## Prerequisites

- [Node.js](https://nodejs.org/): match the range pinned in `package.json`'s `engines.node`
  field (currently `>=26 <27`; `.nvmrc` pins the exact patch the CI/release workflows use), so
  local builds and CI agree
- [pnpm](https://pnpm.io/): match the `pnpm/action-setup` major those workflows pin
- [Rust](https://www.rust-lang.org/), via [rustup](https://rustup.rs/). The exact
  toolchain is pinned in `rust-toolchain.toml` (`1.96.0`, with `rustfmt` and `clippy`).
  Rustup will pick it up automatically when you run any `cargo`/`rustc` command inside the
  repo, so there is nothing to configure manually. Bump that file deliberately (and rerun
  `cargo fmt`/`clippy`/tests) rather than letting the toolchain drift.
- [yt-dlp](https://github.com/yt-dlp/yt-dlp) and [FFmpeg](https://ffmpeg.org/), available
  on `PATH` (see `docs/TROUBLESHOOTING.md` for exactly how Kavynex resolves them).
- The OS-level Tauri prerequisites for your platform (WebView2 on Windows, usually
  already present). On Linux, the authoritative list is `ci.yml`'s "Install Linux
  dependencies" step, which installs `libwebkit2gtk-4.1-dev`,
  `libayatana-appindicator3-dev`, `librsvg2-dev` and `patchelf`. That step also installs `lld`,
  which is not a prerequisite. It is a faster linker CI uses to keep the cold compile down on a
  2-vCPU runner, and nothing here needs it locally. (`release.yml` additionally installs
  `xdg-utils`, which the AppImage bundler requires; see `docs/RELEASING.md`.) Note the *ayatana*
  spelling: Ubuntu 24.04 dropped `libappindicator3-dev`, so the older name this list used
  to carry now fails to install on every image the workflows run on. See the
  [Tauri prerequisites guide](https://v2.tauri.app/start/prerequisites/) if your platform
  needs something not listed here.

## Setup and day-to-day commands

```bash
pnpm install
pnpm tauri dev
```

Frontend:

- `pnpm lint`: ESLint (`eslint.config.js`). It is `eslint .`, not a `src`-only run: the config
  carries a block for `src/**/*.{ts,tsx}` and a second one for `scripts/**/*.js` (Node globals
  rather than browser), so the repository-consistency scripts below are linted too. `src-tauri/`,
  `src/types/generated/`, the build output and Stryker's sandboxes are ignored.
- `pnpm advisories:check`: fails on a high/critical security advisory in the production
  dependency tree, querying osv.dev (add `--dev` for the toolchain tree, which CI reports but
  does not gate on). This replaced `pnpm audit`, which npm's retired audit endpoints broke for
  every pnpm version. See `scripts/check-js-advisories.js`.
- `pnpm licenses:check`: fails on a production dependency whose license is not allow-listed.
- `pnpm test`: Vitest in watch mode.
- `pnpm test:run`: Vitest, single run (what CI uses).
- `pnpm test:mutation`: Stryker mutation testing (`stryker.config.json`); slower, run it
  when you want confidence in a test suite's actual coverage of behavior, not just line
  coverage.
- `pnpm build`: `tsc` (typecheck) then `vite build`.

Backend (run from the repo root; Cargo commands need `--manifest-path src-tauri/Cargo.toml`
unless you `cd src-tauri` first):

- `cargo test --manifest-path src-tauri/Cargo.toml`: the Rust test suite.
- `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`: lint,
  matching CI (`-D warnings` fails the build on any clippy warning).
- `cargo fmt --manifest-path src-tauri/Cargo.toml --all`: format (CI runs
  `--check`, i.e. it fails if this would change anything, it does not auto-fix for you).

Repository consistency (plain Node, no install needed. CI runs all five on every push):

- `node scripts/verify-release-version.js`: fails when `package.json`,
  `src-tauri/tauri.conf.json` and `src-tauri/Cargo.toml` disagree about the version.
- `node scripts/verify-node-version.js`: fails when the Node version in `.nvmrc` and the
  `node-version:` values in the workflows disagree.
- `node scripts/verify-command-path-surface.js`: fails when either half of the cross-cutting path
  rule no longer matches its declared inventory: the set of `#[tauri::command]`s taking a path from
  the caller, and the set of functions calling `is_network_path` to refuse a network location.
  Adding such a command (or a path parameter to an existing one) is meant to stop here, so the new
  path gets classified under `docs/THREAT-MODEL.md`'s cross-cutting path rule rather than slipping
  in unexamined; adding or removing a guard stops here too, so that document's table of enforcement
  sites cannot drift from the code the way it once did. Run it with `--print` to regenerate both
  inventories once the document is right.
- `node scripts/verify-capability-surface.js`: fails when the Tauri APIs the two seam files import
  and the permissions `src-tauri/capabilities/` grants drift apart in either direction, so a new
  binding cannot ship without its permission being decided and a grant cannot outlive the call that
  needed it. Run it with `--print` to see the current seam surface.
- `node scripts/verify-command-surface-is-used.js`: fails when a command registered in
  `generate_handler!` has no constant, no wrapper, or no caller anywhere in `src/`. A command
  nothing calls is still reachable from the renderer, and two that unlinked files stayed registered
  for weeks that way. Run it with `--print` to see each command's wrapper and how many files call it.

A sixth consistency check needs cargo-mutants installed, so it runs in `mutation.yml` rather than
on every push:

- `node scripts/verify-mutants-exclusions.js <cargo mutants --list output>`: fails when an
  `exclude_re` entry in `src-tauri/.cargo/mutants.toml` matches no mutant. Such an entry is silent
  in both directions: the mutant it suppressed comes back and reddens the weekly run for a reason
  unrelated to the tests, or the function it named was renamed and its real mutant is now
  unexcluded and unnoticed among the survivors. Two entries had already died that way before this
  existed, both after a pure extraction moved the code they named. To run it locally:

  ```bash
  mapfile -t FILE_ARGS < <(node scripts/verify-mutants-exclusions.js --file-args)
  cargo mutants --manifest-path src-tauri/Cargo.toml --list --no-config --colors never \
      "${FILE_ARGS[@]}" > /tmp/mutants.txt
  node scripts/verify-mutants-exclusions.js /tmp/mutants.txt
  ```

  `--no-config` is required: a listing that applied the config would already have removed every
  mutant the exclusions name, so every pattern would read as dead. It also drops `examine_globs`,
  which is why the scope is passed back in from that same list via `--file-args`.

A fifth needs a real release to check against, so it runs in `release.yml`'s `checksums` job:

- `node scripts/verify-readme-asset-names.js <file with one asset name per line>`: fails when
  `README.md`'s download list and the assets a release carries disagree, in either direction: a
  name the README offers that is not there, or an installer the release ships that the README never
  mentions. Both have already happened (see `docs/RELEASING.md`). To run it against a published
  release:

  ```bash
  gh release view v1.2.0 --json assets --jq '.assets[].name' > /tmp/assets.txt
  node scripts/verify-readme-asset-names.js /tmp/assets.txt
  ```

`pnpm tauri build` builds release installers for your current platform.

## Reading `git blame` past move-only commits

`.git-blame-ignore-revs` lists commits that only moved or reformatted code (the first entry moved
the eight largest inline Rust test modules into `tests.rs` files beside their parents). Without it,
`git blame` on one of those files attributes every line to the move rather than to the commit that
wrote the test and explains why. Point git at the file once per clone:

```bash
git config blame.ignoreRevsFile .git-blame-ignore-revs
```

GitHub's blame view reads the file on its own. When a commit of that kind lands (a mass reformat, a
rename of a large file, a test module moved out), add its hash there in the same commit or the one
right after, while it is still obvious which one it was.

## Regenerating the TypeScript bindings

Rust types shared with the frontend derive `ts_rs::TS` and export to
`src/types/generated/`. After changing one of those types (or adding a new one), regenerate
the bindings and check the diff in:

```bash
cargo test --manifest-path src-tauri/Cargo.toml --lib export_bindings
```

CI (`ci.yml`, Ubuntu only) runs the same command and then `git diff --exit-code -- src/types/generated`
to fail the build if the checked-in bindings are stale. Never hand-edit a file under
`src/types/generated/`. Change the Rust type instead and rerun the command above. See
`docs/ARCHITECTURE.md` for where these types fit in the IPC boundary.

### Field naming on IPC types

A **new** type crossing the IPC boundary uses camelCase field names on the wire: put
`#[serde(rename_all = "camelCase")]` on the struct/enum so the generated TypeScript reads
naturally on the frontend (`StoredAppSettingsPayload` and `MediaPageQuery` are the reference
examples). Do not mix per-field `#[serde(rename = ...)]` with unrenamed siblings on the same
type.

Many existing types (`Channel`, `MediaRow`, the yt-dlp event payloads, ...) predate this rule
and expose raw snake_case; the frontend consumes them as generated, so nothing is broken.
Migrating one is a deliberate, self-contained change (add the attribute, regenerate the
bindings, and update every frontend usage and test fixture in the same commit), not something
to do in passing while touching a type for another reason.

## Frontend hook conventions

The controller hooks under `src/hooks/` follow a small set of rules that keep the media grid and the
player from re-rendering on unrelated state changes. They are enforced by convention (and by
`eslint-plugin-react-hooks`), not by a dedicated lint rule, so they are collected here as the single
reference the inline comments point back to. A new hook that ignores them will usually still work,
just slower. The failure mode is extra renders, not a crash, which is exactly why it is easy to let
drift in unnoticed.

**Where a new hook goes** is the same question the backend answers in `docs/ARCHITECTURE.md`, with
the same rule: a feature family that outgrew a shared filename prefix becomes a directory, and
everything else stays flat. Today that is `home/`, `media/`, `channels/` and `settings/`. Put a new
hook in the family it belongs to if one exists; leave it at the root otherwise, including when it
would be the second or third of a prefix that has not grown into a directory yet. A hook with no
feature at all (a reusable primitive like `useAsyncFlag` or `useRequestGuard`), belongs at the root
permanently, because a directory would imply it serves one area when every area calls it.

- **Return a reference-stable controller.** Build a hook's return value with `useMemoObject({...})`
  (`src/hooks/use-memo-object.ts`) rather than a bare object literal, so its identity only changes
  when one of its fields does. A fresh object every render invalidates every consumer that depends
  on the whole controller.
- **Depend on the specific stable fields, not the whole controller object.** When a hook receives
  another controller as input, destructure the individual fields it needs off it and list *those* in
  the `useCallback`/`useEffect`/`useMemo` dependency arrays, never the per-render controller object
  itself, whose identity changes every render and would recreate the callback (and, transitively,
  every per-card handler derived from it) on any unrelated change. `home/use-home-media-actions.ts`
  and `home/use-home-player-actions.ts` are the reference examples.
- **Do not reach for `eslint-disable react-hooks/exhaustive-deps`.** The destructure-stable-fields
  rule above is what lets the dependency arrays stay honest without it. The few genuine exceptions
  (`use-memo-object.ts`, `media/use-media-progress-persistence.ts`, `add-media-modal.tsx`) each carry a
  comment explaining why the omission is correct; a new one needs the same justification, not a bare
  disable.
- **Keep the latest value in a ref when a callback must read it without depending on it.** When a
  callback needs the current value of something that changes often (e.g. the active media) but must
  not be recreated when it changes, mirror it into a ref updated in an effect and read the ref inside
  the callback. See the `activeMediaRef` pattern in `media/use-media-actions.ts`.

## Commit conventions

Commits follow [Conventional Commits](https://www.conventionalcommits.org/), with rules
specific to this project:

- Format: `<type>: <imperative, lowercase subject>`, with **no scope**.
- Subject is imperative mood, lowercase, and has **no trailing period**. Keep it short.
- English only.

Allowed types, and *only* these:

| Type | For |
|---|---|
| `fix` | a bug fix |
| `feat` | a new feature |
| `build` | the build, packaging or dependencies |
| `ci` | the CI pipeline. Workflows, triggers, matrix, cache, secrets |
| `refactor` | a code change that neither fixes a bug nor adds a feature |
| `perf` | a code change that improves performance |
| `docs` | documentation only |
| `test` | adding, fixing or adjusting tests |
| `style` | formatting that does not change behavior. Whitespace, indentation, line breaks |
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
`#[tokio::test]` for Rust).

`ci.yml` runs six jobs on every push/PR, and all six gate the change. Read that file for the
authoritative version; what follows is what to expect a red run to be about:

- **Frontend**: lint, the Vitest suite *with coverage* (`pnpm test:coverage`; the floors in
  `vitest.config.ts` are only enforced when coverage is collected, so this is where a coverage
  regression fails), build, the production JS advisory and license gates (the dev-tree advisory
  scan runs too but is non-blocking), the three repository-consistency scripts above, and a grep
  refusing a unicode dash where a plain `-` belongs, if a test needs one of those characters as
  data, spell it as a `\uXXXX` escape rather than pasting it.
- **Frontend tests (Windows, macOS)**: the same suite on the other two platforms. It is jsdom
  but not fully platform-independent: date formatting varies with the runner's ICU.
- **Rust (Linux, Windows, macOS)**: `fmt --check`, `clippy -D warnings` and `cargo test` on
  each platform. Three further steps are Ubuntu-only, since they read the tree as text and are
  platform-independent: the TS-bindings-freshness check, and two greps that are easy to trip
  without knowing they exist. A temporary path must come from
  `utils::naming::unique_temp_suffix` rather than a raw `as_nanos()`, and a path logged near a
  `logger::` call must go through `services::logger::redact_path` rather than `Path::display()`
  or `{:?}` (which prints the whole path too).
- **Cargo audit and deny**: RUSTSEC advisories (not covered by the JS advisory check, hence a
  separate job), plus licenses, sources and bans via `cargo-deny`.
- **Rust coverage**: publishes the per-file table and fails under a line floor. A backstop
  against a module landing untested, not a percentage to chase.
- **Workflow lint**: `actionlint` over the workflow YAML, including shellcheck on every
  `run:` block.

Mutation testing is *not* on this path: it runs weekly (`mutation.yml`), Stryker over the
frontend and cargo-mutants over the Rust modules in `src-tauri/.cargo/mutants.toml`'s
`examine_globs`, sharded so no leg runs toward its timeout.
