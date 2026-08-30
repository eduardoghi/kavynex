import { describe, expect, it } from "vitest";
import { assetIdFromUrl, rewriteManifestUrls } from "./rewrite-latest-json-urls.js";
import { findLatestJsonProblems, releaseDownloadPrefix } from "./verify-latest-json.js";

const ENDPOINT = "https://github.com/eduardoghi/kavynex/releases/latest/download/latest.json";
const PREFIX = "https://github.com/eduardoghi/kavynex/releases/download/";
const VERSION = "1.2.0";

const apiUrl = (id) => `https://api.github.com/repos/eduardoghi/kavynex/releases/assets/${id}`;

// The six platforms verify-latest-json.js requires, as tauri-action leaves them on a draft. Every
// url is the api.github.com asset endpoint rather than the tagged download url.
function draftManifest() {
    return {
        version: VERSION,
        platforms: {
            "darwin-aarch64": { signature: "sig", url: apiUrl("1") },
            "darwin-x86_64": { signature: "sig", url: apiUrl("2") },
            "linux-aarch64": { signature: "sig", url: apiUrl("3") },
            "linux-x86_64": { signature: "sig", url: apiUrl("4") },
            "windows-aarch64": { signature: "sig", url: apiUrl("5") },
            "windows-x86_64": { signature: "sig", url: apiUrl("6") },
        },
    };
}

const ASSETS = [
    { id: "1", name: `kavynex_${VERSION}_aarch64.app.tar.gz` },
    { id: "2", name: `kavynex_${VERSION}_x64.app.tar.gz` },
    { id: "3", name: `kavynex_${VERSION}_aarch64.AppImage` },
    { id: "4", name: `kavynex_${VERSION}_amd64.AppImage` },
    { id: "5", name: `kavynex_${VERSION}_arm64_en-US.msi` },
    { id: "6", name: `kavynex_${VERSION}_x64_en-US.msi` },
];

describe("assetIdFromUrl", () => {
    it("takes the numeric asset id from the rest endpoint", () => {
        expect(assetIdFromUrl(apiUrl("490727185"))).toBe("490727185");
    });

    it("returns null for a value that is not a url string", () => {
        expect(assetIdFromUrl(undefined)).toBeNull();
        expect(assetIdFromUrl(42)).toBeNull();
        expect(assetIdFromUrl("")).toBeNull();
    });
});

describe("rewriteManifestUrls", () => {
    it("rebuilds every url as the tagged release-download url", () => {
        const { manifest, unmatched } = rewriteManifestUrls(
            draftManifest(),
            ASSETS,
            PREFIX,
            VERSION
        );

        expect(unmatched).toEqual([]);
        expect(manifest.platforms["linux-aarch64"].url).toBe(
            `${PREFIX}v${VERSION}/kavynex_${VERSION}_aarch64.AppImage`
        );
        expect(manifest.platforms["windows-x86_64"].url).toBe(
            `${PREFIX}v${VERSION}/kavynex_${VERSION}_x64_en-US.msi`
        );
    });

    it("produces a manifest the verification gate accepts", () => {
        // The property that matters. The rewrite exists to satisfy verify-latest-json.js, so assert
        // against that script rather than against a url string this test wrote itself. Both derive
        // the prefix from the same endpoint, so a change to either one is caught here.
        const prefix = releaseDownloadPrefix(ENDPOINT);
        const { manifest } = rewriteManifestUrls(draftManifest(), ASSETS, prefix, VERSION);

        expect(findLatestJsonProblems(manifest, VERSION, prefix)).toEqual([]);
    });

    it("leaves the signature of every entry untouched", () => {
        // minisign covers the artifact bytes, not the url, so rewriting one must never disturb the
        // other. A dropped signature would fail the update on a user's machine, not here.
        const { manifest } = rewriteManifestUrls(draftManifest(), ASSETS, PREFIX, VERSION);

        for (const entry of Object.values(manifest.platforms)) {
            expect(entry.signature).toBe("sig");
        }
    });

    it("leaves an entry whose url matches no asset in place and reports it", () => {
        // Dropping or guessing at it would turn the loud failure verify-latest-json.js is about to
        // raise into a platform that silently stops receiving updates.
        const manifest = draftManifest();
        manifest.platforms["linux-x86_64"].url = apiUrl("999");

        const result = rewriteManifestUrls(manifest, ASSETS, PREFIX, VERSION);

        expect(result.unmatched).toEqual(["linux-x86_64"]);
        expect(result.manifest.platforms["linux-x86_64"].url).toBe(apiUrl("999"));
        // An unmatched entry is exactly what the gate must then reject.
        expect(findLatestJsonProblems(result.manifest, VERSION, PREFIX)).toContainEqual(
            expect.stringContaining("linux-x86_64")
        );
    });

    it("handles a manifest carrying no platforms without throwing", () => {
        expect(rewriteManifestUrls({}, ASSETS, PREFIX, VERSION).unmatched).toEqual([]);
    });
});
