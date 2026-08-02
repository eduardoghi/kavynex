import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve, dirname, join } from "path";
import { fileURLToPath } from "url";
import {
    findDeadPatterns,
    parseExamineGlobs,
    parseExcludePatterns,
    verifyMutantsExclusions,
} from "./verify-mutants-exclusions.js";

// A mutants.toml body carrying the two arrays this script reads, in the shape the real file uses:
// one quoted value per line, with comments interleaved between them.
const toml = ({ excludes = [], globs = [] } = {}) =>
    [
        "# The scope.",
        "examine_globs = [",
        ...globs.map((glob) => `    "${glob}",`),
        "]",
        "",
        "# Skip mutants a unit test cannot deterministically kill.",
        "exclude_re = [",
        ...excludes.map((pattern) => `    # why this one is excluded\n    '${pattern}',`),
        "]",
    ].join("\n");

// Two mutant descriptions in the exact shape `cargo mutants --list` prints them.
const mutantList = [
    "src/utils/path.rs:100:5: replace sanitize_relative_path_strict -> AppResult<PathBuf> with Ok(Default::default())",
    "src/services/binaries.rs:52:1: replace resolve_from_path -> Option<String> with None",
].join("\n");

describe("parseExcludePatterns", () => {
    it("reads one single-quoted pattern per line and skips the comments between them", () => {
        expect(parseExcludePatterns(toml({ excludes: ["is_executable_file", "resolve_from_path"] }))).toEqual([
            "is_executable_file",
            "resolve_from_path",
        ]);
    });

    it("keeps a pattern's regex escapes exactly as written", () => {
        // TOML literal strings do no escape processing, so what sits between the quotes is the
        // regex. Re-escaping it here would turn `\(\)` into something that matches nothing, which
        // is the very failure this gate reports.
        const patterns = parseExcludePatterns(
            toml({ excludes: ["replace cleanup_artifacts_best_effort(_locked)? with \\(\\)"] })
        );

        expect(patterns).toEqual(["replace cleanup_artifacts_best_effort(_locked)? with \\(\\)"]);
    });

    it("returns null when the array is not there at all", () => {
        // Distinguished from an empty array on purpose: a missing key means the parse (or the file)
        // changed shape, which the gate refuses rather than passing vacuously.
        expect(parseExcludePatterns("examine_globs = [\n]\n")).toBeNull();
    });
});

describe("parseExamineGlobs", () => {
    it("reads the double-quoted scope entries", () => {
        const globs = parseExamineGlobs(
            toml({ globs: ["src/utils/path.rs", "src/services/db_backup/*.rs"] })
        );

        expect(globs).toEqual(["src/utils/path.rs", "src/services/db_backup/*.rs"]);
    });
});

describe("findDeadPatterns", () => {
    it("reports nothing when every pattern still names a mutant", () => {
        const result = findDeadPatterns(["resolve_from_path", "sanitize_relative_path_strict"], mutantList);

        expect(result.dead).toEqual([]);
        expect(result.uncompilable).toEqual([]);
    });

    it("reports a pattern whose function was renamed out from under it", () => {
        // The exact shape both real failures took: an extraction moved the code and the pattern
        // kept naming the old site. `in is_recent` is not a substring of `in duration_is_recent`.
        const result = findDeadPatterns(["replace < with <= in is_recent"], mutantList);

        expect(result.dead).toEqual(["replace < with <= in is_recent"]);
    });

    it("separates a pattern JavaScript cannot compile from one that is merely dead", () => {
        // The flavors are not identical, so a pattern this script cannot judge has to be its own
        // answer - counting it as dead would report a rename that never happened.
        const result = findDeadPatterns(["resolve_from_path", "a(b"], mutantList);

        expect(result.dead).toEqual([]);
        expect(result.uncompilable).toHaveLength(1);
        expect(result.uncompilable[0].pattern).toBe("a(b");
    });
});

describe("verifyMutantsExclusions", () => {
    it("passes when every pattern matches and says how many were checked", () => {
        const result = verifyMutantsExclusions({
            tomlContent: toml({ excludes: ["resolve_from_path"] }),
            mutantList,
        });

        expect(result.ok).toBe(true);
        expect(result.message).toContain("1 exclude_re patterns");
    });

    it("fails and names each dead pattern", () => {
        const result = verifyMutantsExclusions({
            tomlContent: toml({ excludes: ["resolve_from_path", "in ensure_schema"] }),
            mutantList,
        });

        expect(result.ok).toBe(false);
        expect(result.message).toContain("in ensure_schema");
        // The live one must not be reported alongside it, or the fix looks larger than it is.
        expect(result.message).not.toContain("- resolve_from_path");
    });

    it("refuses an empty mutant list instead of calling every pattern dead", () => {
        // The failure mode worth guarding: `--list` producing nothing (a bad --file argument, a
        // cargo error swallowed upstream) would otherwise report all 43 patterns as dead, which
        // reads as a catastrophic config regression rather than as a broken invocation.
        const result = verifyMutantsExclusions({
            tomlContent: toml({ excludes: ["resolve_from_path"] }),
            mutantList: "   \n  \n",
        });

        expect(result.ok).toBe(false);
        expect(result.message).toContain("empty");
    });

    it("refuses a file with no exclude_re array rather than passing vacuously", () => {
        const result = verifyMutantsExclusions({
            tomlContent: "examine_globs = [\n    \"src/utils/path.rs\",\n]\n",
            mutantList,
        });

        expect(result.ok).toBe(false);
        expect(result.message).toContain("No exclude_re array");
    });
});

describe("the real mutants.toml", () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const tomlContent = readFileSync(join(root, "src-tauri", ".cargo", "mutants.toml"), "utf8");

    it("parses into a non-empty set of patterns and globs", () => {
        // The check that keeps this gate honest without a cargo-mutants run in the frontend suite:
        // if the parse ever silently stopped finding anything, every assertion above would still
        // pass against its synthetic fixtures while the real gate verified nothing.
        expect(parseExcludePatterns(tomlContent).length).toBeGreaterThan(0);
        expect(parseExamineGlobs(tomlContent).length).toBeGreaterThan(0);
    });

    it("holds no exclusion that JavaScript cannot compile as a regular expression", () => {
        // Runs without a mutant list, so it costs nothing here and still catches the one case the
        // CI gate would report as an unanswerable question rather than a pass or a fail.
        const { uncompilable } = findDeadPatterns(parseExcludePatterns(tomlContent), "a placeholder mutant");

        expect(uncompilable).toEqual([]);
    });
});
