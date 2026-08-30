# Releasing

Cutting a release is a maintainer-only task. Every step below needs write access to the
repository (dispatching the workflow, pushing the version bump, publishing the draft) plus the
signing secrets, so it lives here rather than in `CONTRIBUTING.md`, which is for people who can
actually act on what it says.

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
   (`.github/workflows/release.yml`, `workflow_dispatch`. There is no automatic release
   on tag or merge). It builds installers across six matrix legs (Windows x64
   (`windows-2025`) and ARM64 (`windows-11-arm`), Linux x64 (`ubuntu-26.04`) and ARM64
   (`ubuntu-26.04-arm`), and both macOS architectures (`aarch64-apple-darwin`,
   `x86_64-apple-darwin` on `macos-26`)) runs the same
   lint/test/build and fmt/clippy/Rust-test/TS-bindings-freshness/dependency-audit checks CI
   does (the release is manually dispatched, so nothing guarantees the chosen commit already
   passed CI), and refuses to run if `v<version>` (matching `package.json`'s version, e.g.
   `v1.2.0`) already names a **published** release. Bump the version again before
   re-releasing. A tag left behind by a dispatch that failed partway is handled instead of
   refused; see "When a release dispatch fails" below. The Windows-on-ARM and preview
   `ubuntu-26.04-arm` legs first shipped in v1.2.0 and are now proven end to end; the one
   thing that leg needed was `xdg-utils`, which the arm64 runner image does not carry and the
   AppImage bundler refuses to run without (the apt step installs it explicitly on both Linux
   legs for that reason).
   Each leg then **starts the binary it just built**, twice, before anything is attested.
   `--smoke-test` runs the whole of `setup()` and exits, proving the process loads, every plugin
   registers and the database path resolves. `--webview-check` goes further, letting the window
   open and has the renderer report whether it could call `getVersion`, subscribe and unsubscribe
   from an event, and load an image through `convertFileSrc`, i.e. whether the capability grants
   in `src-tauri/capabilities/` and the packaged CSP actually work. Neither is reachable from
   `cargo test` (which never initializes the Tauri runtime) or from `pnpm tauri dev` (which serves
   the page from the Vite origin, with no CSP header). Both are skipped on the x86_64 macOS leg
   alone, which is a cross-compile on an arm64 runner and cannot execute its own output. A failure
   in either turns the run red with assets already on the draft, which is the intended outcome.
   The draft is published by hand, and a red run must not be published. What the webview check
   deliberately does not reach is the four plugin grants, because exercising any of them has a side
   effect a CI runner cannot take; step 6 below is the checklist that covers them by hand.
4. The workflow creates a **draft** GitHub release tagged `v<version>` whose body is a single
   line pointing at the release page, and uploads the built installers plus signed updater
   artifacts. That body is deliberately short rather than a commit log, because `tauri-action` copies
   it verbatim into `latest.json`'s `notes`, which the in-app update notice renders as one
   unscrolled block, so anything longer arrives as a wall of text in the update dialog. A
   release here can carry hundreds of commits, which is what made this a real problem rather
   than a stylistic one. A separate `sbom` job publishes a CycloneDX SBOM of the
   Rust dependency tree (`kavynex_<version>_sbom.cdx.json`), and a `checksums` job then
   downloads every asset, verifies the release is complete (the asset-completeness check.
   A missing installer or SBOM fails the release loudly rather than shipping silently), and
   publishes `SHA256SUMS.txt` on the same release (see `RELEASE-SECURITY.md` for why the checksums,
   SBOM and build provenance matter given installers are unsigned).

   That job also checks `README.md`'s download list against the assets the release actually
   carries (`scripts/verify-readme-asset-names.js`), in both directions. A name the README
   offers that is not there, and an installer the release ships that the README never mentions.
   It is a third inventory of the same filenames, after the completeness list and the
   attestation's `subject-path`, and it was the only one with nothing holding it. The README is
   what a user reads to pick their download. Both failures it covers have already happened around
   v1.2.0 (see "When a release dispatch fails" below for the renamed macOS bundles, and the
   Windows-on-ARM and Linux aarch64 installers, which shipped in that release and were added to
   the README by hand afterwards).
5. Write the release notes on the draft before publishing. This is where they go rather than
   in the workflow body, since editing a draft does not regenerate `latest.json`, so the text
   reaches the release page without reaching the in-app update notice, which renders that
   body unscrolled.
6. Work through the plugin-grant checklist below against the installed artifact.
7. Review the draft release and publish it manually when ready.

Installers are intentionally not code-signed (see `RELEASE-SECURITY.md`); do not add code-signing
steps to the release workflow.

### The plugin-grant checklist

Everything in `src-tauri/capabilities/` is evaluated by the ACL at runtime and nowhere else. A
permission that is missing, misspelled, or scoped too narrowly compiles, passes `cargo test`, passes
`pnpm build`, and fails on the first click a user makes. Two checks already cover part of that.
`scripts/verify-capability-surface.js` (every push) proves the granted list and the two seam files in
`src/lib/` cannot drift apart, and `--webview-check` (every release leg) proves the three `core:*`
grants and the asset protocol work in the packaged build.

Neither reaches the plugin grants, and the reason is that exercising one has a side effect no
unattended run may take, whether a file picker, a browser launch, a network call or a process
restart. So they are checked by hand, here, once per release. This list is what "review the draft" in step 7 means for
them.

Run it against the **installed artifact from the draft**, not `pnpm tauri dev`. The ACL itself is the
same in dev (the capabilities are compiled into the binary either way), so a missing grant is
catchable earlier than this. The artifact is what this step uses anyway because it is the build being
published, and because the updater half of the list does not behave realistically anywhere else.

