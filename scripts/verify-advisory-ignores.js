// CI gate. cargo-audit and cargo-deny each keep a list of the RustSec advisories this project accepts,
// `.cargo/audit.toml` and src-tauri/deny.toml. Fails when the two lists name different advisories, or
// when a workflow passes cargo-audit an `--ignore` of its own again, which is how one ignore used to
// be written out in four places.

import { readFileSync, readdirSync } from "fs";
import { resolve, join, dirname } from "path";
import { fileURLToPath } from "url";
import { isMainModule } from "./script-entry.js";

const ADVISORY_ID = /RUSTSEC-\d{4}-\d{4}/g;

// The ids in `.cargo/audit.toml`'s `ignore = [...]`, comments left out.
export function extractAuditIgnores(auditToml) {
    const code = auditToml
        .split(/\r?\n/)
        .filter((line) => !line.trim().startsWith("#"))
        .join("\n");
    const list = /^\s*ignore\s*=\s*\[([^\]]*)\]/m.exec(code);

    return list ? [...list[1].matchAll(ADVISORY_ID)].map((match) => match[0]) : [];
}

// The advisory ids in deny.toml's `ignore`, which names each as `{ id = "RUSTSEC-...", reason = ... }`.
// A crate entry (`{ crate = "spin@0.9.8", ... }`) is not an advisory and has no counterpart.
export function extractDenyIgnores(denyToml) {
    return [...denyToml.matchAll(/\bid\s*=\s*"(RUSTSEC-\d{4}-\d{4})"/g)].map((match) => match[1]);
}

// Every `--ignore RUSTSEC-...` a workflow passes on a line that is not a comment.
export function extractWorkflowIgnores(workflowContent) {
    return workflowContent
        .split(/\r?\n/)
        .filter((line) => !line.trim().startsWith("#"))
        .flatMap((line) => [...line.matchAll(/--ignore\s+(RUSTSEC-\d{4}-\d{4})/g)])
        .map((match) => match[1]);
}

export function verifyAdvisoryIgnores({ auditToml, denyToml, workflows }) {
    const audit = new Set(extractAuditIgnores(auditToml));
    const deny = new Set(extractDenyIgnores(denyToml));
    const problems = [];

    for (const id of audit) {
        if (!deny.has(id)) {
            problems.push(`${id} is ignored in .cargo/audit.toml but not in src-tauri/deny.toml`);
        }
    }

    for (const id of deny) {
        if (!audit.has(id)) {
            problems.push(`${id} is ignored in src-tauri/deny.toml but not in .cargo/audit.toml`);
        }
    }

    for (const { name, content } of workflows) {
        for (const id of extractWorkflowIgnores(content)) {
            problems.push(`${name} passes --ignore ${id}; list it in .cargo/audit.toml instead`);
        }
    }

    if (problems.length > 0) {
        return {
            ok: false,
            message:
                "The accepted RustSec advisories are listed inconsistently:\n" +
                problems.map((line) => `  - ${line}`).join("\n"),
        };
    }

    return {
        ok: true,
        message: `cargo-audit and cargo-deny ignore the same ${audit.size} advisory(ies), and no workflow adds its own.`,
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

    const result = verifyAdvisoryIgnores({
        auditToml: readFileSync(join(root, ".cargo", "audit.toml"), "utf8"),
        denyToml: readFileSync(join(root, "src-tauri", "deny.toml"), "utf8"),
        workflows,
    });

    if (result.ok) {
        console.log(result.message);
    } else {
        console.error(result.message);
        process.exit(1);
    }
}
