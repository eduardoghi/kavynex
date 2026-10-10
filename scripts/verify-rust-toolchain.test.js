import { describe, expect, it } from "vitest";
import {
    extractCargoInstalls,
    extractToolchainChannel,
    extractToolchainInputs,
    verifyRustToolchain,
} from "./verify-rust-toolchain.js";

const TOML = '[toolchain]\nchannel = "1.99.0"\ncomponents = ["rustfmt", "clippy"]\n';

function workflow(name, { toolchains = [], installs = [] } = {}) {
    const steps = [
        ...toolchains.map(
            (version) =>
                `            - uses: dtolnay/rust-toolchain@x\n              with:\n                  toolchain: ${version}\n`
        ),
        ...installs.map((spec) => `            - run: cargo install ${spec} --locked\n`),
    ];

    return { name, content: steps.join("\n") };
}

describe("extractors", () => {
    it("reads the channel out of rust-toolchain.toml", () => {
        expect(extractToolchainChannel(TOML)).toBe("1.99.0");
        expect(extractToolchainChannel("[toolchain]\n")).toBe("");
    });

    it("reads toolchain inputs and skips comments", () => {
        const content = "    # toolchain: 1.80.0 was the old pin\n                  toolchain: 1.99.0\n";
        expect(extractToolchainInputs(content)).toEqual(["1.99.0"]);
    });

    it("reads every pinned cargo install", () => {
        const content = workflow("ci.yml", { installs: ["cargo-audit@0.22.2", "cargo-deny@0.20.2"] })
            .content;
        expect(extractCargoInstalls(content)).toEqual([
            { tool: "cargo-audit", version: "0.22.2" },
            { tool: "cargo-deny", version: "0.20.2" },
        ]);
    });
});

describe("verifyRustToolchain", () => {
    it("passes when every pin agrees", () => {
        const result = verifyRustToolchain({
            toolchainToml: TOML,
            workflows: [
                workflow("ci.yml", { toolchains: ["1.99.0"], installs: ["cargo-deny@0.20.2"] }),
                workflow("release.yml", { toolchains: ["1.99.0"], installs: ["cargo-deny@0.20.2"] }),
            ],
        });

        expect(result.ok).toBe(true);
    });

    it("fails on a workflow toolchain that drifted from rust-toolchain.toml", () => {
        const result = verifyRustToolchain({
            toolchainToml: TOML,
            workflows: [workflow("mutation.yml", { toolchains: ["1.98.0"] })],
        });

        expect(result.ok).toBe(false);
        expect(result.message).toContain("mutation.yml: toolchain 1.98.0");
    });

    it("fails on one tool installed at two versions", () => {
        const result = verifyRustToolchain({
            toolchainToml: TOML,
            workflows: [
                workflow("ci.yml", { toolchains: ["1.99.0"], installs: ["cargo-audit@0.22.2"] }),
                workflow("scheduled-audit.yml", { installs: ["cargo-audit@0.21.0"] }),
            ],
        });

        expect(result.ok).toBe(false);
        expect(result.message).toContain("cargo-audit is installed at more than one version");
        expect(result.message).toContain("scheduled-audit.yml");
    });

    it("fails instead of passing vacuously when no toolchain input is found", () => {
        const result = verifyRustToolchain({ toolchainToml: TOML, workflows: [workflow("a.yml")] });

        expect(result.ok).toBe(false);
    });

    it("fails when rust-toolchain.toml pins no channel", () => {
        const result = verifyRustToolchain({ toolchainToml: "[toolchain]\n", workflows: [] });

        expect(result.ok).toBe(false);
    });
});
