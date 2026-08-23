# Release and update security

This document covers what Kavynex does to make the artifacts it ships verifiable, and which
risks in that chain are accepted rather than closed: the updater and its rollback exposure, why
the installers are unsigned, build provenance, the SBOM, and the dependency supply chain.

What the app defends against *while running* is in [`THREAT-MODEL.md`](THREAT-MODEL.md). To
report a vulnerability, see [`SECURITY.md`](../SECURITY.md).

## Updater

The updater (`tauri-plugin-updater`) checks a fixed HTTPS endpoint on GitHub
(`https://github.com/eduardoghi/kavynex/releases/latest/download/latest.json`,
`tauri.conf.json`). By default this happens only when the user opens Settings and explicitly
asks it to check. There is no automatic/background check. A single passive check on startup
is available as an **opt-in** setting (Settings > Application update,
`check_updates_on_startup`), off by default, so the app contacts the endpoint on launch only
after the user turns it on; when it does, an available update is surfaced as a non-intrusive
notice, never auto-downloaded. Downloaded update artifacts are verified against a minisign
public key embedded in `tauri.conf.json` before being installed; the matching private key is
held by the release workflow's GitHub secrets and never checked into the repository.

### Accepted risk: the updater can be rolled back to an older signed release

The minisign signature covers the *bytes of each update artifact*, not the `latest.json` that
names which version is current. `latest.json` carries the version string and the artifact URL,
and the client only compares that version against the installed one. It has no notion of a
monotonic release counter or a signed timestamp (the `tauri-plugin-updater` protocol has no TUF-
style freeze/rollback protection). So an attacker who can *write to the GitHub release* (which
is a weaker capability than holding the minisign private key, since release assets stay editable
after publication) could repoint `latest.json` at an **older, already-signed** artifact from a
previous release while advertising a higher version number. Every already-published artifact keeps
a valid signature forever, so the client would accept it and effectively downgrade the app to a
prior (possibly vulnerable) version. The signature check is not bypassed here; it is simply not a
freshness check.

This is a structural limitation of the updater protocol rather than a defect in Kavynex, and a
full fix (a signed version counter, or TUF metadata) is disproportionate for a solo project. What
reduces the exposure: the release is always created as a draft and published by hand (`release.yml`,
`docs/RELEASING.md`), the endpoint is a fixed HTTPS URL under an account protected by the repository's
own access controls, and published release assets are never rewritten in the normal flow. The
`checksums` job only *adds* `SHA256SUMS.txt`. Rotating the minisign key does **not** address this
one (the old artifacts stay validly signed under the old key); the mitigations that matter are the
GitHub account controls and not tampering with an already-published release. It is recorded here
rather than left implicit because "the update is signed" reads as stronger than it is.

### Windows install mode and automatic relaunch

On Windows the updater runs the downloaded installer in `passive` mode (`installMode`,
`tauri.conf.json`): the NSIS installer shows a minimal progress bar and proceeds without a wizard
click, and once it finishes the app calls `relaunch()` itself (`src/services/app-update-service.ts`).
So the full sequence (signature-verified download, install, restart), completes from the single
click the user makes on "Download and install update"; there is no second "install now?" prompt in
between. This is deliberate rather than an oversight. The trust decision has already been made by
then: the artifact's minisign signature is verified before the installer runs (see above), so the
bytes being installed are the key holder's, and a second confirmation would gate a step that is
already cryptographically gated. `passive` (rather than the fully silent `quiet`) is chosen so the
install still shows progress and cannot run entirely invisibly, and the update path is only ever
entered from an explicit user action, never a background auto-install (the optional startup check
only *surfaces a notice*, it does not download or install). It is recorded here because every other
security-relevant default in Kavynex has its reasoning written down, and "installs and relaunches
from one click" is the kind of behavior a reviewer should find explained rather than infer.

## Installers are unsigned by design

Kavynex's installers (the `.exe`/`.msi` on Windows, the `.dmg` on macOS, the
`.AppImage`/`.deb`/`.rpm` on Linux) are **not code-signed**. This is a deliberate,
accepted tradeoff for a solo-maintained, MIT-licensed project. A code-signing
certificate is a recurring cost that is hard to justify here. In practice this means:

- Windows SmartScreen and macOS Gatekeeper will warn on first run; this is expected and
  is not evidence of tampering.
