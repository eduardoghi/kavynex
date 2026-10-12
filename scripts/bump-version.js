import { spawnSync } from "child_process";
import { readFileSync, writeFileSync } from "fs";
import { resolve, join, dirname } from "path";
import { fileURLToPath } from "url";
import {
    isValidSemver,
    nextVersionProblem,
    replaceCargoVersion,
    replaceJsonVersion,
    rotateChangelog,
} from "./version-utils.js";
import { isMainModule } from "./script-entry.js";

// Rewrites the app version in package.json, tauri.conf.json and Cargo.toml (and regenerates
// Cargo.lock) to `newVersion`, and moves CHANGELOG.md's Unreleased section under the new version,
// returning a process exit code. The filesystem and cargo are injected (`readFile`, `writeFile`,
// `runCargoUpdate`) and logging goes through `log`/`error`, so the glue (the write sequence, the
// missing-version-line branch, the cargo-failure handling) is unit-tested without touching real
// files. version-utils.js already covers the semver/regex primitives.
//
// `force` skips the two checks a release normally has to pass, the version being one step past the
// current one and the changelog having something to say about it.
export function bumpVersion({
    newVersion,
    root,
    readFile,
    writeFile,
    runCargoUpdate,
    log,
    error,
    force = false,
    today = new Date().toISOString().slice(0, 10),
}) {
    if (!newVersion) {
        error("Usage: node scripts/bump-version.js <version> [--force]");
        error("Example: node scripts/bump-version.js 1.2.0");
        return 1;
    }

    if (!isValidSemver(newVersion)) {
        error(`Invalid version "${newVersion}". Expected semver format: X.Y.Z`);
        return 1;
    }

    // Read and validate every target before writing anything, so a failure partway through (the
    // Cargo.toml regex not matching, say) never leaves some files bumped and others untouched
    // with no rollback. Only once every target below is known-good do the writes below happen.

    // package.json
    const pkgPath = join(root, "package.json");
    const pkgText = readFile(pkgPath);
    const oldVersion = JSON.parse(pkgText).version;
    const updatedPkg = replaceJsonVersion(pkgText, newVersion);
    if (updatedPkg === null) {
        error("package.json: top-level version not found. Update manually.");
        return 1;
    }

    const stepProblem = nextVersionProblem(oldVersion, newVersion);
    if (stepProblem && !force) {
        error(`${stepProblem} Pass --force to use it anyway.`);
        return 1;
    }

    const changelogPath = join(root, "CHANGELOG.md");
    const rotated = rotateChangelog(readFile(changelogPath), newVersion, today);
    if (rotated === null) {
        error("CHANGELOG.md: no '## [Unreleased]' section found.");
        return 1;
    }
    if (rotated.empty && !force) {
        error(
            "CHANGELOG.md: the Unreleased section is empty. Describe the release there first, or pass --force."
        );
        return 1;
    }

    // src-tauri/tauri.conf.json
    const tauriConfPath = join(root, "src-tauri", "tauri.conf.json");
    const updatedTauriConf = replaceJsonVersion(readFile(tauriConfPath), newVersion);
    if (updatedTauriConf === null) {
        error("tauri.conf.json: top-level version not found. Update manually.");
        return 1;
    }

    // src-tauri/Cargo.toml, only the [package] version line (full X.Y.Z semver) is touched.
    const cargoPath = join(root, "src-tauri", "Cargo.toml");
    const cargo = readFile(cargoPath);
    const updatedCargo = replaceCargoVersion(cargo, newVersion);
    if (updatedCargo === null) {
        error("Cargo.toml: version line not found. Update manually.");
        return 1;
    }

    // Every target validated above. Now write them all.
    writeFile(pkgPath, updatedPkg);
    log(`package.json     ${oldVersion} -> ${newVersion}`);

    writeFile(tauriConfPath, updatedTauriConf);
    log(`tauri.conf.json  ${oldVersion} -> ${newVersion}`);

    writeFile(cargoPath, updatedCargo);
    log(`Cargo.toml       ${oldVersion} -> ${newVersion}`);

    if (!rotated.empty) {
        writeFile(changelogPath, rotated.text);
        log(`CHANGELOG.md     Unreleased -> ${newVersion}`);
    }

    // Cargo.lock records the package version too. Regenerate it so a bump commit never
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
if (isMainModule(import.meta.url)) {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

    const args = process.argv.slice(2);

    const exitCode = bumpVersion({
        newVersion: args.find((arg) => !arg.startsWith("--")),
        force: args.includes("--force"),
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
