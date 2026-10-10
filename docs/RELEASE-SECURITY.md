# Release and update security

This document covers what Kavynex does to make the artifacts it ships verifiable, and which
risks in that chain are accepted rather than closed, covering the updater and its rollback exposure,
why the installers are unsigned, build provenance, the SBOM, and the dependency supply chain.

What the app defends against *while running* is in [`THREAT-MODEL.md`](THREAT-MODEL.md). To
report a vulnerability, see [`SECURITY.md`](../SECURITY.md).

## Updater

The updater (`tauri-plugin-updater`) checks a fixed HTTPS endpoint on GitHub
(`https://github.com/eduardoghi/kavynex/releases/latest/download/latest.json`,
`tauri.conf.json`). Kavynex runs a single passive check on startup, and that setting (Settings >
Application update, `check_updates_on_startup`) is **on by default**. Only the latest release
receives fixes, so this check is the path by which one reaches a user, and a default that never
contacted the endpoint left that path unused for anyone who never went looking for the toggle.
Storing `"false"` turns it off and is the only value that does, so an absent key (a database
written before this became the default) reads as on. Settings also offers a check on demand.
What a check produces is a non-intrusive notice. The update is never auto-downloaded and never
installed without the user starting it. Downloaded update artifacts are verified against a minisign
public key embedded in `tauri.conf.json` before being installed. The matching private key and its
password are secrets of the repository's `release` environment, never checked into the repository,
and that environment only admits runs on `main`.

