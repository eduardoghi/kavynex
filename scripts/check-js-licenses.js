// Fails when a production npm dependency carries a license the project does not allow.
//
// The Rust side has enforced this since cargo-deny landed (src-tauri/deny.toml, `cargo deny check
// licenses`), but the npm side only ever had `pnpm audit`, which reports security advisories and
// says nothing about licensing. That asymmetry matters for an MIT-licensed public project: a
// copyleft transitive could arrive inside a grouped Dependabot PR with nothing to flag it.
//
// Reads `pnpm licenses list --prod --json` rather than adding a license-checker dependency: pnpm
// resolves this from the lockfile it already owns, so the check costs no new supply-chain surface
// in a project that deliberately runs minimumReleaseAge and blockExoticSubdeps.
//
// The allow-list mirrors src-tauri/deny.toml's, minus the entries no npm package here uses. Keep
// the two in step: a license permissible for a crate is permissible for a package. OFL-1.1 is the
// one deliberate exception to that mirroring. It covers a bundled font asset, which has no crate
// counterpart, so adding it to deny.toml would only imply a crate could ship under it.

import { execFileSync } from "node:child_process";

// The licenses the production tree is allowed to carry. All permissive, and the script prints the
// package count and the distinct licenses it found on every run, so the current state lives in
// that output rather than here. A new entry is a deliberate decision, not a formality. Check the
// license actually permits redistribution inside an MIT app before adding it.
const ALLOWED = new Set([
    "MIT",
    "MIT-0",
    "Apache-2.0",
    "BSD-2-Clause",
    "BSD-3-Clause",
    "ISC",
    "0BSD",
    "Unlicense",
    "CC0-1.0",
    "Zlib",
    "Python-2.0",
    // The SIL Open Font License, covering the bundled display typeface
    // (@fontsource-variable/bricolage-grotesque, imported in src/App.tsx, so Vite emits its woff2
    // into dist/ and the installer embeds them). OSI- and FSF-approved, and it explicitly permits
    // bundling the font inside an application (including a proprietary one), without affecting the
    // application's own license, so it does not reach the MIT code around it. What it does require
    // is that the copyright notice and license text accompany the distribution, which is why
    // public/licenses/ ships the font's own LICENSE verbatim (see README's Third-party assets).
    "OFL-1.1",
]);

// pnpm reports SPDX expressions ("MIT OR Apache-2.0", "(MIT OR CC0-1.0)"). A dual license is fine
// as long as one side is allowed. We can take that side. An AND expression needs every term to be
// allowed, since all of them bind. Exported so the AND/OR/paren logic is unit-tested (see
// scripts/check-js-licenses.test.js): the current tree has no compound expression, so nothing else
// exercises this branch until the day a dependency ships one, exactly when a bug here would matter.
export function isAllowed(expression) {
    const normalized = expression.trim().replace(/^\(|\)$/g, "");

    if (normalized.includes(" AND ")) {
        return normalized.split(" AND ").every((term) => isAllowed(term));
    }

    if (normalized.includes(" OR ")) {
        return normalized.split(" OR ").some((term) => isAllowed(term));
    }

    return ALLOWED.has(normalized.trim().replace(/^\(|\)$/g, ""));
}

function readProductionLicenses() {
    // `shell` is needed only on Windows, where pnpm is a `.cmd` shim and Node refuses to spawn
    // `.bat`/`.cmd` without one (CVE-2024-27980). CI runs on Linux and takes the shell-free path.
    //
    // Note what the argv array does and does not buy on that Windows path: with `shell: true` Node
    // concatenates the array into a command line rather than passing it through, which is what
    // DEP0190 warns about. The array is not an escaping mechanism there. What actually makes this
    // safe is that every argument below is a literal written in this file, not derived from a
    // package name, a lockfile entry, or anything else outside it. Keep it that way: an argument
    // built from external data would need the shim resolved and invoked directly instead.
    const raw = execFileSync("pnpm", ["licenses", "list", "--prod", "--json"], {
        encoding: "utf-8",
        shell: process.platform === "win32",
        maxBuffer: 32 * 1024 * 1024,
    });

    // Shape: { "<license expression>": [{ name, versions, ... }, ...], ... }
    return JSON.parse(raw);
}

function main() {
    const byLicense = readProductionLicenses();
    const violations = [];
    let packageCount = 0;

    for (const [license, packages] of Object.entries(byLicense)) {
        packageCount += packages.length;

        if (isAllowed(license)) {
            continue;
        }

        for (const pkg of packages) {
            violations.push(`${pkg.name ?? "<unknown>"}: ${license}`);
        }
    }

    if (violations.length > 0) {
        console.error(
            `Disallowed license in ${violations.length} production package(s):\n` +
                violations.map((line) => `  ${line}`).join("\n") +
                "\n\nIf the license is acceptable for an MIT-licensed app, add it to ALLOWED in" +
                " scripts/check-js-licenses.js (and to src-tauri/deny.toml if a crate needs it" +
                " too). Otherwise, drop the dependency."
        );
        process.exit(1);
    }

    console.log(
        `All ${packageCount} production packages carry an allowed license ` +
            `(${Object.keys(byLicense).length} distinct: ${Object.keys(byLicense).sort().join(", ")}).`
    );
}

// Only run the gate when invoked as a script, so the export above stays unit-testable (importing
// this file must not shell out to pnpm).
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"))) {
    main();
}
