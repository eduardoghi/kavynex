import { generateKeyPairSync, sign } from "crypto";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";
import {
    assetNameFromUrl,
    blake2b512OfFile,
    findLatestJsonProblems,
    findSignatureProblems,
    minisignSignatureProblem,
    pubkeyToVerifyWith,
    releaseDownloadPrefix,
    REQUIRED_PLATFORMS,
} from "./verify-latest-json.js";

const ENDPOINT = "https://github.com/eduardoghi/kavynex/releases/latest/download/latest.json";
const PREFIX = "https://github.com/eduardoghi/kavynex/releases/download/";

function completeManifest(version = "1.2.0") {
    const asset = (name) => `${PREFIX}v${version}/${name}`;

    return {
        version,
        // The shape tauri-action wrote for v1.7.0, bare keys and installer keys alike.
        platforms: Object.fromEntries(
            Object.entries(manifestAssetNames(version)).map(([platform, name]) => [
                platform,
                { signature: "sig", url: asset(name) },
            ])
        ),
    };
}

function manifestAssetNames(version) {
    return {
        "darwin-aarch64": `kavynex_${version}_aarch64.app.tar.gz`,
        "darwin-aarch64-app": `kavynex_${version}_aarch64.app.tar.gz`,
        "darwin-x86_64": `kavynex_${version}_x64.app.tar.gz`,
        "darwin-x86_64-app": `kavynex_${version}_x64.app.tar.gz`,
        "linux-aarch64": `kavynex_${version}_aarch64.AppImage`,
        "linux-aarch64-appimage": `kavynex_${version}_aarch64.AppImage`,
        "linux-aarch64-deb": `kavynex_${version}_arm64.deb`,
        "linux-aarch64-rpm": `kavynex-${version}-1.aarch64.rpm`,
        "linux-x86_64": `kavynex_${version}_amd64.AppImage`,
        "linux-x86_64-appimage": `kavynex_${version}_amd64.AppImage`,
        "linux-x86_64-deb": `kavynex_${version}_amd64.deb`,
        "linux-x86_64-rpm": `kavynex-${version}-1.x86_64.rpm`,
        "windows-aarch64": `kavynex_${version}_arm64_en-US.msi`,
        "windows-aarch64-msi": `kavynex_${version}_arm64_en-US.msi`,
        "windows-aarch64-nsis": `kavynex_${version}_arm64-setup.exe`,
        "windows-x86_64": `kavynex_${version}_x64_en-US.msi`,
        "windows-x86_64-msi": `kavynex_${version}_x64_en-US.msi`,
        "windows-x86_64-nsis": `kavynex_${version}_x64-setup.exe`,
    };
}

const KEY_ID = Buffer.from("1fc461a4b9d27122", "hex");

function base64Lines(...lines) {
    return Buffer.from(`${lines.join("\n")}\n`, "utf8").toString("base64");
}

// A minisign key pair in the two encodings tauri uses, the public key as tauri.conf.json stores it
// and a signer producing the base64 `.sig` text latest.json carries.
function minisignKeyPair(keyId = KEY_ID) {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const rawPublicKey = Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url");
    const publicKeyText = base64Lines(
        "untrusted comment: minisign public key",
        Buffer.concat([Buffer.from("Ed"), keyId, rawPublicKey]).toString("base64")
    );

    const signDigest = (digest, { algorithm = "ED", comment = "timestamp:1\tfile:x" } = {}) => {
        const signature = sign(null, digest, privateKey);
        const globalSignature = sign(
            null,
            Buffer.concat([signature, Buffer.from(comment, "utf8")]),
            privateKey
        );

        return base64Lines(
            "untrusted comment: signature from tauri secret key",
            Buffer.concat([Buffer.from(algorithm), keyId, signature]).toString("base64"),
            `trusted comment: ${comment}`,
            globalSignature.toString("base64")
        );
    };

    return { publicKeyText, signDigest };
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

    it("flags a platform pointing at a prior release's asset (right repo, wrong version segment)", () => {
        // A stale entry from v1.1.0 merged into this v1.2.0 release. Correct repo prefix and a
        // still-valid signature, but the URL's version segment is the old one. The top-level
        // version reads correct, so only a per-entry version check catches it, without which the
        // updater would serve the old, validly-signed binary under the new version number.
        const manifest = completeManifest("1.2.0");
        manifest.platforms["windows-x86_64"].url = `${PREFIX}v1.1.0/kavynex_1.1.0_x64-setup.exe`;

        const problems = findLatestJsonProblems(manifest, "1.2.0", PREFIX);
        expect(problems.some((problem) => problem.startsWith("windows-x86_64: url"))).toBe(true);
        expect(problems.some((problem) => problem.includes(`${PREFIX}v1.2.0/`))).toBe(true);
    });

    it("requires every installer key, not only the bare ones", () => {
        // The client looks up `<os>-<arch>-<installer>` first, so a missing nsis entry sends an
        // NSIS install to the bare entry, which is the MSI.
        expect(REQUIRED_PLATFORMS).toHaveLength(18);

        const manifest = completeManifest();
        delete manifest.platforms["windows-x86_64-nsis"];

        expect(findLatestJsonProblems(manifest, "1.2.0", PREFIX)).toEqual([
            "windows-x86_64-nsis: missing",
        ]);
    });

    it("flags an installer key that points at another installer's file", () => {
        const manifest = completeManifest();
        manifest.platforms["windows-x86_64-nsis"].url = `${PREFIX}v1.2.0/kavynex_1.2.0_x64_en-US.msi`;
        manifest.platforms["linux-x86_64-rpm"].url = `${PREFIX}v1.2.0/kavynex_1.2.0_amd64.deb`;

        const problems = findLatestJsonProblems(manifest, "1.2.0", PREFIX);
        expect(problems).toHaveLength(2);
        expect(problems[0]).toContain("is not a .rpm file");
        expect(problems[1]).toContain("is not a -setup.exe file");
    });

    it("skips the url-prefix check when no prefix is supplied", () => {
        const manifest = completeManifest();
        manifest.platforms["windows-x86_64"].url = "https://elsewhere.example/x.exe";

        // A non-empty (if wrong) url without an expected prefix is only checked for emptiness, so
        // the older two-argument call keeps behaving as before.
        expect(findLatestJsonProblems(manifest, "1.2.0")).toEqual([]);
    });
});

