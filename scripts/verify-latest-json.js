// Release gate. Fails when the updater manifest on the draft release does not offer a signed
// artifact for every platform and installer, or when a signature does not verify against the file
// its entry points at.
//
// The workflow's asset check proves latest.json is *present*, which is not the same as it being
// complete. Each build leg merges its own entries into that one file on the release, so a leg that
// uploaded its installer but lost the merge (a transient API error, two legs racing) leaves a
// latest.json that parses fine and simply never offers an update to one platform. Nothing else
// would notice. The file is there, the installers are there, and only users on the missing platform
// would quietly stop receiving updates.

import { createReadStream, readFileSync } from "fs";
import { createHash, createPublicKey, verify } from "crypto";
import { basename, dirname, join } from "path";
import { isMainModule } from "./script-entry.js";

// Every key the release carries, mapped to the asset suffix its entry must point at (null for the
// bare key, which tauri fills with one of the installers).
//
// The client looks up `<os>-<arch>-<installer>` first and falls back to the bare `<os>-<arch>`
// only when that is missing (`get_urls` in tauri-plugin-updater). Checking only the bare keys, as
// this gate once did, let an install whose own key was missing quietly take the bare entry, which
// on Windows is the MSI, so an NSIS install would have been updated with the other installer.
const ENTRY_SUFFIXES = {
    "darwin-aarch64": null,
    "darwin-aarch64-app": ".app.tar.gz",
    "darwin-x86_64": null,
    "darwin-x86_64-app": ".app.tar.gz",
    "linux-aarch64": null,
    "linux-aarch64-appimage": ".AppImage",
    "linux-aarch64-deb": ".deb",
    "linux-aarch64-rpm": ".rpm",
    "linux-x86_64": null,
    "linux-x86_64-appimage": ".AppImage",
    "linux-x86_64-deb": ".deb",
    "linux-x86_64-rpm": ".rpm",
    "windows-aarch64": null,
    "windows-aarch64-msi": ".msi",
    "windows-aarch64-nsis": "-setup.exe",
    "windows-x86_64": null,
    "windows-x86_64-msi": ".msi",
    "windows-x86_64-nsis": "-setup.exe",
};

export const REQUIRED_PLATFORMS = Object.keys(ENTRY_SUFFIXES);

// Derives the URL prefix every updater artifact must sit under, from the same GitHub release
// endpoint the client is actually pointed at (tauri.conf.json's updater `endpoints`). That
// endpoint is `.../releases/latest/download/latest.json`, while the per-asset URLs are
// `.../releases/download/v<version>/<asset>`, so they share everything up to `/releases/` and then
// take `download/`. Deriving the prefix from the endpoint (rather than hardcoding the owner/repo a
// second time here) keeps this in step with the one place the repo is already declared, so moving
// the repo cannot leave this check pointing at the old one. Returns null when the endpoint is
// missing or not shaped like a GitHub release URL, so the caller can fail loudly.
export function releaseDownloadPrefix(updaterEndpoint) {
    if (typeof updaterEndpoint !== "string") {
        return null;
    }

    const marker = "/releases/";
    const markerIndex = updaterEndpoint.indexOf(marker);

    if (markerIndex === -1) {
        return null;
    }

    return `${updaterEndpoint.slice(0, markerIndex)}/releases/download/`;
}

