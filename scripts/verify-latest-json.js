#!/usr/bin/env node

// Release gate: fails when the updater manifest on the draft release does not offer a signed
// artifact for every platform.
//
// The workflow's asset check proves latest.json is *present*, which is not the same as it being
// complete. Each build leg merges its own entries into that one file on the release, so a leg that
// uploaded its installer but lost the merge (a transient API error, two legs racing) leaves a
// latest.json that parses fine and simply never offers an update to one platform. Nothing else
// would notice: the file is there, the installers are there, and only users on the missing platform
// would quietly stop receiving updates.

import { readFileSync } from "fs";

// The keys the updater actually resolves. Tauri also emits `-app`/`-msi`/`-nsis`/`-appimage`/
// `-deb`/`-rpm` variants of these, but the client looks up the bare `<os>-<arch>` one, so those are
// what a release has to carry.
const REQUIRED_PLATFORMS = ["darwin-aarch64", "darwin-x86_64", "linux-x86_64", "windows-x86_64"];

// Derives the URL prefix every updater artifact must sit under, from the same GitHub release
// endpoint the client is actually pointed at (tauri.conf.json's updater `endpoints`). That
// endpoint is `.../releases/latest/download/latest.json`, while the per-asset URLs are
// `.../releases/download/v<version>/<asset>`, so they share everything up to `/releases/` and then
// take `download/`. Deriving the prefix from the endpoint - rather than hardcoding the owner/repo a
// second time here - keeps this in step with the one place the repo is already declared, so moving
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

        if (!url) {
            problems.push(`${platform}: empty url`);
        } else if (expectedUrlPrefix && !url.startsWith(expectedUrlPrefix)) {
            // A non-empty but wrong url - a mismatched owner/repo or a non-github host from a
            // tauri-action misconfiguration - passes the emptiness check above and then points the
            // updater somewhere other than this release. Requiring the repo's own release-download
            // prefix rules that out (the trailing `/` after the repo name means a look-alike host
            // like github.com.evil or a `kavynex-evil` repo cannot match).
            problems.push(
                `${platform}: url ${JSON.stringify(entry.url)} is not under ${expectedUrlPrefix}`
            );
        }
    }

    return problems;
}

// Only run the gate when invoked as a script, so the export above stays unit-testable.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"))) {
    const manifestPath = process.argv[2];

    if (!manifestPath) {
        console.error("Usage: node scripts/verify-latest-json.js <path-to-latest.json>");
        process.exit(1);
    }

    const expectedVersion = JSON.parse(readFileSync("package.json", "utf8")).version;

    // Derive the required artifact URL prefix from the updater endpoint the client is pointed at,
    // so a url pointing at the wrong repo/host is caught here rather than shipping in the manifest.
    const updaterEndpoint = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8"))?.plugins
        ?.updater?.endpoints?.[0];
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

    console.log(`latest.json offers a signed artifact for every platform (version ${expectedVersion}).`);
}