- *Download* integrity for a manually downloaded installer is provided by `SHA256SUMS.txt`,
  published alongside the installers (`.github/workflows/release.yml`'s `checksums` job).
  Compare the hash of what you downloaded against that file. Note what this does and does
  not prove: the `checksums` job hashes the assets already attached to the release, so the
  file tells you your copy matches what the release page serves (it catches a truncated or
  corrupted download), not that those assets are what the build produced. Tying an installer
  back to the source and the CI run that built it is what the build provenance below is for.
- The updater path (in-app update, once installed) does not rely on installer signing at
  all; it relies on the minisign signature described above, which is independent of OS
  code-signing.

## When these three controls started applying

`SHA256SUMS.txt` and the provenance attestation were both added to the release workflow after
v1.1.1 shipped (the `checksums` job and `actions/attest-build-provenance` respectively), so
**v1.2.0 is the first release carrying either**. On v1.1.1 and earlier, `gh attestation verify`
reports *no attestation* for an installer rather than a failed check. The minisign signature on
the updater artifacts predates both and applies to every release. This is recorded rather than
quietly implied, because "verify the hash" is useless advice if the file it names is not there.

Both were exercised against v1.2.0 after it was published: the published `SHA256SUMS.txt` matches
a freshly downloaded installer, and `gh attestation verify` on that installer resolves to this
repository's `release.yml` at the commit the release was built from.

## Build provenance

Every released installer also carries a build provenance attestation
(`.github/workflows/release.yml`, `actions/attest-build-provenance`): a signed, keyless
(Sigstore) statement that those exact bytes were built by this repository's release workflow,
from a specific commit. It complements the other two controls rather than replacing them.
`SHA256SUMS.txt` only proves a download was not corrupted, and the minisign signature proves
the *update* artifact was signed by the key holder, whereas provenance ties an *installer* back
to the source and CI run that produced it. It is independent of OS code-signing and needs no
certificate.

To verify a downloaded installer, with the [GitHub CLI](https://cli.github.com/) installed:

```
gh attestation verify <installer-file> --repo eduardoghi/kavynex
```

A successful check confirms the file was built by this repository's release workflow.

The three files added to the release after the installers are attested too, by the `checksums`
job once every completeness check has passed: `SHA256SUMS.txt`, `latest.json` and the SBOM. The
first is the one that matters for a manual download. The README tells a downloader to compare
their installer against `SHA256SUMS.txt`, and without a statement on that file the comparison
proved only that two things a third party could both have written agree with each other. The same
`gh attestation verify` command works on it.

## Software Bill of Materials (SBOM)

Every release also publishes a CycloneDX SBOM (`kavynex_<version>_sbom.cdx.json`,
`.github/workflows/release.yml`'s `sbom` job) of the Rust dependency tree that goes into the
shipped binary. It is generated with `cargo-cyclonedx` from the committed `Cargo.lock`, so it lists
the exact crate versions a given release contains. The machine-readable answer to "does this
release ship crate X at version Y?" when an advisory lands after the fact, without recompiling or
walking the dependency graph by hand. Its hash is part of `SHA256SUMS.txt` and its presence is
enforced by the `checksums` job's asset-completeness check, so a release missing it fails loudly
rather than shipping silently.

The SBOM covers the *native* dependency tree only. The frontend's build-time npm tree is bundled
into the webview assets rather than being a runtime dependency of the binary, and is already
advisory- and license-gated (`frontend-audit` job, `scripts/check-js-advisories.js` /
`scripts/check-js-licenses.js`) and pinned in `pnpm-lock.yaml`. Like `SHA256SUMS.txt` and the
provenance attestation, the SBOM applies from v1.2.0 onward, not retroactively (see "When these
three controls started applying" above).

## Static analysis (CodeQL)

CodeQL analyses three languages (`rust`, `javascript-typescript` and `actions`), on pushes to
`main`, on pull requests, and on a weekly schedule. Its results are on the repository's
**Security > Code scanning** tab rather than in a job log; `gh api
repos/eduardoghi/kavynex/code-scanning/alerts` answers the same question from a terminal.

It runs from `.github/workflows/codeql.yml`, and it did not always. Until then it ran through
GitHub's **default setup**, configured in the repository settings with no file behind it, and this
section existed mostly to tell a reader that the absence of a workflow did not mean the absence of
static analysis.

The move to a workflow changed where the configuration lives, not what is analysed. The languages,
the query suite and the schedule were the ones default setup was running, read back from the API
before the switch. What it buys is the property every other gate in this repository already had:
the analysis is pinned (the action by SHA, the runner by OS major), it is reviewable in a diff, and
it travels with a fork. A language quietly dropped or a suite quietly narrowed now shows up as a
change to a file rather than as nothing at all.

The suite was then widened, as its own change, from `default` to `security-extended`. The extended
suite carries more variants of the classes this app's threat model is about (caller-supplied paths
reaching the filesystem, URLs reaching the network, argument vectors reaching a spawned process) at
a lower precision, so it names things the code already guards in ways the analyzer cannot follow.
Those are dismissed with a reason in the code-scanning view rather than silenced in the workflow,
which keeps the next real finding from arriving pre-suppressed. `security-and-quality` is not used:
its extra queries are about code quality, which clippy and ESLint already gate.

One property is unchanged and still worth knowing: CodeQL analyses **what has been pushed**, which
is not always what has been written. A run green against `origin/main` says nothing about commits
that exist only on a maintainer's machine. That is an argument for pushing often rather than against
the tool, and it remains the one gate in this document that cannot be run locally before a release.

## Accepted risk: the signing key is present while dependencies build

The release workflow's build step (`.github/workflows/release.yml`, `tauri-apps/tauri-action`)
runs `cargo build` and signs the resulting artifacts in one invocation, so
`TAURI_SIGNING_PRIVATE_KEY` and a `contents: write` `GITHUB_TOKEN` are in the environment while
the whole transitive Rust dependency tree compiles, including every crate's `build.rs`. A
compromised transitive dependency, or a compromised release of the action itself, could read
both during the compile phase, before any signing happens.

This is a known, accepted risk rather than an oversight, and it is structural: `tauri-action`
does not separate building from signing, so the two cannot be split into a job that holds the
secret and a job that does not. What is done about it:

- Every action is pinned to a full commit SHA, so a tag cannot be repointed at new code.
- The `permissions:` blocks are per-job; only the build job holds `contents: write` /
  `id-token: write`, and the dependency-audit job (which installs and runs `cargo-audit` /
  `cargo-deny`) is a separate job with no access to the signing secrets.
- The release build deliberately skips the Rust build cache that CI uses, so a poisoned cache
  entry cannot reach the job that holds the key.
- Releases are always created as drafts and published by hand, so a build is inspected before
  the updater endpoint can ever serve it.

The residual exposure is a malicious `build.rs` in a dependency the lockfile already pins,
reading the environment during a release build. `minimumReleaseAge` and `blockExoticSubdeps`
(`pnpm-workspace.yaml`) plus `cargo-deny`'s source allow-list are what reduce the chance of such
a dependency arriving in the first place; nothing in the current workflow removes the exposure
itself. Rotating the minisign key is the response if a compromise is ever suspected.

One asymmetry is worth stating plainly, because the two ecosystems get their publish-age
cooling-off from different places and the two places do not cover the same thing:

- **npm** has `minimumReleaseAge` (`pnpm-workspace.yaml`, 2880 minutes), which pnpm enforces on
  *every install*, including CI's `pnpm install --frozen-lockfile`. It is a property of the
  package manager, so nothing can add a too-new package to the tree, however the bump was
  authored.
- **Both trees, plus the actions** have Dependabot's `cooldown: default-days: 5`
  (`.github/dependabot.yml`), which delays the *pull request* Dependabot would open. It is a
  property of the bot, not of the resolver.

So the Cargo tree is not without a cooling-off, but the one it has is weaker in a specific way:
it only governs bumps Dependabot proposes. A hand-run `cargo update`, or a version edited into
`Cargo.toml` directly, is subject to no age gate at all, because `cargo-deny` restricts the
*source* (crates.io only), the license and duplicate/wildcard bans, and never the *publish age*.
A newly-published malicious version of an already-allowed crate reaching the tree that way is the
residual gap on the Rust side. What limits it is the pinned `Cargo.lock` (any bump is a reviewed,
deliberate commit, never an automatic resolution at build time, and `release.yml` now proves that
with `cargo metadata --locked` plus a `--locked` build), the weekly `scheduled-audit` workflow, and
the same draft-and-publish-by-hand release flow.
