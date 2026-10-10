import { readFileSync } from "fs";
import { isMainModule } from "./script-entry.js";
import { compareSemver, isValidSemver, nextVersionProblem } from "./version-utils.js";

// Refuses a release whose version is not one step past the newest published one.
//
// Releases are immutable, so a version published by mistake cannot be taken back. One that is too
// high (1.70.0 for 1.8.0) makes the updater refuse the intended one forever after, and one that is
// lower than what is out never reaches anyone. bump-version.js already checks the step against the
// version in package.json, and this checks it against what was actually published, which is what
// a hand-edited version or a skipped release would get wrong.

/** The newest X.Y.Z among published tags (`v1.7.0`), or null when there is none. */
export function newestPublishedVersion(tags) {
    return (
        tags
            .map((tag) => tag.trim().replace(/^v/, ""))
            .filter(isValidSemver)
            .sort(compareSemver)
            .at(-1) ?? null
    );
}

/** A message when `version` does not follow the newest published tag, or null when it does. */
export function findVersionAdvanceProblem(version, tags) {
    const newest = newestPublishedVersion(tags);

    if (newest === null) {
        return null;
    }

    const problem = nextVersionProblem(newest, version);

    return problem ? `${problem} (the newest published release is v${newest})` : null;
}

if (isMainModule(import.meta.url)) {
    const [tagsPath] = process.argv.slice(2);

    if (!tagsPath) {
        console.error("Usage: node scripts/verify-version-advances.js <file with one published tag per line>");
        process.exit(1);
    }

    const version = JSON.parse(readFileSync("package.json", "utf8")).version;
    const tags = readFileSync(tagsPath, "utf8").split(/\r?\n/).filter(Boolean);
    const problem = findVersionAdvanceProblem(version, tags);

    if (problem) {
        console.error(problem);
        process.exit(1);
    }

    console.log(`Version ${version} follows the newest published release.`);
}
