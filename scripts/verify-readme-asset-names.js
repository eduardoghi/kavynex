// Release gate: fails when README.md's download list and the assets a release actually carries
// disagree.
//
// README.md's Installation section is the only place in this repository that spells out installer
// filenames for a *reader*, and it is what someone lands on to pick their download. The names in it
// track tauri's per-bundler conventions, which are not stable: the v1.2.0 dispatch confirmed the
// arm64 names that release.yml had flagged as derived rather than observed, and broke on the pair
// that *had* been observed. The macOS `.app.tar.gz` names gained a version between v1.1.1 and
// v1.2.0. So the list is perishable in both directions, and until this existed nothing held it.
//
// The asset-completeness check in release.yml's `checksums` job holds the other inventory of the
// same names, and it is deliberately not what this reads. Checking the README against the real
// assets instead means a release where both lists drifted together (the case a cross-check between
// them would pass), still fails here.
//
// Both directions are checked, because the two failures are different and neither is loud:
//
//   - A README pattern matching no asset sends a user looking for a file that is not there.
//   - An installer asset no pattern names is a download the release page offers and the README
//     never mentions, which is how an architecture ships undocumented. That is not hypothetical:
//     Windows-on-ARM and Linux aarch64 first shipped in v1.2.0 and had to be added to the README by
//     hand afterwards.
//
// Run locally against a published or draft release:
//     gh release view v1.2.0 --json assets --jq '.assets[].name' > /tmp/assets.txt
//     node scripts/verify-readme-asset-names.js /tmp/assets.txt

import { readFileSync } from "fs";
import { resolve, dirname, join } from "path";
import { fileURLToPath } from "url";

// The final extensions that make an asset something a user downloads and runs, as opposed to
// something the release carries for a machine (`.sig`, `latest.json`, `SHA256SUMS.txt`, the SBOM)
// or for the updater alone (the macOS `.app.tar.gz`, which is the update bundle and never a link
// the README should offer).
//
// This list is the classification decision, so it is stated rather than derived from the README:
// deriving it would make the reverse check answer "is every documented extension documented",
// which is vacuous. A bundler added to `bundle.targets` that emits a new extension has to be added
// here to be covered, which is the same edit `docs/RELEASING.md` already says a new bundler
// forces, alongside the completeness list and the attestation's subject-path.
const INSTALLER_EXTENSIONS = ["exe", "msi", "dmg", "appimage", "deb", "rpm"];

/**
 * The asset-name patterns README.md documents, in document order.
 *
 * A pattern is an inline-code token beginning with `kavynex` and containing a `*`. Requiring the
 * `*` is what does the work: the README mentions `kavynex.db.corrupt` and `kavynex.log` elsewhere,
 * and neither is an asset. The cost of that rule is that a name written out with a literal version
 * would be skipped silently, which the reverse direction below catches, since every installer it
 * was supposed to name then goes unmatched.
 */
export function parseReadmeAssetPatterns(readmeContent) {
    const patterns = [];

    for (const [, token] of readmeContent.matchAll(/`(kavynex[^`\s]*)`/g)) {
        if (token.includes("*") && !patterns.includes(token)) {
            patterns.push(token);
        }
    }

    return patterns;
}

/**
 * Compiles one README pattern into an anchored matcher, with `*` standing for the version segment.
 *
 * `[^\s]+` rather than `.*`: the placeholder always covers a version (`1.2.0`, or `1.2.0-1` in the
 * rpm names), never nothing and never a gap between two names. Anchoring both ends is what keeps
 * `kavynex_*_amd64.deb` from also matching its own `.sig`.
 */
export function patternToRegExp(pattern) {
    const escaped = pattern
        .split("*")
        .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join("[^\\s]+");

    return new RegExp(`^${escaped}$`);
}

/** True when `assetName` is something a user downloads and runs, rather than release metadata. */
export function isInstallerAsset(assetName) {
    const extension = assetName.split(".").pop()?.toLowerCase() ?? "";

    return INSTALLER_EXTENSIONS.includes(extension);
}

/** The README patterns that name none of `assetNames`. */
export function findUnmatchedPatterns(patterns, assetNames) {
    return patterns.filter((pattern) => {
        const matcher = patternToRegExp(pattern);

        return !assetNames.some((assetName) => matcher.test(assetName));
    });
}

/** The installer assets no README pattern names. */
export function findUndocumentedInstallers(patterns, assetNames) {
    const matchers = patterns.map(patternToRegExp);

    return assetNames
        .filter(isInstallerAsset)
        .filter((assetName) => !matchers.some((matcher) => matcher.test(assetName)));
}

export function verifyReadmeAssetNames({ readmeContent, assetNames }) {
    const patterns = parseReadmeAssetPatterns(readmeContent);

    // An empty pattern set would make the forward check pass over nothing, so it is refused rather
    // than reported as success. The reverse check would still fire, but "the README documents no
    // downloads at all" deserves its own message rather than a list of every installer.
    if (patterns.length === 0) {
        return {
            ok: false,
            message:
                "No asset-name patterns were found in README.md. The Installation section names each download as inline code containing a `*` in place of the version (for example `kavynex_*_x64-setup.exe`); if that section was reworded, this check has to be taught the new shape rather than left passing over nothing.",
        };
    }

    const unmatched = findUnmatchedPatterns(patterns, assetNames);
    const undocumented = findUndocumentedInstallers(patterns, assetNames);

    if (unmatched.length === 0 && undocumented.length === 0) {
        return {
            ok: true,
            message: `All ${patterns.length} download names in README.md match an asset on this release, and every installer it carries is documented.`,
        };
    }

    const problems = [];

    if (unmatched.length > 0) {
        problems.push(
            "README.md names a download this release does not carry. Its bundler's naming has probably shifted - compare against the asset list printed above, and update the README together with release.yml's asset-completeness list, which holds the same names:\n" +
                unmatched.map((pattern) => `  - ${pattern}`).join("\n")
        );
    }

    if (undocumented.length > 0) {
        problems.push(
            "This release carries an installer README.md does not mention, so nothing on the download page tells a user it exists:\n" +
                undocumented.map((assetName) => `  - ${assetName}`).join("\n")
        );
    }

    return { ok: false, message: problems.join("\n\n") };
}

// Only run the gate when invoked as a script, so the exports above stay unit-testable (importing
// this file must not read files or exit).
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"))) {
    const assetsPath = process.argv[2];

    if (!assetsPath) {
        console.error(
            "Usage: node scripts/verify-readme-asset-names.js <file with one asset name per line>"
        );
        process.exit(1);
    }

    const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const readmeContent = readFileSync(join(root, "README.md"), "utf8");
    const assetNames = readFileSync(assetsPath, "utf8")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);

    const result = verifyReadmeAssetNames({ readmeContent, assetNames });

    if (result.ok) {
        console.log(result.message);
    } else {
        console.error(result.message);
        process.exit(1);
    }
}