export function findLatestJsonProblems(manifest, expectedVersion, expectedUrlPrefix) {
    const problems = [];

    if (manifest?.version !== expectedVersion) {
        problems.push(
            `advertises version ${JSON.stringify(manifest?.version)} but this release is ${expectedVersion}`
        );
    }

    for (const platform of REQUIRED_PLATFORMS) {
        const entry = manifest?.platforms?.[platform];

        if (!entry) {
            problems.push(`${platform}: missing`);
            continue;
        }

        // An entry with an empty signature or url parses fine and then fails on the user's machine,
        // which is the failure this gate exists to keep off the release in the first place.
        if (!entry.signature?.trim()) {
            problems.push(`${platform}: empty signature`);
        }

        const url = entry.url?.trim();
        const suffix = ENTRY_SUFFIXES[platform];

        if (url && suffix && !assetNameFromUrl(url).endsWith(suffix)) {
            problems.push(`${platform}: url ${JSON.stringify(entry.url)} is not a ${suffix} file`);
        }

        if (!url) {
            problems.push(`${platform}: empty url`);
        } else if (expectedUrlPrefix && !url.startsWith(expectedUrlPrefix)) {
            // A non-empty but wrong url (a mismatched owner/repo or a non-github host from a
            // tauri-action misconfiguration), passes the emptiness check above and then points the
            // updater somewhere other than this release. Requiring the repo's own release-download
            // prefix rules that out (the trailing `/` after the repo name means a look-alike host
            // like github.com.evil or a `kavynex-evil` repo cannot match).
            problems.push(
                `${platform}: url ${JSON.stringify(entry.url)} is not under ${expectedUrlPrefix}`
            );
        } else if (expectedUrlPrefix && !url.startsWith(`${expectedUrlPrefix}v${expectedVersion}/`)) {
            // The repo prefix matches but the version segment does not. Each build leg merges its
            // own platform entry into the one latest.json on the draft release, so a merge race or
            // partial failure could leave a platform pointing at a *previous* release's asset. That
            // asset keeps a valid minisign signature forever, so the client would accept it and
            // serve an older binary under this release's (higher) version number. `manifest.version`
            // is only checked at the top level, so the top can read correct while a platform's URL
            // is stale. Requiring the `v<version>/` segment per entry closes that window.
            problems.push(
                `${platform}: url ${JSON.stringify(entry.url)} is not under ${expectedUrlPrefix}v${expectedVersion}/`
            );
        }
    }

    return problems;
}

// The release asset an entry's URL names, which is also its file name in the downloaded copy.
export function assetNameFromUrl(url) {
    const last = String(url).trim().split("/").pop() ?? "";

    try {
        return decodeURIComponent(last);
    } catch {
        return last;
    }
}

// The lines of a minisign text file (a `.sig`, or the public key), base64-encoded once more as
// tauri stores both.
function minisignLines(base64Text) {
    return Buffer.from(String(base64Text ?? "").trim(), "base64")
        .toString("utf8")
        .split(/\r?\n/);
}

function ed25519PublicKey(rawKey) {
    return createPublicKey({
        key: { kty: "OKP", crv: "Ed25519", x: rawKey.toString("base64url") },
        format: "jwk",
    });
}

// Checks a tauri updater signature against the BLAKE2b-512 digest of the file it signs. Returns a
// reason when it does not verify, or null.
//
// The minisign layout. The public key's second line decodes to `Ed`, an 8-byte key id and the
// 32-byte key. The signature's second line decodes to the algorithm, the key id and 64 bytes of
// signature, and its fourth line signs those 64 bytes followed by the trusted comment, so the
// comment cannot be swapped either. Only `ED` (prehashed) is accepted, which is what tauri's signer
// writes. A legacy `Ed` signature would need the whole file in memory to check.
export function minisignSignatureProblem(signatureBase64, publicKeyBase64, fileDigest) {
    const keyBytes = Buffer.from(minisignLines(publicKeyBase64)[1] ?? "", "base64");

    if (keyBytes.length !== 42 || keyBytes.subarray(0, 2).toString("latin1") !== "Ed") {
        return "the updater public key is not a minisign Ed25519 key";
    }

    const lines = minisignLines(signatureBase64);
    const signatureBytes = Buffer.from(lines[1] ?? "", "base64");
    const commentPrefix = "trusted comment: ";
    const trustedComment = (lines[2] ?? "").startsWith(commentPrefix)
        ? lines[2].slice(commentPrefix.length)
        : null;
    const globalSignature = Buffer.from(lines[3] ?? "", "base64");

    if (signatureBytes.length !== 74 || trustedComment === null || globalSignature.length !== 64) {
        return "the signature is not a minisign signature";
    }

    if (signatureBytes.subarray(0, 2).toString("latin1") !== "ED") {
        return "the signature is not prehashed (ED)";
    }

    if (!signatureBytes.subarray(2, 10).equals(keyBytes.subarray(2, 10))) {
        return "the signature was made with a different key than the updater trusts";
    }

    const publicKey = ed25519PublicKey(keyBytes.subarray(10));
    const signature = signatureBytes.subarray(10);

    if (!verify(null, fileDigest, publicKey, signature)) {
        return "the signature does not match the file";
    }

    const signedComment = Buffer.concat([signature, Buffer.from(trustedComment, "utf8")]);

    if (!verify(null, signedComment, publicKey, globalSignature)) {
        return "the trusted comment signature does not verify";
    }

    return null;
}

