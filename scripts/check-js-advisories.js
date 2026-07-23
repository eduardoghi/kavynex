// Fails when an npm dependency carries a known high/critical security advisory.
//
// This replaces `pnpm audit`, which stopped working entirely on 2026-07-15: npm retired the
// legacy audit endpoints (`/-/npm/v1/security/audits` and `/-/npm/v1/security/audits/quick`) and
// every pnpm release still calls them, so `pnpm audit` now exits non-zero with
// ERR_PNPM_AUDIT_BAD_RESPONSE (HTTP 410) regardless of whether any advisory exists. Verified
// against pnpm 10.34.5 and 11.13.0 (the latest at the time of writing) - upgrading pnpm does not
// fix it, so the gate had to move off that command rather than wait.
//
// Data comes from OSV (osv.dev), Google's aggregator of the same GitHub Advisory data npm audit
// reports, queried over its public batch API. That is the source `osv-scanner` itself wraps; this
// queries it directly rather than adding the scanner because it is a Go binary with no npm
// package, which would mean a new third-party Action in a workflow that deliberately pins
// everything by commit SHA. A ~90-line script with no dependency is less supply-chain surface
// than either, and it mirrors scripts/check-js-licenses.js, which already resolves its inventory
// from pnpm for the same reason.
//
// Usage:
//     node scripts/check-js-advisories.js            # production tree (CI gates on this)
//     node scripts/check-js-advisories.js --dev      # dev tree (CI reports, does not gate)

import { execFileSync } from "node:child_process";

const OSV_QUERY_BATCH_URL = "https://api.osv.dev/v1/querybatch";
const OSV_VULN_URL = "https://api.osv.dev/v1/vulns";

// Mirrors the `--audit-level high` the retired `pnpm audit` gate used: a low/moderate transitive
// finding should not block every push, and it never shipped in a release artifact anyway.
const BLOCKING_SEVERITIES = new Set(["HIGH", "CRITICAL"]);

// OSV's batch endpoint accepts many queries per call; keep batches modest so one failure retries
// cheaply and the request stays well inside any body limit.
const QUERY_BATCH_SIZE = 100;

// Bound each OSV request. Without this a stalled endpoint - a TCP/TLS hang rather than a quick
// error - would hold the read open until the CI job's own timeout (tens of minutes) killed it,
// failing the whole run for a reason unrelated to the code under review. A slow network still gets
// generous room; only a genuine stall trips it, and it fails fast with a message that names the
// outage rather than looking like an advisory was found.
const OSV_REQUEST_TIMEOUT_MS = 15_000;

function readInstalledPackages(scope) {
    // `shell` is needed only on Windows, where pnpm is a `.cmd` shim and Node refuses to spawn
    // `.bat`/`.cmd` without one (CVE-2024-27980); CI runs on Linux and takes the shell-free path.
    //
    // Note what the argv array does and does not buy on that Windows path: with `shell: true` Node
    // concatenates the array into a command line rather than passing it through, which is what
    // DEP0190 warns about - the array is not an escaping mechanism there. What actually makes this
    // safe is that every argument below is a literal written in this file; none is derived from a
    // package name, a lockfile entry, or anything else outside it. Keep it that way: an argument
    // built from external data would need the shim resolved and invoked directly instead.
    //
    // `licenses list` is what enumerates the tree, as in check-js-licenses.js: it returns a flat,
    // fully-resolved inventory of name+versions straight from the lockfile. `pnpm list` returns a
    // nested tree whose repeated subtrees are elided as `deduped`, which a scanner must not miss.
    const raw = execFileSync("pnpm", ["licenses", "list", scope, "--json"], {
        encoding: "utf-8",
        shell: process.platform === "win32",
        maxBuffer: 32 * 1024 * 1024,
    });

    // Shape: { "<license expression>": [{ name, versions: ["1.2.3", ...], ... }, ...], ... }
    return collectPackages(JSON.parse(raw));
}

// Flattens pnpm's `licenses list` shape into a de-duplicated list of { name, version }. Exported
// so the parsing the scan's coverage depends on (a package the scanner never lists is a package it
// never checks) is unit-tested without shelling out to pnpm. See check-js-advisories.test.js.
export function collectPackages(byLicense) {
    const packages = new Map();

    for (const entries of Object.values(byLicense)) {
        for (const entry of entries) {
            for (const version of entry.versions ?? []) {
                packages.set(`${entry.name}@${version}`, { name: entry.name, version });
            }
        }
    }

    return [...packages.values()];
}

// Splits `items` into consecutive chunks of at most `size`. OSV's batch endpoint caps how many
// queries it accepts per call, so the query set is paginated through this. Exported so the
// batching (a bug here would silently skip whole pages of packages) is unit-tested.
export function chunk(items, size) {
    const batches = [];

    for (let start = 0; start < items.length; start += size) {
        batches.push(items.slice(start, start + size));
    }

    return batches;
}

