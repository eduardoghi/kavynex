# Security policy

Kavynex is a solo-maintained, MIT-licensed desktop app.

## Reporting a vulnerability

If you find a security issue, please open a
[private GitHub security advisory](https://github.com/eduardoghi/kavynex/security/advisories/new)
on this repository rather than a public issue. If that is not workable, contact the
maintainer directly through their GitHub profile. As a single-maintainer project there is
no formal SLA, but security reports are prioritized over other work.

## Supported versions

Only the latest release receives fixes. There are no maintained release branches: a security fix
ships in the next version, and the in-app updater (or a fresh download) is how it reaches you. See
[`docs/RELEASE-SECURITY.md`](docs/RELEASE-SECURITY.md) for how a release is verified, and
[`docs/RELEASING.md`](docs/RELEASING.md) for how one is cut.

## Where the reasoning lives

This file is the policy: how to report something, and what is supported. The reasoning behind the
guardrails themselves is documented alongside the code it protects, so a contributor can find *why*
a check exists rather than only that it does:

- [`docs/THREAT-MODEL.md`](docs/THREAT-MODEL.md) - what the app defends against at runtime. The
  IPC trust boundary, path safety and the library guard, the yt-dlp host allow-list and argument
  handling, outbound image fetches, external binary resolution, the Tauri capability grants, the
  asset-protocol scope and the CSP. Includes the accepted residuals of each.
- [`docs/RELEASE-SECURITY.md`](docs/RELEASE-SECURITY.md) - what makes a shipped build verifiable.
  The updater and its rollback exposure, why installers are unsigned, checksums, build provenance,
  the SBOM, where the CodeQL static analysis lives, and the dependency supply chain.

These two were one 800-line `SECURITY.md` until they were split: the reporting instructions every
security policy is expected to carry sat at the bottom of it, behind everything above.