- [ ] **`dialog:allow-open`**: Settings > Library folder > **Choose folder** opens the OS folder
      picker. Several other paths reach the same permission (the **Choose a video/audio file to
      import** row in Add media's local mode, **Choose file** beside the cookies path in its yt-dlp
      mode, the channel avatar and media thumbnail pickers, Settings > Database > **Import database**
      and **Choose backup folder**), so any one of them is enough. This one is the cheapest, since
      cancelling the picker changes nothing.
- [ ] **`dialog:allow-save`**: Settings > Database > **Export database** opens the OS save dialog.
      Unlike the one above there is no alternative path, since `saveFileDialog` has exactly this one
      caller, so nothing else exercises this grant.
- [ ] **`opener:allow-open-url`**: in the player, **Open source on YouTube** launches the browser on
      a media that has a YouTube source. Also the only caller of `openUrl`. This grant carries a URL
      allow-list (`youtube.com`, `youtu.be`), so the check proves the scope still matches the URLs
      the app builds, not merely that the permission is present.
- [ ] **`process:allow-restart`**: Settings > Database > **Import database**, pick a database, then
      **Replace and restart**. The app relaunches once the swap is staged. `relaunch` has three
      callers and the updater is only one of them, so this grant does **not** have to wait for a real
      update to be verified. **Use a throwaway install or export your database first.** The import
      keeps a safety copy and **Undo last import** reverts it, but do not let that be the only copy.
- [ ] **`updater:default`, the check half**: Settings > Application update > **Check for updates**
      returns an answer. "Kavynex is already up to date" counts. What matters is that it answers
      rather than failing, since an ACL refusal surfaces as an error.

`updater:default` is a preset, and it is worth knowing what the item above does and does not prove.
The set grants four permissions (`allow-check`, `allow-download`, `allow-install`,
`allow-download-and-install`). Clicking **Check for updates** exercises the first. The app never calls
the standalone download or install commands at all, so those two are granted and unused. The fourth
is the one that installs an update, and it cannot be exercised before publishing, because it needs a
published release newer than the version running.

So it is verified backwards, on the next cycle. Install the previous release, let it offer this one,
and take the update. That single action covers `allow-download-and-install` **and** the
`process:allow-restart` in the updater's own path, which is the one the item above does not reach.
Doing it once per release means each version's updater path is confirmed by the release that follows
it, and a break is found one version late rather than never. If the update does not install, say so
in the next release's notes, because users on that version have to reinstall by hand, and nothing in the app
can tell them.

### What the release builds

`bundle.targets` in `src-tauri/tauri.conf.json` names the seven bundlers explicitly (`nsis`,
`msi`, `app`, `dmg`, `appimage`, `deb`, `rpm`) rather than using `"all"`. Tauri runs only the
ones applicable to each runner, so the one list serves all six matrix legs.

Today that list *is* every value of the CLI's `BundleType` enum, so the change was deliberately
behavior-neutral. The point is what happens next time the enum grows. Under `"all"`, a Tauri
upgrade that adds a bundler changes what this project ships without a commit here, and nothing
downstream would say so. The asset-completeness check in `release.yml` only verifies that each
*expected* name is present and never flags an unexpected extra, and `SHA256SUMS.txt` is generated
with `sha256sum -- *` over whatever was attached. The provenance attestation, though, matches a
fixed list of extensions, so the new artifact would not be covered by it.

That combination is the failure worth avoiding, an installer on the release page, listed in
`SHA256SUMS.txt`, that fails the `gh attestation verify` the README tells users to run, while
every artifact beside it passes. Naming the targets makes a new bundler a no-op until someone
adds it here, and adding it then forces the two matching edits (the completeness list and the
attestation's `subject-path`) instead of leaving them to be noticed.

Dropping a target is the other thing this makes expressible. With `"all"` there was nowhere to
say that a format is not shipped.

### When a release dispatch fails

The tag is created by `tauri-action` in step 3, i.e. *before* the `sbom` and `checksums` jobs
run. A dispatch that built and signed everything and then failed one of those later gates
therefore leaves the tag behind on a release that is still a draft. That is a normal outcome,
not a corrupted state, and it does **not** cost a version number:

- **A later job failed (asset-completeness, `latest.json`, SBOM upload).** Fix the cause and
  re-dispatch the same version. The tag guard recognizes a tag whose release is still a draft
  and lets the run through with a warning; `tauri-action` reuses the existing draft and
  re-uploads its assets. The asset-completeness check is the most likely first failure whenever
  a bundler's naming shifts. The run echoes the actual asset names above the failure, which is
  what to compare the patterns against. Every name in that list was confirmed against the v1.2.0
  dispatch, and the lesson from it was that the list is perishable in both directions. The arm64
  names, flagged in the workflow as unconfirmed, all held, while the macOS `.app.tar.gz` names (the pair that *had* been observed on v1.1.1) had since gained the version and were the ones
  that broke.
- **A build leg failed.** Same thing, re-dispatch. The `sbom` and `checksums` jobs deliberately
  run even when a leg fails (`if: ${{ !cancelled() }}`), so the incomplete draft is reported
  rather than silently left publishable.
- **The release was already published.** The guard refuses, correctly. A published release is
  final. Bump the version and release again.
- **The tag exists with no release behind it** (a draft deleted by hand). The guard refuses,
  since nothing proves what the tag points at. Delete the tag on the remote
  (`git push origin :refs/tags/v<version>`) and re-dispatch, or bump the version.

Never delete or re-upload an asset on an *already published* release. `latest.json` and the
minisign signatures are what the updater trusts, and rewriting a published release is the one
operation the updater's rollback exposure (see `RELEASE-SECURITY.md`) actually depends on not happening.
