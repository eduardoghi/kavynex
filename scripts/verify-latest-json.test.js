import { describe, expect, it } from "vitest";
import { findLatestJsonProblems, releaseDownloadPrefix } from "./verify-latest-json.js";

const ENDPOINT = "https://github.com/eduardoghi/kavynex/releases/latest/download/latest.json";
const PREFIX = "https://github.com/eduardoghi/kavynex/releases/download/";

function completeManifest(version = "1.2.0") {
    const asset = (name) => `${PREFIX}v${version}/${name}`;

    return {
        version,
        platforms: {
            "darwin-aarch64": { signature: "sig", url: asset("kavynex_aarch64.app.tar.gz") },
            "darwin-x86_64": { signature: "sig", url: asset("kavynex_x64.app.tar.gz") },
            "linux-x86_64": { signature: "sig", url: asset(`kavynex_${version}_amd64.AppImage`) },
            "windows-x86_64": { signature: "sig", url: asset(`kavynex_${version}_x64-setup.exe`) },
        },
    };
}

describe("releaseDownloadPrefix", () => {
    it("derives the release-download prefix from the updater endpoint", () => {
        expect(releaseDownloadPrefix(ENDPOINT)).toBe(PREFIX);
    });

    it("returns null when the endpoint is missing or not a github release url", () => {
        expect(releaseDownloadPrefix(undefined)).toBeNull();
        expect(releaseDownloadPrefix(123)).toBeNull();
        expect(releaseDownloadPrefix("https://example.com/latest.json")).toBeNull();
    });
});

describe("findLatestJsonProblems", () => {
    it("reports no problems for a complete, correctly-hosted manifest", () => {
        expect(findLatestJsonProblems(completeManifest(), "1.2.0", PREFIX)).toEqual([]);
    });

    it("flags a version that does not match the release", () => {
        const problems = findLatestJsonProblems(completeManifest("1.1.0"), "1.2.0", PREFIX);
        expect(problems).toContain('advertises version "1.1.0" but this release is 1.2.0');
    });

    it("flags a missing platform", () => {
        const manifest = completeManifest();
        delete manifest.platforms["windows-x86_64"];

        expect(findLatestJsonProblems(manifest, "1.2.0", PREFIX)).toContain(
            "windows-x86_64: missing"
        );
    });

    it("flags an empty signature or url", () => {
        const manifest = completeManifest();
        manifest.platforms["darwin-aarch64"] = { signature: "  ", url: "" };

        const problems = findLatestJsonProblems(manifest, "1.2.0", PREFIX);
        expect(problems).toContain("darwin-aarch64: empty signature");
        expect(problems).toContain("darwin-aarch64: empty url");
    });

    it("flags a url that points at a different repo", () => {
        const manifest = completeManifest();
        manifest.platforms["windows-x86_64"].url =
            "https://github.com/someone/else/releases/download/v1.2.0/kavynex_1.2.0_x64-setup.exe";

        const problems = findLatestJsonProblems(manifest, "1.2.0", PREFIX);
        expect(problems.some((problem) => problem.startsWith("windows-x86_64: url"))).toBe(true);
        expect(problems.some((problem) => problem.includes("is not under"))).toBe(true);
    });

    it("flags a look-alike host that would slip past a bare host check", () => {
        const manifest = completeManifest();
        manifest.platforms["linux-x86_64"].url =
            "https://github.com.evil.example/eduardoghi/kavynex/releases/download/v1.2.0/x.AppImage";

        const problems = findLatestJsonProblems(manifest, "1.2.0", PREFIX);
        expect(problems.some((problem) => problem.startsWith("linux-x86_64: url"))).toBe(true);
    });

    it("skips the url-prefix check when no prefix is supplied", () => {
        const manifest = completeManifest();
        manifest.platforms["windows-x86_64"].url = "https://elsewhere.example/x.exe";

        // A non-empty (if wrong) url without an expected prefix is only checked for emptiness, so
        // the older two-argument call keeps behaving as before.
        expect(findLatestJsonProblems(manifest, "1.2.0")).toEqual([]);
    });
});
