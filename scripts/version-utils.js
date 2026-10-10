// Side-effect-free helpers shared by the version scripts (bump-version, verify-release-version).
// Extracted so the release-gate logic (the Cargo.toml regex especially) can be unit-tested
// instead of only ever running at release time, where a bad regex would silently pass.

// Matches the [package] version line in Cargo.toml, scoped to the [package] table. The `[package]`
// header, then any lines up to (but not crossing into) the next `[section]` header via `[^[]*?`,
// then the `version = "X.Y.Z"` line. Scoping it to that table (rather than a bare `^version`
// anywhere) is what stops it reading or rewriting a dependency's own version line, including a
// `[dependencies.foo]` sub-table that puts one at the start of a line above or below [package]. The
// old bare-`^version` form only worked because [package] happens to be the first table; a reorder
// would have silently made it target the wrong line. The three capture groups let
// replaceCargoVersion swap only the version while preserving the [package] prefix and closing quote.
export const CARGO_PACKAGE_VERSION_REGEX = /(^\[package\][^[]*?^version = ")(\d+\.\d+\.\d+)(")/m;

/** Extracts the [package] version from Cargo.toml text, or null when the line is absent. */
export function parseCargoVersion(cargoToml) {
    const match = cargoToml.match(CARGO_PACKAGE_VERSION_REGEX);
    return match ? match[2] : null;
}

/**
 * Returns Cargo.toml text with the [package] version replaced, or null when there is no
 * version line to replace (so the caller can fail loudly instead of writing an unchanged file).
 */
export function replaceCargoVersion(cargoToml, newVersion) {
    if (!CARGO_PACKAGE_VERSION_REGEX.test(cargoToml)) {
        return null;
    }

    return cargoToml.replace(CARGO_PACKAGE_VERSION_REGEX, `$1${newVersion}$3`);
}

/** Whether a string is a strict X.Y.Z semver (no pre-release or build metadata). */
export function isValidSemver(version) {
    return /^\d+\.\d+\.\d+$/.test(version);
}

/** Negative, zero or positive as `left` is older than, equal to or newer than `right` (X.Y.Z). */
export function compareSemver(left, right) {
    const a = left.split(".").map(Number);
    const b = right.split(".").map(Number);

    for (let index = 0; index < 3; index += 1) {
        if (a[index] !== b[index]) {
            return a[index] - b[index];
        }
    }

    return 0;
}

/**
 * The versions a release may follow `current` with. One step on one component, the rest reset, so a
 * typo like 1.70.0 for 1.8.0 is caught before it is published. Releases are immutable, and once a
 * version that high is out the updater never offers the one that was meant.
 */
export function allowedNextVersions(current) {
    const [major, minor, patch] = current.split(".").map(Number);

    return [`${major}.${minor}.${patch + 1}`, `${major}.${minor + 1}.0`, `${major + 1}.0.0`];
}

/** A message when `next` is not one of `allowedNextVersions(current)`, or null when it is. */
export function nextVersionProblem(current, next) {
    const allowed = allowedNextVersions(current);

    if (allowed.includes(next)) {
        return null;
    }

    return `Version ${next} does not follow ${current}. Expected one of ${allowed.join(", ")}.`;
}

/**
 * Moves what `## [Unreleased]` holds under a new `## [version] (date)` heading, leaving an empty
 * Unreleased section above it. Returns null when there is no Unreleased heading, and `{ empty: true }`
 * when it holds nothing, which a release has no reason to have.
 */
export function rotateChangelog(changelog, version, date) {
    const newline = changelog.includes("\r\n") ? "\r\n" : "\n";
    const lines = changelog.split(newline);
    const heading = lines.findIndex((line) => line.trim() === "## [Unreleased]");

    if (heading === -1) {
        return null;
    }

    const next = lines.findIndex((line, index) => index > heading && line.startsWith("## ["));
    const body = lines.slice(heading + 1, next === -1 ? lines.length : next);

    if (body.every((line) => line.trim() === "")) {
        return { empty: true };
    }

    lines.splice(heading + 1, 0, "", `## [${version}] (${date})`);

    return { empty: false, text: lines.join(newline) };
}

/**
 * Returns a human-readable message when the three version sources disagree, or null when they
 * are consistent. Pure, so the release gate's core decision is testable in isolation.
 */
export function findVersionMismatch({ packageVersion, tauriVersion, cargoVersion }) {
    if (packageVersion !== tauriVersion || packageVersion !== cargoVersion) {
        return (
            `Version mismatch: package.json=${packageVersion}, ` +
            `tauri.conf.json=${tauriVersion}, Cargo.toml=${cargoVersion}.`
        );
    }

    return null;
}
