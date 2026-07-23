// Release gate: fails when package.json, tauri.conf.json and Cargo.toml disagree on the
// app version, so a partial bump can never produce mislabeled binaries.

import { readFileSync } from "fs";
import { resolve, join, dirname } from "path";
import { fileURLToPath } from "url";
import { parseCargoVersion, findVersionMismatch } from "./version-utils.js";

// Decides the release-version gate from the raw file contents, returning `{ ok, message }` rather
// than reading files or exiting itself. Exported so the glue (the null-cargo branch, the mismatch
// wiring, the success message) is unit-tested without touching the filesystem; version-utils.js
// already covers the parsing/comparison primitives this composes.
export function verifyReleaseVersion({ packageJson, tauriConfJson, cargoToml }) {
    const packageVersion = JSON.parse(packageJson).version;
    const tauriVersion = JSON.parse(tauriConfJson).version;
    const cargoVersion = parseCargoVersion(cargoToml);

    if (!cargoVersion) {
        return { ok: false, message: "Cargo.toml: [package] version line not found." };
    }

    const mismatch = findVersionMismatch({ packageVersion, tauriVersion, cargoVersion });

    if (mismatch) {
        return {
            ok: false,
            message: `${mismatch} Run 'node scripts/bump-version.js <version>' to realign them.`,
        };
    }

    return {
        ok: true,
        message: `Version ${packageVersion} is consistent across package.json, tauri.conf.json and Cargo.toml.`,
    };
}

// Only run the gate when invoked as a script, so the export above stays unit-testable (importing
// this file must not read files or exit).
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"))) {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

    const result = verifyReleaseVersion({
        packageJson: readFileSync(join(root, "package.json"), "utf8"),
        tauriConfJson: readFileSync(join(root, "src-tauri", "tauri.conf.json"), "utf8"),
        cargoToml: readFileSync(join(root, "src-tauri", "Cargo.toml"), "utf8"),
    });

    if (result.ok) {
        console.log(result.message);
    } else {
        console.error(result.message);
        process.exit(1);
    }
}
