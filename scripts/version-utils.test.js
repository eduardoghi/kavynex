import { describe, expect, it } from "vitest";
import {
    findVersionMismatch,
    isValidSemver,
    parseCargoVersion,
    replaceCargoVersion,
} from "./version-utils.js";

// A representative Cargo.toml: the [package] version comes first, then a dependency declared
// as a sub-table (which also has a `version = "..."` line at the start of a line). The gate
// relies on [package] preceding those, so the first match is always the app version.
const CARGO_TOML = `[package]
name = "kavynex"
version = "1.1.1"
edition = "2021"

[dependencies]
serde = "1"

[dependencies.foo]
version = "9.9.9"
`;

describe("parseCargoVersion", () => {
    it("extracts the [package] version, not a dependency's", () => {
        expect(parseCargoVersion(CARGO_TOML)).toBe("1.1.1");
    });

    it("returns null when there is no package version line", () => {
        expect(parseCargoVersion('[package]\nname = "kavynex"\n')).toBeNull();
    });

    it("does not match a non-plain-semver version (e.g. a pre-release)", () => {
        expect(parseCargoVersion('version = "1.1.1-beta"\n')).toBeNull();
    });
});

describe("replaceCargoVersion", () => {
    it("replaces only the [package] version line and leaves dependency versions intact", () => {
        const updated = replaceCargoVersion(CARGO_TOML, "2.0.0");

        expect(updated).toContain('version = "2.0.0"');
        expect(updated).not.toContain('version = "1.1.1"');
        // The dependency sub-table version must be untouched.
        expect(updated).toContain('version = "9.9.9"');
    });

    it("returns null when there is no version line to replace", () => {
        expect(replaceCargoVersion('[package]\nname = "kavynex"\n', "2.0.0")).toBeNull();
    });
});

describe("isValidSemver", () => {
    it("accepts a plain X.Y.Z", () => {
        expect(isValidSemver("1.2.3")).toBe(true);
        expect(isValidSemver("0.0.0")).toBe(true);
        expect(isValidSemver("10.20.30")).toBe(true);
    });

    it("rejects partial, pre-release, or non-numeric versions", () => {
        expect(isValidSemver("1.2")).toBe(false);
        expect(isValidSemver("1.2.3.4")).toBe(false);
        expect(isValidSemver("1.2.3-beta")).toBe(false);
        expect(isValidSemver("v1.2.3")).toBe(false);
        expect(isValidSemver("")).toBe(false);
    });
});

describe("findVersionMismatch", () => {
    it("returns null when all three agree", () => {
        expect(
            findVersionMismatch({
                packageVersion: "1.1.1",
                tauriVersion: "1.1.1",
                cargoVersion: "1.1.1",
            })
        ).toBeNull();
    });

    it("reports a message when any source disagrees", () => {
        const message = findVersionMismatch({
            packageVersion: "1.1.1",
            tauriVersion: "1.1.0",
            cargoVersion: "1.1.1",
        });

        expect(message).toContain("package.json=1.1.1");
        expect(message).toContain("tauri.conf.json=1.1.0");
        expect(message).toContain("Cargo.toml=1.1.1");
    });
});
