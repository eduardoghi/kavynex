#!/usr/bin/env node

// CI gate: fails when the Node version pinned in .nvmrc and the `node-version:` values declared in
// the GitHub workflows disagree, so a bump that touches one but not the others can never silently
// build/test against a different Node than local development uses. The app version already has
// verify-release-version.js for exactly this reason; this closes the equivalent gap for the Node
// pin, which is otherwise duplicated across .nvmrc and every workflow with only a "keep in sync"
// comment holding it together.

import { readFileSync, readdirSync } from "fs";
import { resolve, join, dirname } from "path";
import { fileURLToPath } from "url";

// Strips a leading `v` and surrounding whitespace so `v26.5.0`, `26.5.0 ` and `26.5.0` compare
// equal - setup-node and .nvmrc both accept the bare form, and this keeps a stray `v` from reading
// as a mismatch.
function normalizeVersion(value) {
    return value.trim().replace(/^v/i, "");
}

// Every `node-version:` value declared in one workflow file, in document order. A workflow that sets
// Node up in several jobs yields one entry per declaration; a workflow that never uses Node yields
// none. Comment lines are skipped so a `node-version:` mentioned in prose is not read as a real
// declaration.
export function extractNodeVersions(workflowContent) {
    const versions = [];

    for (const line of workflowContent.split(/\r?\n/)) {
        if (line.trim().startsWith("#")) {
            continue;
        }

        const match = /node-version:\s*([^\s#]+)/.exec(line);

        if (match) {
            versions.push(match[1]);
        }
    }

    return versions;
}

// Decides the node-version gate from the raw file contents, returning `{ ok, message }` rather than
// reading files or exiting itself. `workflows` is an array of `{ name, content }`. Exported so the
// glue (the empty-.nvmrc branch, the no-declaration guard, the mismatch wording) is unit-tested
// without touching the filesystem.
export function verifyNodeVersion({ nvmrc, workflows }) {
    const expected = normalizeVersion(nvmrc);

    if (!expected) {
        return { ok: false, message: ".nvmrc is empty; it must pin an exact Node version." };
    }

    const mismatches = [];
    let declarationCount = 0;

    for (const { name, content } of workflows) {
        for (const raw of extractNodeVersions(content)) {
            declarationCount += 1;

            if (normalizeVersion(raw) !== expected) {
                mismatches.push(`${name}: node-version ${raw} does not match .nvmrc (${expected})`);
            }
        }
    }

    if (mismatches.length > 0) {
        return {
            ok: false,
            message:
                `Node version is inconsistent. Align every workflow's node-version with .nvmrc (${expected}):\n` +
                mismatches.map((line) => `  - ${line}`).join("\n"),
        };
    }

    // A zero count means either no workflow uses Node (not true for this repo) or the key was renamed
    // and the scan now matches nothing - which would let the gate pass vacuously. Fail instead, so the
    // check cannot silently stop verifying anything.
    if (declarationCount === 0) {
        return {
            ok: false,
            message:
                "No node-version declaration was found in any workflow; expected at least one pinned to .nvmrc.",
        };
    }

    return {
        ok: true,
        message: `Node version ${expected} is consistent across .nvmrc and ${declarationCount} workflow declaration(s).`,
    };
}

// Only run the gate when invoked as a script, so the exports above stay unit-testable (importing this
// file must not read files or exit).
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"))) {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const workflowsDir = join(root, ".github", "workflows");

    const workflows = readdirSync(workflowsDir)
        .filter((file) => file.endsWith(".yml") || file.endsWith(".yaml"))
        .map((file) => ({
            name: `.github/workflows/${file}`,
            content: readFileSync(join(workflowsDir, file), "utf8"),
        }));

    const result = verifyNodeVersion({
        nvmrc: readFileSync(join(root, ".nvmrc"), "utf8"),
        workflows,
    });

    if (result.ok) {
        console.log(result.message);
    } else {
        console.error(result.message);
        process.exit(1);
    }
}
