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
// the two in step: a license permissible for a crate is permissible for a package.

import { execFileSync } from "node:child_process";

// Every license currently present in the production tree (measured: 94 packages, all permissive).
// A new entry is a deliberate decision, not a formality - check the license actually permits
// redistribution inside an MIT app before adding it.
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
]);

// pnpm reports SPDX expressions ("MIT OR Apache-2.0", "(MIT OR CC0-1.0)"). A dual license is fine
// as long as one side is allowed - we can take that side. An AND expression needs every term to be
// allowed, since all of them bind.
function isAllowed(expression) {
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
    // An argv array rather than a command string, so nothing is ever concatenated into a shell
    // line. `shell` is needed only on Windows, where pnpm is a `.cmd` shim and Node refuses to
    // spawn `.bat`/`.cmd` without one (CVE-2024-27980); CI runs on Linux and takes the
    // shell-free path. Every argument here is a literal in this file either way.
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
            violations.push(`${pkg.name ?? "<unknown>"} - ${license}`);
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

main();
