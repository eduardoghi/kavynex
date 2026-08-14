import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve, dirname, join } from "path";
import { fileURLToPath } from "url";
import {
    findUndocumentedInstallers,
    findUnmatchedPatterns,
    isInstallerAsset,
    parseReadmeAssetPatterns,
    patternToRegExp,
    verifyReadmeAssetNames,
} from "./verify-readme-asset-names.js";

// The assets v1.2.0 actually published, read back from the release. Used as the fixture for the
// end-to-end check below rather than a hand-written list, because the whole point of this gate is
// that hand-written lists of these names drift.
const V1_2_0_ASSETS = [
    "kavynex-1.2.0-1.aarch64.rpm",
    "kavynex-1.2.0-1.aarch64.rpm.sig",
    "kavynex-1.2.0-1.x86_64.rpm",
    "kavynex-1.2.0-1.x86_64.rpm.sig",
    "kavynex_1.2.0_aarch64.app.tar.gz",
    "kavynex_1.2.0_aarch64.app.tar.gz.sig",
    "kavynex_1.2.0_aarch64.AppImage",
    "kavynex_1.2.0_aarch64.AppImage.sig",
    "kavynex_1.2.0_aarch64.dmg",
    "kavynex_1.2.0_amd64.AppImage",
    "kavynex_1.2.0_amd64.AppImage.sig",
    "kavynex_1.2.0_amd64.deb",
    "kavynex_1.2.0_amd64.deb.sig",
    "kavynex_1.2.0_arm64-setup.exe",
    "kavynex_1.2.0_arm64-setup.exe.sig",
    "kavynex_1.2.0_arm64.deb",
    "kavynex_1.2.0_arm64.deb.sig",
    "kavynex_1.2.0_arm64_en-US.msi",
    "kavynex_1.2.0_arm64_en-US.msi.sig",
    "kavynex_1.2.0_sbom.cdx.json",
    "kavynex_1.2.0_x64-setup.exe",
    "kavynex_1.2.0_x64-setup.exe.sig",
    "kavynex_1.2.0_x64.app.tar.gz",
    "kavynex_1.2.0_x64.app.tar.gz.sig",
    "kavynex_1.2.0_x64.dmg",
    "kavynex_1.2.0_x64_en-US.msi",
    "kavynex_1.2.0_x64_en-US.msi.sig",
    "latest.json",
    "SHA256SUMS.txt",
];

const readme = (body) => `# Kavynex\n\n${body}\n`;

describe("parseReadmeAssetPatterns", () => {
    it("reads every inline-code download name in document order", () => {
        const patterns = parseReadmeAssetPatterns(
            readme(
                [
                    "- `kavynex_*_x64-setup.exe`",
                    "- Apple Silicon: `kavynex_*_aarch64.dmg`",
                    "- Fedora: `kavynex-*.x86_64.rpm` / `kavynex-*.aarch64.rpm`",
                ].join("\n")
            )
        );

        expect(patterns).toEqual([
            "kavynex_*_x64-setup.exe",
            "kavynex_*_aarch64.dmg",
            "kavynex-*.x86_64.rpm",
            "kavynex-*.aarch64.rpm",
        ]);
    });

    it("skips the inline-code kavynex names that are not assets", () => {
        // The README mentions these elsewhere (the corrupt-database and logging sections), and
        // neither is a download. Requiring the `*` is the whole rule that separates them, so both
        // directions of it are pinned: without it these would be reported as names the release does
        // not carry, on every release, forever.
        const patterns = parseReadmeAssetPatterns(
            readme(
                [
                    "The broken file is preserved as `kavynex.db.corrupt` rather than deleted.",
                    "Look for `kavynex.log` (and `kavynex.log.1`, the previous rotation).",
                    "- `kavynex_*_x64-setup.exe`",
                ].join("\n")
            )
        );

        expect(patterns).toEqual(["kavynex_*_x64-setup.exe"]);
    });

    it("reports a name repeated in two sections once", () => {
        const patterns = parseReadmeAssetPatterns(
            readme("- `kavynex_*_x64.dmg`\n\nAlso see `kavynex_*_x64.dmg` above.")
        );

        expect(patterns).toEqual(["kavynex_*_x64.dmg"]);
    });
});

describe("patternToRegExp", () => {
    it("matches a real asset with the version in place of the star", () => {
        expect(patternToRegExp("kavynex_*_x64-setup.exe").test("kavynex_1.2.0_x64-setup.exe")).toBe(
            true
        );
    });

    it("matches the rpm shape, whose star covers a two-part version", () => {
        // `kavynex-1.2.0-1.x86_64.rpm`. The rpm bundler appends its own release number, so this is
        // the one name where the placeholder spans more than the package version.
        expect(patternToRegExp("kavynex-*.x86_64.rpm").test("kavynex-1.2.0-1.x86_64.rpm")).toBe(
            true
        );
    });

    it("does not match an asset that merely starts with the name", () => {
        // The end anchor, which is what keeps every installer pattern from also claiming its own
        // updater signature, and a `.deb` pattern that matched `.deb.sig` would make the reverse
        // check under-report by exactly the assets it exists to find.
        expect(patternToRegExp("kavynex_*_amd64.deb").test("kavynex_1.2.0_amd64.deb.sig")).toBe(
            false
        );
        expect(patternToRegExp("kavynex_*_x64.dmg").test("kavynex_1.2.0_x64.dmg.sig")).toBe(false);
    });

    it("does not let the star swallow a different suffix", () => {
        // `[^\s]+` is greedy, so this pins that the literal tail after the star still has to match:
        // the macOS updater bundle shares this name's prefix up to the architecture.
        expect(patternToRegExp("kavynex_*_x64.dmg").test("kavynex_1.2.0_x64.app.tar.gz")).toBe(
            false
        );
    });

    it("treats the dots in a pattern as literal characters", () => {
        // Unescaped, `.` would match anything, and `kavynex-*.x86_64.rpm` would accept a name with
        // a different separator there.
        expect(patternToRegExp("kavynex-*.x86_64.rpm").test("kavynex-1.2.0-1_x86_64.rpm")).toBe(
            false
        );
    });
});

