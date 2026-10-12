import { describe, expect, it } from "vitest";
import {
    findVersionMismatch,
    allowedNextVersions,
    compareSemver,
    isValidSemver,
    nextVersionProblem,
    rotateChangelog,
    parseCargoVersion,
    replaceCargoVersion,
    replaceJsonVersion,
} from "./version-utils.js";

// A representative Cargo.toml. The [package] version comes first, then a dependency declared
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

    it("reads the [package] version even when a dependency sub-table precedes it", () => {
        // A bare ^version regex would return the first version line anywhere, so a
        // [dependencies.foo] block placed before [package] would hijack it. Scoping to the
        // [package] table is what keeps the app version correct regardless of table order.
        const reordered = `[dependencies.foo]
version = "9.9.9"

[package]
name = "kavynex"
version = "1.1.1"
`;
        expect(parseCargoVersion(reordered)).toBe("1.1.1");
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

    it("rewrites only the [package] version when a dependency sub-table precedes it", () => {
        const reordered = `[dependencies.foo]
version = "9.9.9"

[package]
name = "kavynex"
version = "1.1.1"
`;
        const updated = replaceCargoVersion(reordered, "2.0.0");

        expect(updated).toContain('version = "2.0.0"');
        expect(updated).toContain('version = "9.9.9"');
        expect(updated).not.toContain('version = "1.1.1"');
    });
});

describe("replaceJsonVersion", () => {
    it("changes the version and keeps the rest of the text byte for byte", () => {
        const text = '{\r\n    "version": "1.1.1",\r\n    "depends": ["libc6 (>= 2.39)"]\r\n}\r\n';

        expect(replaceJsonVersion(text, "1.2.0")).toBe(
            '{\r\n    "version": "1.2.0",\r\n    "depends": ["libc6 (>= 2.39)"]\r\n}\r\n'
        );
    });

    it("returns null when the first version in the text is not the top-level one", () => {
        const text = '{\n  "engines": { "version": "9.9.9" },\n  "version": "1.1.1"\n}\n';

        expect(replaceJsonVersion(text, "1.2.0")).toBeNull();
    });

    it("returns null when there is no top-level version", () => {
        expect(replaceJsonVersion('{ "name": "kavynex" }', "1.2.0")).toBeNull();
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

describe("compareSemver", () => {
    it("orders by major, then minor, then patch, numerically", () => {
        expect(compareSemver("1.8.0", "1.70.0")).toBeLessThan(0);
        expect(compareSemver("2.0.0", "1.99.99")).toBeGreaterThan(0);
        expect(compareSemver("1.2.3", "1.2.3")).toBe(0);
        expect(compareSemver("1.2.10", "1.2.9")).toBeGreaterThan(0);
    });
});

describe("nextVersionProblem", () => {
    it("allows one step on one component", () => {
        expect(allowedNextVersions("1.7.0")).toEqual(["1.7.1", "1.8.0", "2.0.0"]);
        expect(nextVersionProblem("1.7.0", "1.8.0")).toBeNull();
        expect(nextVersionProblem("1.7.3", "1.7.4")).toBeNull();
        expect(nextVersionProblem("1.7.3", "2.0.0")).toBeNull();
    });

    it("names what was expected otherwise", () => {
        expect(nextVersionProblem("1.7.0", "1.70.0")).toContain("1.7.1, 1.8.0, 2.0.0");
        expect(nextVersionProblem("1.7.0", "1.7.0")).not.toBeNull();
        expect(nextVersionProblem("1.7.3", "1.8.3")).not.toBeNull();
    });
});

describe("rotateChangelog", () => {
    it("keeps CRLF line endings", () => {
        const rotated = rotateChangelog("## [Unreleased]\r\n\r\n- A fix.\r\n", "1.8.0", "2026-10-10");

        expect(rotated.text).toBe(
            "## [Unreleased]\r\n\r\n## [1.8.0] (2026-10-10)\r\n\r\n- A fix.\r\n"
        );
    });

    it("stops the Unreleased body at the next release heading", () => {
        const rotated = rotateChangelog(
            "## [Unreleased]\n\n## [1.7.0] (2026-09-27)\n\n- Old.\n",
            "1.8.0",
            "x"
        );

        expect(rotated).toEqual({ empty: true });
    });

    it("is null without an Unreleased heading", () => {
        expect(rotateChangelog("# Changelog\n", "1.8.0", "x")).toBeNull();
    });
});