// `fetch` under a per-request deadline. On a timeout, `fetch` rejects with a `TimeoutError`
// DOMException; it is remapped to a plain Error that names the outage, so the gate's failure reads
// as "osv.dev unreachable" rather than being mistaken for an advisory.
async function fetchWithTimeout(url, options) {
    try {
        return await fetch(url, {
            ...options,
            signal: AbortSignal.timeout(OSV_REQUEST_TIMEOUT_MS),
        });
    } catch (error) {
        if (error instanceof Error && error.name === "TimeoutError") {
            throw new Error(
                `${url} did not respond within ${OSV_REQUEST_TIMEOUT_MS} ms; ` +
                    "osv.dev appears unreachable (this is a network/service failure, not an advisory)",
                { cause: error }
            );
        }

        throw error;
    }
}

async function postJson(url, body) {
    const response = await fetchWithTimeout(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
    });

    if (!response.ok) {
        throw new Error(`${url} responded with ${response.status}`);
    }

    return await response.json();
}

async function getJson(url) {
    const response = await fetchWithTimeout(url);

    if (!response.ok) {
        throw new Error(`${url} responded with ${response.status}`);
    }

    return await response.json();
}

// Returns a map of vulnerability id -> the packages it affects.
async function findVulnerabilityIds(packages) {
    const affectedBy = new Map();

    for (const batch of chunk(packages, QUERY_BATCH_SIZE)) {
        const payload = {
            queries: batch.map((pkg) => ({
                package: { name: pkg.name, ecosystem: "npm" },
                version: pkg.version,
            })),
        };

        const { results = [] } = await postJson(OSV_QUERY_BATCH_URL, payload);

        results.forEach((result, index) => {
            const pkg = batch[index];

            for (const vuln of result?.vulns ?? []) {
                if (!affectedBy.has(vuln.id)) {
                    affectedBy.set(vuln.id, new Set());
                }

                affectedBy.get(vuln.id).add(`${pkg.name}@${pkg.version}`);
            }
        });
    }

    return affectedBy;
}

// CVSS 3.x base-metric weights (CVSS v3.1 specification, section 7.4). Used to derive a severity
// band when an advisory carries only a CVSS vector and no database_specific.severity label.
const CVSS3_WEIGHTS = {
    AV: { N: 0.85, A: 0.62, L: 0.55, P: 0.2 },
    AC: { L: 0.77, H: 0.44 },
    UI: { N: 0.85, R: 0.62 },
    CIA: { N: 0, L: 0.22, H: 0.56 },
    PR_UNCHANGED: { N: 0.85, L: 0.62, H: 0.27 },
    PR_CHANGED: { N: 0.85, L: 0.68, H: 0.5 },
};

// CVSS 3.1 "roundup": round up to one decimal place without floating-point drift (spec appendix A).
function roundUpToOneDecimal(value) {
    const scaled = Math.round(value * 100000);

    if (scaled % 10000 === 0) {
        return scaled / 100000;
    }

    return (Math.floor(scaled / 10000) + 1) / 10;
}

// Computes the CVSS 3.x base score from a vector string, or null when it is not a well-formed
// CVSS:3.x base vector (a v2/v4 vector, a missing metric, an unknown metric value). Returning null
// rather than guessing is deliberate: the caller then falls back to fail-closed "unknown" instead
// of silently treating an unparseable vector as harmless. Exported for tests.
export function cvss3BaseScore(vector) {
    if (typeof vector !== "string" || !/^CVSS:3\.[01]\//.test(vector)) {
        return null;
    }

    const metrics = {};

    for (const part of vector.split("/").slice(1)) {
        const [key, value] = part.split(":");

        if (key && value) {
            metrics[key] = value;
        }
    }

    const scopeChanged = metrics.S === "C";
    const prWeights = scopeChanged ? CVSS3_WEIGHTS.PR_CHANGED : CVSS3_WEIGHTS.PR_UNCHANGED;
    const av = CVSS3_WEIGHTS.AV[metrics.AV];
    const ac = CVSS3_WEIGHTS.AC[metrics.AC];
    const ui = CVSS3_WEIGHTS.UI[metrics.UI];
    const pr = prWeights[metrics.PR];
    const conf = CVSS3_WEIGHTS.CIA[metrics.C];
    const integ = CVSS3_WEIGHTS.CIA[metrics.I];
    const avail = CVSS3_WEIGHTS.CIA[metrics.A];

    if ([av, ac, ui, pr, conf, integ, avail].some((weight) => weight === undefined)) {
        return null;
    }

    const iss = 1 - (1 - conf) * (1 - integ) * (1 - avail);
    const impact = scopeChanged
        ? 7.52 * (iss - 0.029) - 3.25 * Math.pow(iss - 0.02, 15)
        : 6.42 * iss;

    if (impact <= 0) {
        return 0;
    }

    const exploitability = 8.22 * av * ac * pr * ui;
    const combined = scopeChanged ? 1.08 * (impact + exploitability) : impact + exploitability;

    return roundUpToOneDecimal(Math.min(combined, 10));
}

