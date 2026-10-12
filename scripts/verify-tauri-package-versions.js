// Fails when an `@tauri-apps/*` npm package and the Rust crate it pairs with are on different
// major.minor releases.
//
// `tauri build` refuses that pairing ("Found version mismatched Tauri packages"), and nothing else in
// ci.yml runs `tauri build`, so a skew would surface only in release.yml, after the six-leg build
// had started. Dependabot opens the npm and cargo bumps as separate PRs, which is how it happens: PR
// #60 moved the crates to tauri 2.12.0 and left the npm side behind.
//
// The pairing is the CLI's: `@tauri-apps/api` with `tauri`, and `@tauri-apps/plugin-<name>` with
// `tauri-plugin-<name>`. A crate with no npm counterpart (a Rust-only plugin, or one pulled in
// transitively) has nothing to agree with and is skipped. Versions are read from the lockfiles, since
// those are what the build resolves, not the ranges in package.json and Cargo.toml.

import { readFileSync } from "fs";
import { resolve, join, dirname } from "path";
import { fileURLToPath } from "url";
import { isMainModule } from "./script-entry.js";

const NPM_PACKAGE_PATTERN = /^ {6}'(@tauri-apps\/(?:api|plugin-[a-z0-9-]+))':\r?\n {8}specifier: [^\r\n]*\r?\n {8}version: ([^\s(]+)/gm;

// The `@tauri-apps/*` packages the root importer resolves, as `{ name: version }`. Only the importer
// block is read, so the `packages:` section (which repeats every name with its integrity) cannot
// count twice.
export function parseNpmTauriVersions(pnpmLock) {
    const importersStart = pnpmLock.search(/^importers:/m);
    const packagesStart = pnpmLock.search(/^packages:/m);

    if (importersStart === -1) {
        return {};
    }

    const importers = pnpmLock.slice(
        importersStart,
        packagesStart === -1 ? undefined : packagesStart
    );
    const versions = {};

    for (const match of importers.matchAll(NPM_PACKAGE_PATTERN)) {
        versions[match[1]] = match[2];
    }

    return versions;
}

// Every resolved version of `tauri` and `tauri-plugin-*`, as `{ name: [versions] }`. A crate can be
// in the lockfile at more than one version, and each of them has to agree.
export function parseCargoTauriVersions(cargoLock) {
    const versions = {};

    for (const block of cargoLock.split("[[package]]")) {
        const name = /^name = "([^"]+)"/m.exec(block)?.[1];
        const version = /^version = "([^"]+)"/m.exec(block)?.[1];

        if (!name || !version || !(name === "tauri" || name.startsWith("tauri-plugin-"))) {
            continue;
        }

        (versions[name] ??= []).push(version);
    }

    return versions;
}

export function crateForNpmPackage(npmName) {
    if (npmName === "@tauri-apps/api") {
        return "tauri";
    }

    return npmName.replace("@tauri-apps/plugin-", "tauri-plugin-");
}

function majorMinor(version) {
    return version.split(".").slice(0, 2).join(".");
}

// Decides the gate from the two lockfiles' contents, returning `{ ok, message }` rather than reading
// files or exiting, so it is unit-tested without touching the filesystem.
export function verifyTauriPackageVersions({ pnpmLock, cargoLock }) {
    const npm = parseNpmTauriVersions(pnpmLock);
    const cargo = parseCargoTauriVersions(cargoLock);
    const npmNames = Object.keys(npm).sort();

    if (npmNames.length === 0) {
        return {
            ok: false,
            message: "pnpm-lock.yaml: no @tauri-apps/api or @tauri-apps/plugin-* entry found in the root importer.",
        };
    }

    const problems = [];

    for (const npmName of npmNames) {
        const crate = crateForNpmPackage(npmName);
        const crateVersions = cargo[crate];

        if (!crateVersions) {
            problems.push(`${npmName} ${npm[npmName]} has no ${crate} crate in Cargo.lock.`);
            continue;
        }

        for (const crateVersion of crateVersions) {
            if (majorMinor(crateVersion) !== majorMinor(npm[npmName])) {
                problems.push(`${npmName} is ${npm[npmName]} but ${crate} is ${crateVersion}.`);
            }
        }
    }

    if (problems.length > 0) {
        return {
            ok: false,
            message: [
                "Tauri npm packages and Rust crates disagree on major.minor, which `tauri build` refuses:",
                ...problems.map((problem) => `  - ${problem}`),
                "Bump both sides together (package.json/pnpm-lock.yaml and Cargo.lock).",
            ].join("\n"),
        };
    }

    return {
        ok: true,
        message: `Tauri npm packages and Rust crates agree on major.minor (${npmNames
            .map((name) => `${name} ${npm[name]}`)
            .join(", ")}).`,
    };
}

// Only run the gate when invoked as a script, so the exports above stay unit-testable (importing
// this file must not read files or exit).
if (isMainModule(import.meta.url)) {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

    const result = verifyTauriPackageVersions({
        pnpmLock: readFileSync(join(root, "pnpm-lock.yaml"), "utf8"),
        cargoLock: readFileSync(join(root, "src-tauri", "Cargo.lock"), "utf8"),
    });

    if (result.ok) {
        console.log(result.message);
    } else {
        console.error(result.message);
        process.exit(1);
    }
}