describe("isInstallerAsset", () => {
    it("recognizes each format a user downloads and runs", () => {
        for (const assetName of [
            "kavynex_1.2.0_x64-setup.exe",
            "kavynex_1.2.0_x64_en-US.msi",
            "kavynex_1.2.0_x64.dmg",
            "kavynex_1.2.0_amd64.AppImage",
            "kavynex_1.2.0_amd64.deb",
            "kavynex-1.2.0-1.x86_64.rpm",
        ]) {
            expect(isInstallerAsset(assetName), `should be an installer: ${assetName}`).toBe(true);
        }
    });

    it("excludes the assets a release carries for a machine rather than a reader", () => {
        // The `.app.tar.gz` pair is the one worth being explicit about: it is the macOS *updater*
        // bundle, so the README correctly never offers it as a download, and counting it as an
        // installer would make this gate demand a link that should not exist.
        for (const assetName of [
            "kavynex_1.2.0_x64-setup.exe.sig",
            "kavynex_1.2.0_amd64.deb.sig",
            "kavynex_1.2.0_x64.app.tar.gz",
            "kavynex_1.2.0_sbom.cdx.json",
            "latest.json",
            "SHA256SUMS.txt",
        ]) {
            expect(isInstallerAsset(assetName), `should not be an installer: ${assetName}`).toBe(
                false
            );
        }
    });
});

describe("findUnmatchedPatterns", () => {
    it("is empty when every documented name is on the release", () => {
        expect(
            findUnmatchedPatterns(
                ["kavynex_*_x64-setup.exe"],
                ["kavynex_1.2.0_x64-setup.exe", "latest.json"]
            )
        ).toEqual([]);
    });

    it("reports a name whose bundler renamed it", () => {
        // The v1.2.0 failure in miniature: the macOS `.app.tar.gz` names gained a version between
        // releases, so a README written against the old shape named a file that was not there.
        expect(
            findUnmatchedPatterns(
                ["kavynex_*_aarch64.dmg", "kavynex_*_x64.dmg"],
                ["kavynex_1.2.0_aarch64.dmg"]
            )
        ).toEqual(["kavynex_*_x64.dmg"]);
    });
});

describe("findUndocumentedInstallers", () => {
    it("is empty when every installer is documented", () => {
        expect(
            findUndocumentedInstallers(
                ["kavynex_*_x64-setup.exe"],
                ["kavynex_1.2.0_x64-setup.exe", "kavynex_1.2.0_x64-setup.exe.sig", "latest.json"]
            )
        ).toEqual([]);
    });

    it("reports an architecture the release ships and the README never mentions", () => {
        // Exactly what happened when Windows-on-ARM and Linux aarch64 first shipped in v1.2.0: the
        // assets were on the release page and the README listed only the x64 pair.
        expect(
            findUndocumentedInstallers(
                ["kavynex_*_x64-setup.exe"],
                [
                    "kavynex_1.2.0_x64-setup.exe",
                    "kavynex_1.2.0_arm64-setup.exe",
                    "kavynex_1.2.0_arm64-setup.exe.sig",
                ]
            )
        ).toEqual(["kavynex_1.2.0_arm64-setup.exe"]);
    });
});

describe("verifyReadmeAssetNames", () => {
    it("passes when the two inventories agree", () => {
        const result = verifyReadmeAssetNames({
            readmeContent: readme("- `kavynex_*_x64-setup.exe`"),
            assetNames: ["kavynex_1.2.0_x64-setup.exe", "kavynex_1.2.0_x64-setup.exe.sig"],
        });

        expect(result.ok).toBe(true);
        expect(result.message).toContain("All 1 download names");
    });

    it("refuses a README it could not read any download name out of", () => {
        // A reworded Installation section would otherwise make the forward check pass over an empty
        // list, which reads as success. The reverse check would still fire, but the message it
        // produces (every installer, undocumented) points at the wrong problem.
        const result = verifyReadmeAssetNames({
            readmeContent: readme("Download the installer from the releases page."),
            assetNames: ["kavynex_1.2.0_x64-setup.exe"],
        });

        expect(result.ok).toBe(false);
        expect(result.message).toContain("No asset-name patterns were found");
    });

    it("names both problems when both are present", () => {
        const result = verifyReadmeAssetNames({
            readmeContent: readme("- `kavynex_*_x64.dmg`"),
            assetNames: ["kavynex_1.2.0_amd64.deb"],
        });

        expect(result.ok).toBe(false);
        expect(result.message).toContain("kavynex_*_x64.dmg");
        expect(result.message).toContain("kavynex_1.2.0_amd64.deb");
    });

    it("accepts the checked-in README against the assets v1.2.0 published", () => {
        // The one test that pins the state of the repository rather than the logic: it is what
        // would have failed while the README still listed only the x64 installers, and it is what a
        // reader should look at first if this gate ever turns red on a real release.
        const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
        const readmeContent = readFileSync(join(root, "README.md"), "utf8");

        const result = verifyReadmeAssetNames({ readmeContent, assetNames: V1_2_0_ASSETS });

        expect(result.message).toContain("All 12 download names");
        expect(result.ok).toBe(true);
    });
});