// Maps a CVSS base score to the GHSA/OSV severity band this gate reasons about (GHSA uses MODERATE,
// not CVSS's "MEDIUM"). Exported for tests.
export function severityFromCvssScore(score) {
    if (score >= 9.0) {
        return "CRITICAL";
    }

    if (score >= 7.0) {
        return "HIGH";
    }

    if (score >= 4.0) {
        return "MODERATE";
    }

    if (score > 0) {
        return "LOW";
    }

    return "NONE";
}

// Derives a severity from the top-level OSV `severity` array (CVSS vectors), which some advisories
// populate instead of database_specific.severity. Returns null when none is a parseable CVSS:3.x
// vector.
function severityFromCvssVectors(severities) {
    if (!Array.isArray(severities)) {
        return null;
    }

    for (const entry of severities) {
        const score = cvss3BaseScore(entry?.score);

        if (score !== null) {
            return severityFromCvssScore(score);
        }
    }

    return null;
}

// The batch endpoint returns ids only, so severity needs one lookup per advisory. There are
// normally none; a handful at most. Prefers the database_specific.severity label GHSA-sourced
// advisories carry, and falls back to the CVSS vector in the top-level `severity` array for any that
// omit it - so a high/critical finding published without the label is still classified, not silently
// treated as unknown. Exported for tests.
export function severityOf(vuln) {
    const declared = vuln.database_specific?.severity;

    if (typeof declared === "string" && declared.trim()) {
        return declared.trim().toUpperCase();
    }

    return severityFromCvssVectors(vuln.severity) ?? "UNKNOWN";
}

// Whether an advisory should fail the gate. The withdrawn filter, the severity floor, and the
// fail-closed handling of an undeterminable severity are the whole gate decision, so they are
// extracted here and unit-tested rather than living only inside main()'s network loop, where the
// current tree (normally zero advisories) never exercises them. See check-js-advisories.test.js.
export function isBlockingAdvisory(vuln) {
    if (vuln.withdrawn) {
        return false;
    }

    const severity = severityOf(vuln);

    if (BLOCKING_SEVERITIES.has(severity)) {
        return true;
    }

    // Fail closed: a live advisory whose severity could not be established (no database_specific
    // label and no parseable CVSS vector) is not proven to be below the high/critical floor, so it
    // must not pass silently - that is the whole point of this gate, which states the same
    // fail-closed rule for a transport failure below. It surfaces for a human to classify in the PR
    // rather than being treated as cleared; a severity we did resolve to low/moderate/none does not
    // block.
    return severity === "UNKNOWN";
}

async function main() {
    const scope = process.argv.includes("--dev") ? "--dev" : "--prod";
    const label = scope === "--dev" ? "development" : "production";
    const packages = readInstalledPackages(scope);
    const affectedBy = await findVulnerabilityIds(packages);
    const blocking = [];

    for (const [id, affected] of affectedBy) {
        const vuln = await getJson(`${OSV_VULN_URL}/${encodeURIComponent(id)}`);

        // A withdrawn advisory is skipped and anything below high/critical does not gate; both live
        // in isBlockingAdvisory so the decision is testable without the network.
        if (!isBlockingAdvisory(vuln)) {
            continue;
        }

        blocking.push(
            `${severityOf(vuln)} ${id} - ${[...affected].sort().join(", ")}\n` +
                `    ${vuln.summary ?? "(no summary)"}\n` +
                `    https://osv.dev/vulnerability/${id}`
        );
    }

    if (blocking.length > 0) {
        console.error(
            `${blocking.length} high/critical (or unclassifiable) advisory(ies) in the ${label} ` +
                `tree (${packages.length} packages scanned):\n\n` +
                blocking.map((line) => `  ${line}`).join("\n\n") +
                "\n\nUpgrade the affected package(s). An advisory whose severity could not be" +
                " determined is listed as UNKNOWN and blocks by design (fail closed), rather than" +
                " passing silently. If a finding does not apply here, it must be argued in the PR" +
                " rather than silenced - there is no ignore-list by design."
        );
        process.exit(1);
    }

    console.log(
        `No high/critical advisories in the ${label} tree ` +
            `(${packages.length} packages scanned against osv.dev, ` +
            `${affectedBy.size} lower-severity/withdrawn advisory record(s) reviewed).`
    );
}

// Only run the gate when invoked as a script, so the exports above stay unit-testable (importing
// this file must not shell out to pnpm or reach the network). Mirrors check-js-licenses.js.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"))) {
    main().catch((error) => {
        // Never pass silently on a transport failure: a scanner that cannot reach its data source
        // has not cleared the tree, and treating that as success is how a gate quietly stops gating.
        console.error(`Advisory check could not complete: ${error.message}`);
        process.exit(1);
    });
}
