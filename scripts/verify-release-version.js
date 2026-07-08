#!/usr/bin/env node

// Release gate: fails when package.json, tauri.conf.json and Cargo.toml disagree on the
// app version, so a partial bump can never produce mislabeled binaries.

import { readFileSync } from "fs";
import { resolve, join, dirname } from "path";
import { fileURLToPath } from "url";
import { parseCargoVersion, findVersionMismatch } from "./version-utils.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

const packageVersion = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const tauriVersion = JSON.parse(
    readFileSync(join(root, "src-tauri", "tauri.conf.json"), "utf8")
).version;
const cargoVersion = parseCargoVersion(
    readFileSync(join(root, "src-tauri", "Cargo.toml"), "utf8")
);

if (!cargoVersion) {
    console.error("Cargo.toml: [package] version line not found.");
    process.exit(1);
}

const mismatch = findVersionMismatch({ packageVersion, tauriVersion, cargoVersion });

if (mismatch) {
    console.error(`${mismatch} Run 'node scripts/bump-version.js <version>' to realign them.`);
    process.exit(1);
}

console.log(
    `Version ${packageVersion} is consistent across package.json, tauri.conf.json and Cargo.toml.`
);
