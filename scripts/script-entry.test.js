import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { pathToFileURL } from "url";
import { afterEach, describe, expect, it } from "vitest";
import { isMainModule } from "./script-entry.js";

const created = [];

function scriptIn(directoryName) {
    const root = mkdtempSync(join(tmpdir(), "kavynex-entry-"));
    created.push(root);
    const directory = join(root, directoryName);
    mkdirSync(directory, { recursive: true });
    const script = join(directory, "probe.js");
    writeFileSync(script, "");
    return script;
}

afterEach(() => {
    for (const root of created.splice(0)) {
        rmSync(root, { recursive: true, force: true });
    }
});

describe("isMainModule", () => {
    it.each(["plain", "dir com espaço", "acentuação"])(
        "recognizes the script node was started with in %s",
        (directoryName) => {
            const script = scriptIn(directoryName);

            expect(isMainModule(pathToFileURL(script).href, script)).toBe(true);
        }
    );

    it("is false when another script was started", () => {
        const script = scriptIn("plain");
        const other = scriptIn("other");

        expect(isMainModule(pathToFileURL(script).href, other)).toBe(false);
    });

    it("is false when there is no entry script", () => {
        const script = scriptIn("plain");

        expect(isMainModule(pathToFileURL(script).href, undefined)).toBe(false);
    });

    it("ignores the case of a Windows path", () => {
        const script = scriptIn("plain");

        expect(isMainModule(pathToFileURL(script).href, script.toUpperCase(), "win32")).toBe(true);
    });
});
