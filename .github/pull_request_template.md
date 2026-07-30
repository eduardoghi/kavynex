<!--
Keep this short. The checklist is what CI already enforces, gathered in one place so a red run
is a surprise rather than the first time anyone looks - not extra process for its own sake.
-->

## What this changes

<!-- What it does and, more usefully, why. The diff shows the what. -->

## How it was verified

<!--
Which tests you added or ran, and anything you checked by hand that a test cannot reach - the
app actually opening, a real download, a migration against an existing database.
-->

## Checklist

- [ ] `pnpm lint` and `pnpm test:run` pass
- [ ] `cargo fmt --manifest-path src-tauri/Cargo.toml --all --check` and
      `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings` pass
- [ ] `cargo test --manifest-path src-tauri/Cargo.toml` passes
- [ ] New behavior has a test (Vitest, or `#[test]` / `#[tokio::test]`)
- [ ] Commits follow the convention in `CONTRIBUTING.md` (`<type>: <imperative, lowercase>`, no
      scope, no trailing period)

<!-- Delete any that do not apply: -->

- [ ] A Rust type crossing IPC changed, and the bindings were regenerated
      (`cargo test --manifest-path src-tauri/Cargo.toml --lib export_bindings`)
- [ ] A new command takes a path from the caller, and `SECURITY.md`'s list of those was updated
- [ ] The database schema changed, and `docs/DATABASE.md` plus `SCHEMA_VERSION` were updated
