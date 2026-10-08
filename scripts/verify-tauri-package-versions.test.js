import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
    crateForNpmPackage,
    parseCargoTauriVersions,
    parseNpmTauriVersions,
    verifyTauriPackageVersions,
} from "./verify-tauri-package-versions.js";

function pnpmLock(packages) {
    const entries = Object.entries(packages)
        .map(
            ([name, version]) =>
                `      '${name}':\n        specifier: ^${version}\n        version: ${version}\n`
        )
        .join("");

    // The `packages:` section repeats the names with a different shape, which the parser must not
    // read as a second resolution.
    return (
        "lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    dependencies:\n" +
        entries +
        "\npackages:\n\n  '@tauri-apps/api@1.0.0':\n    resolution: {integrity: sha512-x}\n"
    );
}

function cargoLock(crates) {
    return crates
        .map(([name, version]) => `[[package]]\nname = "${name}"\nversion = "${version}"\n`)
        .join("\n");
}

describe("verifyTauriPackageVersions", () => {
    it("passes when every npm package shares major.minor with its crate", () => {
        const result = verifyTauriPackageVersions({
            pnpmLock: pnpmLock({ "@tauri-apps/api": "2.12.1", "@tauri-apps/plugin-dialog": "2.8.1" }),
            cargoLock: cargoLock([
                ["tauri", "2.12.3"],
                ["tauri-plugin-dialog", "2.8.0"],
            ]),
        });

        expect(result.ok).toBe(true);
    });

    it("fails on the skew PR #60 produced, crates bumped and npm left behind", () => {
        const result = verifyTauriPackageVersions({
            pnpmLock: pnpmLock({ "@tauri-apps/api": "2.11.5" }),
            cargoLock: cargoLock([["tauri", "2.12.0"]]),
        });

        expect(result.ok).toBe(false);
        expect(result.message).toContain("@tauri-apps/api is 2.11.5 but tauri is 2.12.0");
    });

    it("fails a plugin pair on its own", () => {
        const result = verifyTauriPackageVersions({
            pnpmLock: pnpmLock({ "@tauri-apps/api": "2.12.1", "@tauri-apps/plugin-updater": "2.12.0" }),
            cargoLock: cargoLock([
                ["tauri", "2.12.1"],
                ["tauri-plugin-updater", "2.13.1"],
            ]),
        });

        expect(result.ok).toBe(false);
        expect(result.message).toContain("@tauri-apps/plugin-updater is 2.12.0 but tauri-plugin-updater is 2.13.1");
        expect(result.message).not.toContain("@tauri-apps/api is");
    });

    it("fails when an npm plugin has no crate to pair with", () => {
        const result = verifyTauriPackageVersions({
            pnpmLock: pnpmLock({ "@tauri-apps/api": "2.12.1", "@tauri-apps/plugin-shell": "2.3.0" }),
            cargoLock: cargoLock([["tauri", "2.12.1"]]),
        });

        expect(result.ok).toBe(false);
        expect(result.message).toContain("has no tauri-plugin-shell crate");
    });

    it("ignores a crate with no npm counterpart", () => {
        // Rust-only plugins (window-state, single-instance) and transitive ones (fs, via dialog).
        const result = verifyTauriPackageVersions({
            pnpmLock: pnpmLock({ "@tauri-apps/api": "2.12.1" }),
            cargoLock: cargoLock([
                ["tauri", "2.12.1"],
                ["tauri-plugin-window-state", "2.5.0"],
                ["tauri-plugin-fs", "2.6.0"],
            ]),
        });

        expect(result.ok).toBe(true);
    });

    it("checks every version of a crate the lockfile holds twice", () => {
        const result = verifyTauriPackageVersions({
            pnpmLock: pnpmLock({ "@tauri-apps/api": "2.12.1" }),
            cargoLock: cargoLock([
                ["tauri", "2.12.1"],
                ["tauri", "2.11.0"],
            ]),
        });

        expect(result.ok).toBe(false);
        expect(result.message).toContain("tauri is 2.11.0");
    });

    it("fails rather than passing vacuously when no npm package is found", () => {
        const result = verifyTauriPackageVersions({
            pnpmLock: "lockfileVersion: '9.0'\n",
            cargoLock: cargoLock([["tauri", "2.12.1"]]),
        });

        expect(result.ok).toBe(false);
    });

    it("passes on the repository's own lockfiles", () => {
        const root = process.cwd();
        const result = verifyTauriPackageVersions({
            pnpmLock: readFileSync(resolve(root, "pnpm-lock.yaml"), "utf8"),
            cargoLock: readFileSync(resolve(root, "src-tauri", "Cargo.lock"), "utf8"),
        });

        expect(result.ok).toBe(true);
    });
});

describe("parsers", () => {
    it("reads the resolved npm version without its peer suffix", () => {
        const lock =
            "importers:\n\n  .:\n    dependencies:\n      '@tauri-apps/plugin-opener':\n        specifier: ^2.7.0\n        version: 2.7.0(react@19.3.0)\n";

        expect(parseNpmTauriVersions(lock)).toEqual({ "@tauri-apps/plugin-opener": "2.7.0" });
    });

    it("reads the npm side from a CRLF lockfile", () => {
        const lock = pnpmLock({ "@tauri-apps/api": "2.12.1" }).replace(/\n/g, "\r\n");

        expect(parseNpmTauriVersions(lock)).toEqual({ "@tauri-apps/api": "2.12.1" });
    });

    it("skips the cli and non-tauri crates", () => {
        const lock = pnpmLock({ "@tauri-apps/cli": "2.12.1" });

        expect(parseNpmTauriVersions(lock)).toEqual({});
        expect(parseCargoTauriVersions(cargoLock([["tauri-build", "2.6.0"], ["serde", "1.0.0"]]))).toEqual({});
    });

    it("pairs each npm package with the crate the CLI compares it to", () => {
        expect(crateForNpmPackage("@tauri-apps/api")).toBe("tauri");
        expect(crateForNpmPackage("@tauri-apps/plugin-dialog")).toBe("tauri-plugin-dialog");
    });
});
