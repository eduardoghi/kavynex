// Side-effect-free helpers shared by the version scripts (bump-version, verify-release-version).
// Extracted so the release-gate logic - the Cargo.toml regex especially - can be unit-tested
// instead of only ever running at release time, where a bad regex would silently pass.

// Matches the [package] version line in Cargo.toml: a full X.Y.Z semver at the start of a line.
// Anchored with ^ (multiline) so it never matches a dependency's `version = "..."` further down.
export const CARGO_PACKAGE_VERSION_REGEX = /^version = "(\d+\.\d+\.\d+)"/m;

/** Extracts the [package] version from Cargo.toml text, or null when the line is absent. */
export function parseCargoVersion(cargoToml) {
    const match = cargoToml.match(CARGO_PACKAGE_VERSION_REGEX);
    return match ? match[1] : null;
}

/**
 * Returns Cargo.toml text with the [package] version replaced, or null when there is no
 * version line to replace (so the caller can fail loudly instead of writing an unchanged file).
 */
export function replaceCargoVersion(cargoToml, newVersion) {
    if (!CARGO_PACKAGE_VERSION_REGEX.test(cargoToml)) {
        return null;
    }

    return cargoToml.replace(CARGO_PACKAGE_VERSION_REGEX, `version = "${newVersion}"`);
}

/** Whether a string is a strict X.Y.Z semver (no pre-release or build metadata). */
export function isValidSemver(version) {
    return /^\d+\.\d+\.\d+$/.test(version);
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
