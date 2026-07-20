import { describe, expect, it } from "vitest";
import { verifyReleaseVersion } from "./verify-release-version.js";

const CARGO = (version) => `[package]\nname = "kavynex"\nversion = "${version}"\nedition = "2021"\n`;

describe("verifyReleaseVersion", () => {
    it("passes when all three files agree on the version", () => {
        const result = verifyReleaseVersion({
            packageJson: JSON.stringify({ version: "1.2.0" }),
            tauriConfJson: JSON.stringify({ version: "1.2.0" }),
            cargoToml: CARGO("1.2.0"),
        });

        expect(result.ok).toBe(true);
        expect(result.message).toContain("1.2.0");
    });

    it("fails when a file disagrees on the version", () => {
        const result = verifyReleaseVersion({
            packageJson: JSON.stringify({ version: "1.2.0" }),
            tauriConfJson: JSON.stringify({ version: "1.1.0" }),
            cargoToml: CARGO("1.2.0"),
        });

        expect(result.ok).toBe(false);
        // The failing message points the reader at the bump script that realigns them.
        expect(result.message).toContain("bump-version.js");
    });

    it("fails when the Cargo.toml version line is missing", () => {
        const result = verifyReleaseVersion({
            packageJson: JSON.stringify({ version: "1.2.0" }),
            tauriConfJson: JSON.stringify({ version: "1.2.0" }),
            cargoToml: `[package]\nname = "kavynex"\nedition = "2021"\n`,
        });

        expect(result.ok).toBe(false);
        expect(result.message).toContain("version line not found");
    });
});
