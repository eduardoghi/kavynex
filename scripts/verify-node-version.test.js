import { describe, expect, it } from "vitest";
import { verifyNodeVersion, extractNodeVersions } from "./verify-node-version.js";

// A minimal workflow body declaring Node once per version passed, mirroring the real
// `with: node-version: <x>` shape the scanner reads.
const workflow = (name, ...versions) => ({
    name,
    content: versions
        .map(
            (version) =>
                `        - name: Setup Node.js\n          uses: actions/setup-node@x\n          with:\n              node-version: ${version}\n              cache: pnpm\n`
        )
        .join("\n"),
});

describe("extractNodeVersions", () => {
    it("returns every node-version declaration in order", () => {
        const content = workflow("ci.yml", "26.5.0", "26.5.0").content;
        expect(extractNodeVersions(content)).toEqual(["26.5.0", "26.5.0"]);
    });

    it("returns nothing for a workflow that never sets up Node", () => {
        expect(extractNodeVersions("jobs:\n  build:\n    runs-on: ubuntu-22.04\n")).toEqual([]);
    });

    it("ignores a node-version mentioned in a comment line", () => {
        const content = "        # node-version: 20 was the old pin\n              node-version: 26.5.0\n";
        expect(extractNodeVersions(content)).toEqual(["26.5.0"]);
    });
});

describe("verifyNodeVersion", () => {
    it("passes when .nvmrc matches every workflow declaration", () => {
        const result = verifyNodeVersion({
            nvmrc: "26.5.0\n",
            workflows: [workflow("ci.yml", "26.5.0", "26.5.0"), workflow("release.yml", "26.5.0")],
        });

        expect(result.ok).toBe(true);
        expect(result.message).toContain("26.5.0");
        // Counts every declaration across the workflows (two in ci.yml, one in release.yml).
        expect(result.message).toContain("3 workflow declaration(s)");
    });

    it("fails and names the offending workflow when a version drifts", () => {
        const result = verifyNodeVersion({
            nvmrc: "26.5.0\n",
            workflows: [workflow("ci.yml", "26.5.0"), workflow("mutation.yml", "26.4.0")],
        });

        expect(result.ok).toBe(false);
        expect(result.message).toContain("mutation.yml");
        expect(result.message).toContain("26.4.0");
        // Points the reader back at .nvmrc as the source to align to.
        expect(result.message).toContain(".nvmrc (26.5.0)");
    });

    it("normalizes a leading v and surrounding whitespace on both sides", () => {
        const result = verifyNodeVersion({
            nvmrc: " v26.5.0 \n",
            workflows: [workflow("ci.yml", "26.5.0")],
        });

        expect(result.ok).toBe(true);
    });

    it("fails when no workflow declares a node-version (guards a vacuous pass)", () => {
        const result = verifyNodeVersion({
            nvmrc: "26.5.0\n",
            workflows: [{ name: "ci.yml", content: "jobs:\n  build:\n    runs-on: ubuntu-22.04\n" }],
        });

        expect(result.ok).toBe(false);
        expect(result.message).toContain("No node-version declaration");
    });

    it("fails when .nvmrc is empty", () => {
        const result = verifyNodeVersion({
            nvmrc: "   \n",
            workflows: [workflow("ci.yml", "26.5.0")],
        });

        expect(result.ok).toBe(false);
        expect(result.message).toContain(".nvmrc is empty");
    });
});
