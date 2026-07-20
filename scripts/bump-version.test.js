import { describe, expect, it, vi } from "vitest";
import { bumpVersion } from "./bump-version.js";

// A tiny in-memory filesystem keyed by the trailing file name, so the injected readFile/writeFile
// never touch disk. The three bumped files have distinct basenames, so matching on `endsWith` is
// unambiguous.
function fakeFs(initial) {
    const files = { ...initial };
    return {
        files,
        readFile: (path) => {
            const key = Object.keys(files).find((name) => path.endsWith(name));
            if (!key) {
                throw new Error(`unexpected read: ${path}`);
            }
            return files[key];
        },
        writeFile: (path, content) => {
            const key = Object.keys(files).find((name) => path.endsWith(name)) ?? path;
            files[key] = content;
        },
    };
}

function baseFiles() {
    return {
        "package.json": JSON.stringify({ name: "kavynex", version: "1.1.1" }, null, 2) + "\n",
        "tauri.conf.json": JSON.stringify({ version: "1.1.1" }, null, 4) + "\n",
        "Cargo.toml": `[package]\nname = "kavynex"\nversion = "1.1.1"\nedition = "2021"\n`,
    };
}

function run({ newVersion, files, runCargoUpdate }) {
    const fs = fakeFs(files ?? baseFiles());
    const error = vi.fn();
    const exitCode = bumpVersion({
        newVersion,
        root: "/repo",
        readFile: fs.readFile,
        writeFile: fs.writeFile,
        runCargoUpdate: runCargoUpdate ?? (() => 0),
        log: vi.fn(),
        error,
    });

    return { exitCode, files: fs.files, error };
}

describe("bumpVersion", () => {
    it("rewrites all three files and returns 0 when cargo succeeds", () => {
        const { exitCode, files } = run({ newVersion: "1.2.0" });

        expect(exitCode).toBe(0);
        expect(JSON.parse(files["package.json"]).version).toBe("1.2.0");
        expect(JSON.parse(files["tauri.conf.json"]).version).toBe("1.2.0");
        expect(files["Cargo.toml"]).toContain('version = "1.2.0"');
    });

    it("returns 1 without writing when no version is given", () => {
        const { exitCode, files, error } = run({ newVersion: undefined });

        expect(exitCode).toBe(1);
        expect(error).toHaveBeenCalled();
        // Nothing was rewritten.
        expect(JSON.parse(files["package.json"]).version).toBe("1.1.1");
    });

    it("returns 1 for a non-semver version", () => {
        const { exitCode, error } = run({ newVersion: "1.2" });

        expect(exitCode).toBe(1);
        expect(error).toHaveBeenCalled();
    });

    it("returns 1 when the Cargo.toml version line is missing", () => {
        const files = baseFiles();
        files["Cargo.toml"] = `[package]\nname = "kavynex"\nedition = "2021"\n`;

        const { exitCode, error } = run({ newVersion: "1.2.0", files });

        expect(exitCode).toBe(1);
        expect(error).toHaveBeenCalledWith(expect.stringContaining("version line not found"));
    });

    it("returns 1 when cargo update fails after rewriting the version files", () => {
        const { exitCode, files, error } = run({ newVersion: "1.2.0", runCargoUpdate: () => 1 });

        expect(exitCode).toBe(1);
        expect(error).toHaveBeenCalledWith(expect.stringContaining("Cargo.lock was NOT updated"));
        // The manifests were still rewritten; only the lockfile step failed.
        expect(JSON.parse(files["package.json"]).version).toBe("1.2.0");
    });
});
