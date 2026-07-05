#!/usr/bin/env node

// Release gate: fails when package.json, tauri.conf.json and Cargo.toml disagree on the
// app version, so a partial bump can never produce mislabeled binaries.

import { readFileSync } from "fs";
import { resolve, join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

const pkgVersion = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const tauriVersion = JSON.parse(
    readFileSync(join(root, "src-tauri", "tauri.conf.json"), "utf8")
).version;

const cargoMatch = readFileSync(join(root, "src-tauri", "Cargo.toml"), "utf8").match(
    /^version = "(\d+\.\d+\.\d+)"/m
);
const cargoVersion = cargoMatch ? cargoMatch[1] : null;

if (!cargoVersion) {
    console.error("Cargo.toml: [package] version line not found.");
    process.exit(1);
}

if (pkgVersion !== tauriVersion || pkgVersion !== cargoVersion) {
    console.error(
        `Version mismatch: package.json=${pkgVersion}, tauri.conf.json=${tauriVersion}, Cargo.toml=${cargoVersion}. ` +
            "Run 'node scripts/bump-version.js <version>' to realign them."
    );
    process.exit(1);
}

console.log(
    `Version ${pkgVersion} is consistent across package.json, tauri.conf.json and Cargo.toml.`
);
