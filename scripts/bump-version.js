#!/usr/bin/env node

import { spawnSync } from "child_process";
import { readFileSync, writeFileSync } from "fs";
import { resolve, join, dirname } from "path";
import { fileURLToPath } from "url";
import { isValidSemver, replaceCargoVersion } from "./version-utils.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const newVersion = process.argv[2];

if (!newVersion) {
    console.error("Usage: node scripts/bump-version.js <version>");
    console.error("Example: node scripts/bump-version.js 1.2.0");
    process.exit(1);
}

if (!isValidSemver(newVersion)) {
    console.error(`Invalid version "${newVersion}". Expected semver format: X.Y.Z`);
    process.exit(1);
}

const root = resolve(__dirname, "..");

// package.json
const pkgPath = join(root, "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
const oldVersion = pkg.version;
pkg.version = newVersion;
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
console.log(`package.json     ${oldVersion} -> ${newVersion}`);

// src-tauri/tauri.conf.json
const tauriConfPath = join(root, "src-tauri", "tauri.conf.json");
const tauriConf = JSON.parse(readFileSync(tauriConfPath, "utf8"));
tauriConf.version = newVersion;
writeFileSync(tauriConfPath, JSON.stringify(tauriConf, null, 4) + "\n");
console.log(`tauri.conf.json  ${oldVersion} -> ${newVersion}`);

// src-tauri/Cargo.toml - only the [package] version line (full X.Y.Z semver) is touched.
const cargoPath = join(root, "src-tauri", "Cargo.toml");
const cargo = readFileSync(cargoPath, "utf8");
const updatedCargo = replaceCargoVersion(cargo, newVersion);
if (updatedCargo === null) {
    console.error("Cargo.toml: version line not found - update manually");
    process.exit(1);
}
writeFileSync(cargoPath, updatedCargo);
console.log(`Cargo.toml       ${oldVersion} -> ${newVersion}`);

// Cargo.lock records the package version too; regenerate it so a bump commit never
// leaves the lockfile stale (the release builds with --locked and would fail late).
const cargoUpdate = spawnSync("cargo", ["update", "--package", "kavynex"], {
    cwd: join(root, "src-tauri"),
    stdio: "inherit",
});

if (cargoUpdate.status === 0) {
    console.log(`Cargo.lock       ${oldVersion} -> ${newVersion}`);
    console.log(`\nBumped to ${newVersion}.`);
} else {
    console.error(
        "\nCargo.lock was NOT updated (cargo failed or is not installed). " +
            "Run 'cargo update --package kavynex' inside src-tauri before committing."
    );
    process.exit(1);
}