export function blake2b512OfFile(path) {
    return new Promise((resolve, reject) => {
        const hash = createHash("blake2b512");
        createReadStream(path)
            .on("error", reject)
            .on("data", (chunk) => hash.update(chunk))
            .on("end", () => resolve(hash.digest()));
    });
}

// Verifies every entry's signature against the file it names in `assetsDir`, the copy of the
// release the checksums job downloaded. The structural check proves a signature is there. Only
// this proves it is the right one, made with the key the shipped app trusts, for the bytes the
// entry serves. Without it, a leg signing with a rotated or wrong key (or an entry whose signature
// and url came from different merges) passes every other gate and fails on each user's machine.
export async function findSignatureProblems(manifest, assetsDir, publicKeyBase64) {
    const problems = [];
    const digests = new Map();

    for (const platform of REQUIRED_PLATFORMS) {
        const entry = manifest?.platforms?.[platform];

        if (!entry?.url?.trim() || !entry.signature?.trim()) {
            // Already reported by findLatestJsonProblems.
            continue;
        }

        // basename, so a crafted url cannot point the read outside the assets directory.
        const name = basename(assetNameFromUrl(entry.url));

        if (!digests.has(name)) {
            digests.set(name, await blake2b512OfFile(join(assetsDir, name)).catch(() => null));
        }

        const digest = digests.get(name);

        if (!digest) {
            problems.push(`${platform}: ${name} is not among the release's assets`);
            continue;
        }

        const problem = minisignSignatureProblem(entry.signature, publicKeyBase64, digest);

        if (problem) {
            problems.push(`${platform}: ${problem}`);
        }
    }

    return problems;
}

// Only run the gate when invoked as a script, so the export above stays unit-testable.
if (isMainModule(import.meta.url)) {
    const manifestPath = process.argv[2];

    if (!manifestPath) {
        console.error("Usage: node scripts/verify-latest-json.js <path-to-latest.json>");
        process.exit(1);
    }

    const expectedVersion = JSON.parse(readFileSync("package.json", "utf8")).version;

    // Derive the required artifact URL prefix from the updater endpoint the client is pointed at,
    // so a url pointing at the wrong repo/host is caught here rather than shipping in the manifest.
    const updaterConfig = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8"))?.plugins
        ?.updater;
    const updaterEndpoint = updaterConfig?.endpoints?.[0];
    const expectedUrlPrefix = releaseDownloadPrefix(updaterEndpoint);

    if (!expectedUrlPrefix) {
        console.error(
            "::error::could not derive the expected release URL prefix from tauri.conf.json's updater endpoint"
        );
        process.exit(1);
    }

    const raw = readFileSync(manifestPath, "utf8");
    console.log(raw);

    let manifest;

    try {
        manifest = JSON.parse(raw);
    } catch (error) {
        console.error(`::error::${manifestPath} is not valid JSON: ${error.message}`);
        process.exit(1);
    }

    const problems = findLatestJsonProblems(manifest, expectedVersion, expectedUrlPrefix);

    if (problems.length > 0) {
        console.error(
            "::error::latest.json is incomplete: the updater would never offer an update to every platform. Do not publish."
        );
        for (const problem of problems) {
            console.error(`  ${problem}`);
        }
        process.exit(1);
    }

    // The manifest sits in the directory the release was downloaded into.
    const signatureProblems = await findSignatureProblems(
        manifest,
        dirname(manifestPath),
        updaterConfig?.pubkey
    );

    if (signatureProblems.length > 0) {
        console.error(
            "::error::latest.json carries signatures the updater would reject. Do not publish."
        );
        for (const problem of signatureProblems) {
            console.error(`  ${problem}`);
        }
        process.exit(1);
    }

    console.log(
        `latest.json offers a verified signed artifact for every platform and installer (version ${expectedVersion}).`
    );
}
