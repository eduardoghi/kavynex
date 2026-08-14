// Release step: rewrites each platform entry in the updater manifest to the tagged release-download
// URL, replacing the api.github.com asset URL tauri-action writes.
//
// The reason tauri-action writes that one is real. While a release is still a draft its tag is not
// attached to it yet, so an asset's download URL carries an `untagged-<hash>` path segment instead
// of `v<version>`. Baking that in would produce a manifest that breaks the moment the release is
// published. The asset API URL is stable across that transition, so it is the safe default for an
// action that cannot know whether the draft will ever be published.
//
// For this project the tagged URL is the correct one regardless: the updater endpoint is
// `releases/latest/download/latest.json`, which only ever resolves to a *published* release, so no
// user reaches this manifest while it is a draft. The api.github.com form would also work on a
// public repository, but it moves the download onto a host with a 60-request/hour unauthenticated
// rate limit and away from the one URL shape `verify-latest-json.js` accepts.
//
// The download prefix is derived by `releaseDownloadPrefix` (the same function the verification
// gate uses), rather than being rebuilt here, so the rewrite and the check that polices it cannot
// disagree about what a valid URL looks like.

import { readFileSync, writeFileSync } from "fs";
import { releaseDownloadPrefix } from "./verify-latest-json.js";

// Maps a manifest URL back to the asset it names. tauri-action writes the REST asset endpoint,
// whose last path segment is the numeric asset id, which is *not* the `id` the GitHub CLI reports
// (that one is a GraphQL node id like `RA_kwDO...`), so the id is taken from the URL itself and
// matched against the same field on the asset list.
export function assetIdFromUrl(url) {
    if (typeof url !== "string") {
        return null;
    }

    const id = url.trim().split("/").pop();

    return id ? id : null;
}

// Returns the manifest with every recognized platform URL rebuilt as `<prefix>v<version>/<asset>`,
// plus the platforms whose URL matched no asset.
//
// An unmatched entry is deliberately left untouched rather than dropped or guessed at: whatever it
// points to, `verify-latest-json.js` runs afterwards and rejects anything not under the expected
// prefix. Removing it here would turn that loud failure into a platform that quietly stops
// receiving updates. The exact outcome that gate exists to prevent.
export function rewriteManifestUrls(manifest, assets, downloadPrefix, version) {
    const names = new Map(assets.map((asset) => [asset.id, asset.name]));
    const unmatched = [];
    const platforms = manifest?.platforms ?? {};

    for (const [platform, entry] of Object.entries(platforms)) {
        const name = names.get(assetIdFromUrl(entry?.url));

        if (!name) {
            unmatched.push(platform);
            continue;
        }

        entry.url = `${downloadPrefix}v${version}/${name}`;
    }

    return { manifest, unmatched };
}

// Only run when invoked as a script, so the exports above stay unit-testable (importing this file
// must not read or write files).
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"))) {
    const [manifestPath, assetsPath] = process.argv.slice(2);

    if (!manifestPath || !assetsPath) {
        console.error(
            "Usage: node scripts/rewrite-latest-json-urls.js <path-to-latest.json> <path-to-assets.json>"
        );
        process.exit(1);
    }

    const version = JSON.parse(readFileSync("package.json", "utf8")).version;
    const updaterEndpoint = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8"))?.plugins
        ?.updater?.endpoints?.[0];
    const downloadPrefix = releaseDownloadPrefix(updaterEndpoint);

    if (!downloadPrefix) {
        console.error(
            "::error::could not derive the release URL prefix from tauri.conf.json's updater endpoint"
        );
        process.exit(1);
    }

    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const assets = JSON.parse(readFileSync(assetsPath, "utf8"));

    const { unmatched } = rewriteManifestUrls(manifest, assets, downloadPrefix, version);

    for (const platform of unmatched) {
        console.log(`::warning::${platform}: no release asset matches its url; left unchanged`);
    }

    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(JSON.stringify(manifest, null, 2));
}
