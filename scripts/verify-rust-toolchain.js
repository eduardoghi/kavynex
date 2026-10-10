// CI gate. Fails when the Rust toolchain pinned in rust-toolchain.toml and the `toolchain:` values the
// workflows hand to dtolnay/rust-toolchain disagree, or when one cargo tool is installed at two
// different versions across the workflows. The toolchain was written out in nine places and each
// tool pin (cargo-audit, cargo-deny, cargo-mutants and the rest) in up to three, held together by
// "keep in sync" comments, which is the same gap verify-node-version.js closes for Node.

import { readFileSync, readdirSync } from "fs";
import { resolve, join, dirname } from "path";
import { fileURLToPath } from "url";
import { isMainModule } from "./script-entry.js";

// The `channel` rust-toolchain.toml pins, or "" when the file has none.
export function extractToolchainChannel(tomlContent) {
    const match = /^\s*channel\s*=\s*"([^"]+)"/m.exec(tomlContent);
    return match ? match[1].trim() : "";
}

function codeLines(workflowContent) {
    return workflowContent.split(/\r?\n/).filter((line) => !line.trim().startsWith("#"));
}

// Every `toolchain:` input in one workflow, in document order. Comment lines are skipped so a
// version mentioned in prose is not read as a declaration.
export function extractToolchainInputs(workflowContent) {
    const versions = [];

    for (const line of codeLines(workflowContent)) {
        const match = /^\s*toolchain:\s*([^\s#]+)/.exec(line);

        if (match) {
            versions.push(match[1]);
        }
    }

    return versions;
}

// Every `cargo install <tool>@<version>` in one workflow, as `{ tool, version }`.
export function extractCargoInstalls(workflowContent) {
    const installs = [];

    for (const line of codeLines(workflowContent)) {
        for (const match of line.matchAll(/cargo install\s+([A-Za-z0-9_-]+)@([0-9][^\s]*)/g)) {
            installs.push({ tool: match[1], version: match[2] });
        }
    }

    return installs;
}

// Decides the gate from raw file contents. `workflows` is an array of `{ name, content }`.
export function verifyRustToolchain({ toolchainToml, workflows }) {
    const expected = extractToolchainChannel(toolchainToml);

    if (!expected) {
        return {
            ok: false,
            message: "rust-toolchain.toml pins no channel; it must name an exact toolchain.",
        };
    }

    const problems = [];
    let toolchainCount = 0;
    const toolVersions = new Map();

    for (const { name, content } of workflows) {
        for (const version of extractToolchainInputs(content)) {
            toolchainCount += 1;

            if (version !== expected) {
                problems.push(
                    `${name}: toolchain ${version} does not match rust-toolchain.toml (${expected})`
                );
            }
        }

        for (const { tool, version } of extractCargoInstalls(content)) {
            const seen = toolVersions.get(tool) ?? new Map();
            const files = seen.get(version) ?? [];
            files.push(name);
            seen.set(version, files);
            toolVersions.set(tool, seen);
        }
    }

    for (const [tool, versions] of toolVersions) {
        if (versions.size > 1) {
            const listed = [...versions]
                .map(([version, files]) => `${version} (${[...new Set(files)].join(", ")})`)
                .join(" vs ");
            problems.push(`${tool} is installed at more than one version: ${listed}`);
        }
    }

    if (problems.length > 0) {
        return {
            ok: false,
            message:
                "Rust tooling is pinned inconsistently:\n" +
                problems.map((line) => `  - ${line}`).join("\n"),
        };
    }

    // Zero matches means the input was renamed or the scan broke, and the gate would pass vacuously.
    if (toolchainCount === 0) {
        return {
            ok: false,
            message:
                "No `toolchain:` input was found in any workflow; expected at least one pinned to rust-toolchain.toml.",
        };
    }

    return {
        ok: true,
        message: `Rust ${expected} is consistent across rust-toolchain.toml and ${toolchainCount} workflow declaration(s), and each of ${toolVersions.size} cargo tool(s) is installed at one version.`,
    };
}

if (isMainModule(import.meta.url)) {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const workflowsDir = join(root, ".github", "workflows");

    const workflows = readdirSync(workflowsDir)
        .filter((file) => file.endsWith(".yml") || file.endsWith(".yaml"))
        .map((file) => ({
            name: `.github/workflows/${file}`,
            content: readFileSync(join(workflowsDir, file), "utf8"),
        }));

    const result = verifyRustToolchain({
        toolchainToml: readFileSync(join(root, "rust-toolchain.toml"), "utf8"),
        workflows,
    });

    if (result.ok) {
        console.log(result.message);
    } else {
        console.error(result.message);
        process.exit(1);
    }
}
