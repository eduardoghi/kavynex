import { describe, expect, it } from "vitest";
import {
    extractAuditIgnores,
    extractDenyIgnores,
    extractWorkflowIgnores,
    verifyAdvisoryIgnores,
} from "./verify-advisory-ignores.js";

const AUDIT = '# RUSTSEC-2000-0001 in a comment\n[advisories]\nignore = ["RUSTSEC-2024-0429"]\n';
const DENY = `ignore = [
    { id = "RUSTSEC-2024-0429", reason = "glib unsound" },
    { crate = "spin@0.9.8", reason = "yanked" },
]
`;

describe("extractors", () => {
    it("reads the ids each tool ignores and nothing from comments or crate entries", () => {
        expect(extractAuditIgnores(AUDIT)).toEqual(["RUSTSEC-2024-0429"]);
        expect(extractDenyIgnores(DENY)).toEqual(["RUSTSEC-2024-0429"]);
    });

    it("reads a workflow's own --ignore and skips comment lines", () => {
        const content =
            "            # was: --ignore RUSTSEC-2000-0001\n" +
            "                  cargo audit --deny unsound --ignore RUSTSEC-2024-0429\n";

        expect(extractWorkflowIgnores(content)).toEqual(["RUSTSEC-2024-0429"]);
    });
});

describe("verifyAdvisoryIgnores", () => {
    const clean = { name: "ci.yml", content: "cargo audit --file src-tauri/Cargo.lock\n" };

    it("passes when both tools ignore the same advisories and no workflow adds one", () => {
        expect(verifyAdvisoryIgnores({ auditToml: AUDIT, denyToml: DENY, workflows: [clean] }).ok).toBe(
            true
        );
    });

    it("fails when one tool ignores an advisory the other does not", () => {
        const result = verifyAdvisoryIgnores({
            auditToml: '[advisories]\nignore = ["RUSTSEC-2024-0429", "RUSTSEC-2025-0001"]\n',
            denyToml: DENY,
            workflows: [clean],
        });

        expect(result.ok).toBe(false);
        expect(result.message).toContain("RUSTSEC-2025-0001 is ignored in .cargo/audit.toml");
    });

    it("fails when a workflow passes its own --ignore again", () => {
        const result = verifyAdvisoryIgnores({
            auditToml: AUDIT,
            denyToml: DENY,
            workflows: [{ name: "release.yml", content: "cargo audit --ignore RUSTSEC-2024-0429\n" }],
        });

        expect(result.ok).toBe(false);
        expect(result.message).toContain("release.yml passes --ignore RUSTSEC-2024-0429");
    });
});
