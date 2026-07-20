#!/usr/bin/env node

import { spawnSync } from "child_process";
import { readFileSync, writeFileSync } from "fs";
import { resolve, join, dirname } from "path";
import { fileURLToPath } from "url";
import { isValidSemver, replaceCargoVersion } from "./version-utils.js";

// Rewrites the app version in package.json, tauri.conf.json and Cargo.toml (and regenerates
// Cargo.lock) to `newVersion`, returning a process exit code. The filesystem and cargo are injected
// (`readFile`, `writeFile`, `runCargoUpdate`) and logging goes through `log`/`error`, so the glue -
// the write sequence, the missing-version-line branch, the cargo-failure handling - is unit-tested
// without touching real files; version-utils.js already covers the semver/regex primitives.
export function bumpVersion({ newVersion, root, readFile, writeFile, runCargoUpdate, log, error }) {
    if (!newVersion) {
        error("Usage: node scripts/bump-version.js <version>");
        error("Example: node scripts/bump-version.js 1.2.0");
        return 1;
    }

    if (!isValidSemver(newVersion)) {
        error(`Invalid version "${newVersion}". Expected semver format: X.Y.Z`);
        return 1;
    }

    // package.json
    const pkgPath = join(root, "package.json");
    const pkg = JSON.parse(readFile(pkgPath));
    const oldVersion = pkg.version;
    pkg.version = newVersion;
    writeFile(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
    log(`package.json     ${oldVersion} -> ${newVersion}`);

    // src-tauri/tauri.conf.json
    const tauriConfPath = join(root, "src-tauri", "tauri.conf.json");
    const tauriConf = JSON.parse(readFile(tauriConfPath));
    tauriConf.version = newVersion;
    writeFile(tauriConfPath, JSON.stringify(tauriConf, null, 4) + "\n");
    log(`tauri.conf.json  ${oldVersion} -> ${newVersion}`);

    // src-tauri/Cargo.toml - only the [package] version line (full X.Y.Z semver) is touched.
    const cargoPath = join(root, "src-tauri", "Cargo.toml");
    const cargo = readFile(cargoPath);
    const updatedCargo = replaceCargoVersion(cargo, newVersion);
    if (updatedCargo === null) {
        error("Cargo.toml: version line not found - update manually");
        return 1;
    }
    writeFile(cargoPath, updatedCargo);
    log(`Cargo.toml       ${oldVersion} -> ${newVersion}`);

    // Cargo.lock records the package version too; regenerate it so a bump commit never
    // leaves the lockfile stale (the release builds with --locked and would fail late).
    if (runCargoUpdate() === 0) {
        log(`Cargo.lock       ${oldVersion} -> ${newVersion}`);
        log(`\nBumped to ${newVersion}.`);
        return 0;
    }

    error(
        "\nCargo.lock was NOT updated (cargo failed or is not installed). " +
            "Run 'cargo update --package kavynex' inside src-tauri before committing."
    );
    return 1;
}

// Only run the bump when invoked as a script, so the export above stays unit-testable (importing
// this file must not write files or shell out to cargo).
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"))) {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

    const exitCode = bumpVersion({
        newVersion: process.argv[2],
        root,
        readFile: (path) => readFileSync(path, "utf8"),
        writeFile: (path, content) => writeFileSync(path, content),
        runCargoUpdate: () =>
            spawnSync("cargo", ["update", "--package", "kavynex"], {
                cwd: join(root, "src-tauri"),
                stdio: "inherit",
            }).status,
        log: console.log,
        error: console.error,
    });

    process.exit(exitCode);
}