describe("assetNameFromUrl", () => {
    it("takes the decoded last path segment", () => {
        expect(assetNameFromUrl(`${PREFIX}v1.2.0/kavynex_1.2.0_x64-setup.exe`)).toBe(
            "kavynex_1.2.0_x64-setup.exe"
        );
        expect(assetNameFromUrl(`${PREFIX}v1.2.0/a%20b.msi`)).toBe("a b.msi");
        expect(assetNameFromUrl(`${PREFIX}v1.2.0/bad%zz.msi`)).toBe("bad%zz.msi");
    });
});

describe("minisignSignatureProblem", () => {
    const digest = Buffer.alloc(64, 7);

    it("accepts a prehashed signature of the digest made with the trusted key", () => {
        const { publicKeyText, signDigest } = minisignKeyPair();

        expect(minisignSignatureProblem(signDigest(digest), publicKeyText, digest)).toBeNull();
    });

    it("rejects a signature of other bytes", () => {
        const { publicKeyText, signDigest } = minisignKeyPair();

        expect(
            minisignSignatureProblem(signDigest(Buffer.alloc(64, 8)), publicKeyText, digest)
        ).toBe("the signature does not match the file");
    });

    it("rejects a signature made with another key, even under the same key id", () => {
        const trusted = minisignKeyPair();
        const other = minisignKeyPair();

        expect(minisignSignatureProblem(other.signDigest(digest), trusted.publicKeyText, digest)).toBe(
            "the signature does not match the file"
        );
    });

    it("rejects a signature whose key id is not the trusted one", () => {
        const trusted = minisignKeyPair();
        const other = minisignKeyPair(Buffer.alloc(8, 1));

        expect(minisignSignatureProblem(other.signDigest(digest), trusted.publicKeyText, digest)).toBe(
            "the signature was made with a different key than the updater trusts"
        );
    });

    it("rejects a trusted comment that was swapped after signing", () => {
        const { publicKeyText, signDigest } = minisignKeyPair();
        const lines = Buffer.from(signDigest(digest), "base64").toString("utf8").split("\n");
        lines[2] = "trusted comment: timestamp:1\tfile:something-else";
        const swapped = Buffer.from(lines.join("\n"), "utf8").toString("base64");

        expect(minisignSignatureProblem(swapped, publicKeyText, digest)).toBe(
            "the trusted comment signature does not verify"
        );
    });

    it("rejects a legacy signature and malformed input", () => {
        const { publicKeyText, signDigest } = minisignKeyPair();

        expect(
            minisignSignatureProblem(signDigest(digest, { algorithm: "Ed" }), publicKeyText, digest)
        ).toBe("the signature is not prehashed (ED)");
        expect(minisignSignatureProblem("c2ln", publicKeyText, digest)).toBe(
            "the signature is not a minisign signature"
        );
        expect(minisignSignatureProblem(signDigest(digest), undefined, digest)).toBe(
            "the updater public key is not a minisign Ed25519 key"
        );
    });
});

describe("findSignatureProblems", () => {
    it("verifies each entry against the file it names and reports the ones that fail", async () => {
        const dir = mkdtempSync(join(tmpdir(), "kavynex-latest-json-"));

        try {
            const { publicKeyText, signDigest } = minisignKeyPair();
            const manifest = completeManifest();
            const names = manifestAssetNames("1.2.0");

            for (const name of new Set(Object.values(names))) {
                writeFileSync(join(dir, name), `contents of ${name}`);
            }

            for (const [platform, name] of Object.entries(names)) {
                manifest.platforms[platform].signature = signDigest(
                    await blake2b512OfFile(join(dir, name))
                );
            }

            expect(await findSignatureProblems(manifest, dir, publicKeyText)).toEqual([]);

            // One entry carrying another file's signature, as a merge race would leave it.
            manifest.platforms["linux-x86_64-deb"].signature =
                manifest.platforms["linux-x86_64-rpm"].signature;
            // One naming a file the release does not have. The traversal is dropped to the name.
            manifest.platforms["darwin-x86_64-app"].url = `${PREFIX}v1.2.0/..%2F..%2Fsecret.app.tar.gz`;

            expect(await findSignatureProblems(manifest, dir, publicKeyText)).toEqual([
                "darwin-x86_64-app: secret.app.tar.gz is not among the release's assets",
                "linux-x86_64-deb: the signature does not match the file",
            ]);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("leaves entries without a url or signature to the structural check", async () => {
        const manifest = completeManifest();
        for (const entry of Object.values(manifest.platforms)) {
            entry.signature = "";
        }

        expect(await findSignatureProblems(manifest, tmpdir(), "")).toEqual([]);
    });
});

describe("pubkeyToVerifyWith", () => {
    it("uses the key in tauri.conf.json unless a rotation names the old one", () => {
        expect(pubkeyToVerifyWith("config-key", undefined)).toBe("config-key");
        expect(pubkeyToVerifyWith("config-key", "")).toBe("config-key");
        expect(pubkeyToVerifyWith("config-key", "   ")).toBe("config-key");
        expect(pubkeyToVerifyWith("config-key", " old-key ")).toBe("old-key");
    });
});