The endpoint is fixed, but the rest of the request is not entirely. The renderer holds
`updater:allow-check`, and the plugin's `check` takes a proxy, extra headers, a timeout and a target
platform from its caller. None of that can change where the manifest comes from or what signature an
update must carry, so the worst a compromised renderer gets is routing the check through a proxy of
its choosing (which learns the user's address and that the app is running, inside a TLS tunnel) or
asking for another platform's artifact, which then fails to install. Accepted, since moving the check
behind a backend command would only remove that nuisance.

### Accepted risk: the updater can be rolled back to an older signed release

The minisign signature covers the *bytes of each update artifact*, not the `latest.json` that
names which version is current. `latest.json` carries the version string and the artifact URL,
and the client only compares that version against the installed one. It has no notion of a
monotonic release counter or a signed timestamp (the `tauri-plugin-updater` protocol has no TUF-
style freeze/rollback protection). So an attacker who can *publish a release* (a weaker
capability than holding the minisign private key) could put out a new version whose `latest.json`
points at an **older, already-signed** artifact from a previous release while advertising a higher
version number. Every already-published artifact keeps a valid signature forever, so the client
would accept it and effectively downgrade the app to a prior (possibly vulnerable) version. The
signature check is not bypassed here. It is simply not a freshness check.

This is a structural limitation of the updater protocol rather than a defect in Kavynex, and a
full fix (a signed version counter, or TUF metadata) is disproportionate for a solo project. What
reduces the exposure is that the release is always created as a draft and published by hand (`release.yml`,
`docs/RELEASING.md`), and the endpoint is a fixed HTTPS URL under an account protected by the
repository's own access controls.

The repository also has GitHub's **immutable releases** turned on, and every published release
(v1.0.0 through v1.7.0, checked on 2026-10-06) reports `immutable: true`. Once a release is
published its assets and its tag can no longer be changed or deleted, so the `latest.json` of a
release that already went out cannot be repointed after the fact. That narrows the attack above to
publishing a *new* release, which immutability does nothing to stop. The setting has to stay on
for this paragraph to hold. A draft is still mutable, which is what lets the `sbom-upload` and
`checksums` jobs add their files before the release is published by hand.

Rotating the minisign key does **not** address this one (the old artifacts stay validly signed
under the old key). The mitigations that matter are the GitHub account controls and immutable
releases. It is recorded here rather than left implicit because "the update is signed" reads as
stronger than it is.

### Windows install mode and automatic relaunch

On Windows the updater runs the downloaded installer in `passive` mode (`installMode`,
`tauri.conf.json`). The NSIS installer shows a minimal progress bar and proceeds without a wizard
click, and once it finishes the app calls `relaunch()` itself (`src/services/app-update-service.ts`).
So the full sequence (signature-verified download, install, restart), completes from the single
click the user makes on "Download and install update"; there is no second "install now?" prompt in
between. This is deliberate rather than an oversight. The trust decision has already been made by
then, since the artifact's minisign signature is verified before the installer runs (see above), so the
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
  not prove. The `checksums` job hashes the assets already attached to the release, so the
  file tells you your copy matches what the release page serves (it catches a truncated or
  corrupted download), not that those assets are what the build produced. Tying an installer
  back to the source and the CI run that built it is what the build provenance below is for.
- The updater path (in-app update, once installed) does not rely on installer signing at
  all; it relies on the minisign signature described above, which is independent of OS
  code-signing.

### The macOS bundle is ad-hoc signed, which is not the same as unsigned

`bundle.macOS.signingIdentity` is `"-"` in `tauri.conf.json`, which makes the build run a real
`codesign` pass with no identity. That costs nothing and needs no Apple account, so it is not in
tension with the decision above. What is being declined is a Developer ID certificate and
notarization, which is what removes the warning. An ad-hoc signature does not remove it.

The distinction is worth stating because there are three levels here, not two, and this project sat
on the wrong one until v1.5.0 without meaning to. A bundle with **no** seal, a bundle sealed
ad-hoc, and a bundle signed with a recognized identity are three different things to Gatekeeper.
Through v1.5.0 the `.app` carried only the signature the linker adds to the executable itself:
`codesign -dv` reported `adhoc,linker-signed` with `Info.plist=not bound` and no special slots, so
the bundle as a whole was unsealed.

That is what made macOS report **"kavynex is damaged and can't be opened"**, wording that reads as
a corrupt download and sends the user to check a file that is perfectly fine.

Sealing the bundle moved it, and v1.6.0 is the first release where that was measured rather than
predicted. On macOS 26.6.1 the sealed build says it **could not verify kavynex is free of
malware**, and offers an **Open Anyway** button under System Settings > Privacy & Security that the
"damaged" case on the same machine never showed. Clicking it asks once more, with "Move to Bin" as
the highlighted button, and then for an administrator password, so the route exists without being
short. "Unidentified developer" is the older phrasing for this path and is not what current macOS
shows, which matters when matching a user's report against `TROUBLESHOOTING.md`.

## When these three controls started applying

`SHA256SUMS.txt` and the provenance attestation were both added to the release workflow after
v1.1.1 shipped (the `checksums` job and `actions/attest-build-provenance` respectively), so
**v1.2.0 is the first release carrying either**. On v1.1.1 and earlier, `gh attestation verify`
reports *no attestation* for an installer rather than a failed check. The minisign signature on
the updater artifacts predates both and applies to every release. This is recorded rather than
quietly implied, because "verify the hash" is useless advice if the file it names is not there.

Both were exercised against v1.2.0 after it was published. The published `SHA256SUMS.txt` matches
a freshly downloaded installer, and `gh attestation verify` on that installer resolves to this
repository's `release.yml` at the commit the release was built from.

## Build provenance

Every released installer also carries a build provenance attestation
(`.github/workflows/release.yml`, `actions/attest-build-provenance`), a signed, keyless
(Sigstore) statement that those exact bytes were built by this repository's release workflow,
from a specific commit. It complements the other two controls rather than replacing them.
`SHA256SUMS.txt` only proves a download was not corrupted, and the minisign signature proves
the *update* artifact was signed by the key holder, whereas provenance ties an *installer* back
to the source and CI run that produced it. It is independent of OS code-signing and needs no
certificate.

To verify a downloaded installer, with the [GitHub CLI](https://cli.github.com/) installed:

```
gh attestation verify <installer-file> --repo eduardoghi/kavynex \
    --signer-workflow eduardoghi/kavynex/.github/workflows/release.yml \
    --source-ref refs/heads/main
```

A successful check confirms the file was built by this repository's release workflow, from `main`.
`--repo` alone accepts an attestation signed by any workflow of the repository from any ref, so the
two flags are what tie it to the release workflow on `main` specifically.

The statement is made by the `checksums` job, which downloads every asset from the draft and attests
the installers only when all build legs passed (their smoke tests and webview checks included). The
build job (`publish-tauri`) holds neither `id-token` nor `attestations` write. It compiles the whole
dependency tree, build scripts included, and anything those ran could otherwise mint a Sigstore
identity for this workflow and attest bytes of its choosing.

The three files added to the release after the installers are attested too, by the `checksums`
job once every completeness check has passed, so `SHA256SUMS.txt`, `latest.json` and the SBOM. The
first is the one that matters for a manual download. The README tells a downloader to compare
their installer against `SHA256SUMS.txt`, and without a statement on that file the comparison
proved only that two things a third party could both have written agree with each other. The same
`gh attestation verify` command works on it.

## The updater signing key

**Where it lives.** The private key and its password exist in two places only: the `release`
environment's secrets `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, which only
the `publish-tauri` job of `release.yml` reads, and the maintainer's offline backup. The repository
itself holds no secrets. GitHub does not let
anyone read a secret back, so losing the offline copy means the key can only be replaced, not
recovered. The public half is `plugins.updater.pubkey` in `src-tauri/tauri.conf.json`, compiled into
every build.

**What a rotation costs.** An installed copy trusts exactly one public key, the one it was built
with. An update signed with a new key is refused by every copy built before the rotation. So the
order matters:

1. Generate the new pair with `pnpm tauri signer generate -w <path>`, with a password, and back it
   up offline next to the old one.
2. Put the new public key in `tauri.conf.json`, and publish that release still signed with the old
   key (the secrets unchanged). Installed copies accept it, because the old key signed it, and from
   then on they trust the new key.
3. Replace both secrets with the new key and password. Every later release is signed with it.
4. Keep the old key until enough users have taken the bridging release, then destroy it.

**If the old key is compromised or lost**, step 2 is not possible without trusting it, and there is
no bridge. Rotate anyway (steps 1 and 3), and tell users in the release notes and the README that
they have to download and install the new version by hand once, because their installed copy will
refuse it as an update. A compromised key also means the rollback risk above applies to anything it
ever signed until users have moved past it.

## Software Bill of Materials (SBOM)

Every release also publishes a CycloneDX SBOM (`kavynex_<version>_sbom.cdx.json`,
`.github/workflows/release.yml`'s `sbom` and `sbom-upload` jobs) of the Rust dependency tree that goes into the
shipped binary. It is generated with `cargo-cyclonedx` from the committed `Cargo.lock`, so it lists
the exact crate versions a given release contains. The machine-readable answer to "does this
release ship crate X at version Y?" when an advisory lands after the fact, without recompiling or
walking the dependency graph by hand. Its hash is part of `SHA256SUMS.txt` and its presence is
enforced by the `checksums` job's asset-completeness check, so a release missing it fails loudly
rather than shipping silently.

A second CycloneDX SBOM, `kavynex_<version>_frontend_sbom.cdx.json`, lists the production npm
packages the frontend bundle carries (React, Mantine, zod and the rest). They ship inside the
binary as webview assets, so the Rust SBOM cannot answer "does this release contain react@X?". It
is generated by `pnpm sbom --prod --lockfile-only` from the committed `pnpm-lock.yaml`, which
installs and runs nothing beyond pnpm itself, and it is covered by `SHA256SUMS.txt`, the
completeness check and the attestation exactly like the first. The build-time tree stays out, since
it never reaches a user, and is advisory- and license-gated by the `frontend-audit` job instead.
The Rust SBOM applies from v1.2.0 onward and the frontend one from the first release after it was
added, not retroactively (see "When these three controls started applying" above).

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
before the switch. What it buys is the property every other gate in this repository already had.
The analysis is pinned (the action by SHA, the runner by OS major), it is reviewable in a diff, and
it travels with a fork. A language quietly dropped or a suite quietly narrowed now shows up as a
change to a file rather than as nothing at all.

The suite was then widened, as its own change, from `default` to `security-extended`. The extended
suite carries more variants of the classes this app's threat model is about (caller-supplied paths
reaching the filesystem, URLs reaching the network, argument vectors reaching a spawned process) at
a lower precision, so it names things the code already guards in ways the analyzer cannot follow.
Those are dismissed with a reason in the code-scanning view rather than silenced in the workflow,
which keeps the next real finding from arriving pre-suppressed. `security-and-quality` is not used,
because its extra queries are about code quality, which clippy and ESLint already gate.

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

This is a known, accepted risk rather than an oversight, and it is structural. `tauri-action`
does not separate building from signing, so the two cannot be split into a job that holds the
secret and a job that does not. What is done about it:

- The JavaScript tree does not run there. `tauri build` would run the `beforeBuildCommand`, and with
  it `pnpm build` (tsc, Vite, Rolldown, the PostCSS plugins), a far larger set of packages than the
  Rust tree. The frontend is built in an earlier step without the key, and `tauri-action` gets
  `KAVYNEX_FRONTEND_PREBUILT=1`, so `scripts/before-build.js` only checks that `dist/` exists.
- Every action is pinned to a full commit SHA, so a tag cannot be repointed at new code.
- No checkout keeps the job's token in `.git/config` (`persist-credentials: false` everywhere). In
  `publish-tauri` the npm install, the tests and the Rust build scripts all run before
  `tauri-action`, and a default checkout would have left them a `contents: write` token on disk for
  the whole job rather than only in the build step's environment.
- The signing secrets live in the `release` environment, which only `main` may deploy to, and only
  `publish-tauri` names it. A workflow run on any other branch, including one whose copy of
  `release.yml` drops the ref guard, never receives the key.
- The `permissions:` blocks are per-job. The jobs that compile a third-party tool (`audit`, which
  installs `cargo-audit`/`cargo-deny`, and `sbom`, which installs `cargo-cyclonedx`) are read-only
  and hold no signing secret. Write access belongs to the build job, which needs it to upload, and
  to `sbom-upload` and `checksums`, which build nothing.
- The release build deliberately skips the Rust build cache and the pnpm store cache that CI uses,
  so a poisoned cache entry cannot reach the job that holds the key.
- Releases are always created as drafts and published by hand, so a build is inspected before
  the updater endpoint can ever serve it.

The residual exposure is a malicious `build.rs` in a dependency the lockfile already pins,
reading the environment during a release build. `minimumReleaseAge` and `blockExoticSubdeps`
(`pnpm-workspace.yaml`) plus `cargo-deny`'s source allow-list are what reduce the chance of such
a dependency arriving in the first place; nothing in the current workflow removes the exposure
itself. Rotating the minisign key is the response if a compromise is ever suspected (see "The
updater signing key" above).

One asymmetry is worth stating plainly, because the two ecosystems get their publish-age
cooling-off from different places and the two places do not cover the same thing:

- **npm** has `minimumReleaseAge` (`pnpm-workspace.yaml`, 2880 minutes), which pnpm enforces on
  *every install*, including CI's `pnpm install --frozen-lockfile`. It is a property of the
  package manager, so nothing can add a too-new package to the tree, however the bump was
  authored.
- **Both trees, plus the actions** have Dependabot's `cooldown: default-days: 5`
  (`.github/dependabot.yml`), which delays the *pull request* Dependabot would open. It is a
  property of the bot, not of the resolver.

So the Cargo tree is not without a cooling-off, but the one it has is weaker in a specific way. It
only governs bumps Dependabot proposes. A hand-run `cargo update`, or a version edited into
`Cargo.toml` directly, is subject to no age gate at all, because `cargo-deny` restricts the
*source* (crates.io only), the license and duplicate/wildcard bans, and never the *publish age*.
A newly-published malicious version of an already-allowed crate reaching the tree that way is the
residual gap on the Rust side. What limits it is the pinned `Cargo.lock` (any bump is a reviewed,
deliberate commit, never an automatic resolution at build time, and `release.yml` now proves that
with `cargo metadata --locked` plus a `--locked` build), the weekly `scheduled-audit` workflow, and
the same draft-and-publish-by-hand release flow.

SQLite is the one part of the native tree no advisory database covers. libsqlite3-sys compiles a
copy of it into the binary, and RustSec tracks the crate, not the C library inside it. The app opens
database files that come from outside (Import database, the external mirror), so SQLite's parser
reads untrusted input. `scheduled-audit.yml`'s `sqlite-freshness` job compares the bundled version
with SQLite's latest release each week and keeps an issue open while they differ by minor version,
and the connection that opens those files sets `trusted_schema=OFF` and `cell_size_check=ON`. The
bump arrives with sqlx, which pins libsqlite3-sys.
