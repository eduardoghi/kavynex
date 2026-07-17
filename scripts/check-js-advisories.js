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
    const byLicense = JSON.parse(raw);
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

async function postJson(url, body) {
    const response = await fetch(url, {
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
    const response = await fetch(url);

    if (!response.ok) {
        throw new Error(`${url} responded with ${response.status}`);
    }

    return await response.json();
}

// Returns a map of vulnerability id -> the packages it affects.
async function findVulnerabilityIds(packages) {
    const affectedBy = new Map();

    for (let start = 0; start < packages.length; start += QUERY_BATCH_SIZE) {
        const batch = packages.slice(start, start + QUERY_BATCH_SIZE);
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

// The batch endpoint returns ids only, so severity needs one lookup per advisory. There are
// normally none; a handful at most.
function severityOf(vuln) {
    const declared = vuln.database_specific?.severity;

    if (typeof declared === "string") {
        return declared.toUpperCase();
    }

    return "UNKNOWN";
}

async function main() {
    const scope = process.argv.includes("--dev") ? "--dev" : "--prod";
    const label = scope === "--dev" ? "development" : "production";
    const packages = readInstalledPackages(scope);
    const affectedBy = await findVulnerabilityIds(packages);
    const blocking = [];

    for (const [id, affected] of affectedBy) {
        const vuln = await getJson(`${OSV_VULN_URL}/${encodeURIComponent(id)}`);

        // A withdrawn advisory was retracted by its publisher; it is not a finding.
        if (vuln.withdrawn) {
            continue;
        }

        const severity = severityOf(vuln);

        if (!BLOCKING_SEVERITIES.has(severity)) {
            continue;
        }

        blocking.push(
            `${severity} ${id} - ${[...affected].sort().join(", ")}\n` +
                `    ${vuln.summary ?? "(no summary)"}\n` +
                `    https://osv.dev/vulnerability/${id}`
        );
    }

    if (blocking.length > 0) {
        console.error(
            `${blocking.length} high/critical advisory(ies) in the ${label} tree ` +
                `(${packages.length} packages scanned):\n\n` +
                blocking.map((line) => `  ${line}`).join("\n\n") +
                "\n\nUpgrade the affected package(s). If a finding does not apply here, it must be" +
                " argued in the PR rather than silenced - there is no ignore-list by design."
        );
        process.exit(1);
    }

    console.log(
        `No high/critical advisories in the ${label} tree ` +
            `(${packages.length} packages scanned against osv.dev, ` +
            `${affectedBy.size} lower-severity/withdrawn advisory record(s) reviewed).`
    );
}

main().catch((error) => {
    // Never pass silently on a transport failure: a scanner that cannot reach its data source has
    // not cleared the tree, and treating that as success is how a gate quietly stops gating.
    console.error(`Advisory check could not complete: ${error.message}`);
    process.exit(1);
});
