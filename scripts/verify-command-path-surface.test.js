import { describe, expect, it } from "vitest";
import {
    DECLARED_PATH_SURFACE,
    collectPathSurface,
    diffSurface,
    extractPathTakingCommands,
    formatSurface,
    isPathParameter,
    parameterName,
    splitParameters,
    verifyCommandPathSurface,
} from "./verify-command-path-surface.js";

const file = (content) => ({ name: "test.rs", content });

const command = (signature) => `#[tauri::command]\npub async fn ${signature} -> AppResult<()> {\n}\n`;

describe("isPathParameter", () => {
    it("matches the parameter names that carry a filesystem path", () => {
        for (const name of [
            "path",
            "dir",
            "destination",
            "source",
            "library_path",
            "relative_path",
            "media_paths",
            "external_backup_dir",
            "old_library_directory",
        ]) {
            expect(isPathParameter(name), name).toBe(true);
        }
    });

    it("does not match names that merely mention a path-ish word", () => {
        // `import_mode` and `run_id` are ordinary values; `pathological` and `dirty` are the
        // substring traps a looser `includes()` test would fall into.
        for (const name of ["app", "db", "url", "import_mode", "run_id", "pathological", "dirty"]) {
            expect(isPathParameter(name), name).toBe(false);
        }
    });
});

describe("splitParameters", () => {
    it("splits on the commas that separate parameters", () => {
        expect(splitParameters("app: AppHandle, path: String")).toEqual([
            "app: AppHandle",
            "path: String",
        ]);
    });

    it("keeps a generic argument's own comma inside its parameter", () => {
        // `State<'_, Db>` carries a comma that does not separate parameters. Splitting on it would
        // tear the parameter in two and lose the name, which is how a command taking `db` plus a
        // path could be read as taking neither.
        expect(splitParameters("db: State<'_, Db>, library_path: String")).toEqual([
            "db: State<'_, Db>",
            "library_path: String",
        ]);
    });

    it("handles a nested generic and an empty list", () => {
        expect(splitParameters("on_batch: Channel<Event<Vec<String>>>, path: String")).toEqual([
            "on_batch: Channel<Event<Vec<String>>>",
            "path: String",
        ]);
        expect(splitParameters("")).toEqual([]);
    });
});

describe("parameterName", () => {
    it("returns the name before the type annotation", () => {
        expect(parameterName("library_path: String")).toBe("library_path");
        expect(parameterName("db: State<'_, Db>")).toBe("db");
    });

    it("ignores a colon that belongs to a path type rather than the annotation", () => {
        expect(parameterName("report: library::migration::Report")).toBe("report");
    });

    it("returns null for a parameter with no annotation", () => {
        expect(parameterName("self")).toBeNull();
    });
});

describe("extractPathTakingCommands", () => {
    it("finds a command taking a path", () => {
        const source = command("get_library_summary(db: State<'_, Db>, library_path: String)");

        expect(extractPathTakingCommands(source)).toEqual([
            { command: "get_library_summary", parameters: ["library_path"] },
        ]);
    });

    it("omits a command with no path parameter", () => {
        expect(extractPathTakingCommands(command("list_channels(app: AppHandle)"))).toEqual([]);
    });

    it("does not read the function name as a path parameter", () => {
        // `resolve_default_library_directory` is named after a directory and takes none. A check
        // that matched against the whole signature string would list it and quietly widen the
        // inventory with a command that has no path surface at all.
        const source = command("resolve_default_library_directory(app: AppHandle)");

        expect(extractPathTakingCommands(source)).toEqual([]);
    });

    it("ignores a plain function that carries no command attribute", () => {
        const source = "pub async fn helper(path: String) -> AppResult<()> {\n}\n";

        expect(extractPathTakingCommands(source)).toEqual([]);
    });

    it("keeps every path parameter of a multi-path command, in declaration order", () => {
        const source = command(
            "check_library_integrity(db: State<'_, Db>, library_path: String, media_paths: Vec<String>, thumbnail_paths: Vec<String>)"
        );

        expect(extractPathTakingCommands(source)).toEqual([
            {
                command: "check_library_integrity",
                parameters: ["library_path", "media_paths", "thumbnail_paths"],
            },
        ]);
    });

    it("finds several commands in one file", () => {
        const source = command("a(path: String)") + command("b(app: AppHandle)") + command("c(dir: String)");

        expect(extractPathTakingCommands(source).map((entry) => entry.command)).toEqual(["a", "c"]);
    });
});

describe("collectPathSurface", () => {
    it("sorts by command name so the comparison does not depend on file order", () => {
        const files = [file(command("zulu(path: String)")), file(command("alpha(path: String)"))];

        expect(collectPathSurface(files).map((entry) => entry.command)).toEqual(["alpha", "zulu"]);
    });
});

describe("diffSurface", () => {
    const declared = [{ command: "existing", parameters: ["path"] }];

    it("reports nothing when the surface matches", () => {
        expect(diffSurface([{ command: "existing", parameters: ["path"] }], declared)).toEqual({
            added: [],
            removed: [],
        });
    });

    it("reports a new command taking a path", () => {
        const actual = [
            { command: "existing", parameters: ["path"] },
            { command: "fresh", parameters: ["library_path"] },
        ];

        expect(diffSurface(actual, declared).added).toEqual(["fresh(library_path)"]);
    });

    it("reports a command that no longer exists, so the inventory cannot rot", () => {
        expect(diffSurface([], declared).removed).toEqual(["existing(path)"]);
    });

    it("reports a path parameter added to a command already declared", () => {
        // The case a name-only comparison misses: the command was already inventoried, and it just
        // grew a second caller-supplied path.
        const actual = [{ command: "existing", parameters: ["path", "library_path"] }];
        const result = diffSurface(actual, declared);

        expect(result.added).toEqual(["existing(path, library_path)"]);
        expect(result.removed).toEqual(["existing(path)"]);
    });
});

describe("formatSurface", () => {
    it("renders entries in the literal shape the declared inventory uses", () => {
        // The failure message tells the maintainer to paste `--print` output into the inventory, so
        // the rendering has to be valid JavaScript in that position.
        expect(formatSurface([{ command: "a", parameters: ["path", "dir"] }])).toBe(
            '    { command: "a", parameters: ["path", "dir"] },'
        );
    });
});

describe("verifyCommandPathSurface", () => {
    it("passes when the tree matches the declared inventory", () => {
        const files = [file(command("only(path: String)"))];
        const declared = [{ command: "only", parameters: ["path"] }];

        expect(verifyCommandPathSurface(files, declared)).toEqual({ added: [], removed: [] });
    });

    it("fails when a command taking a path is added without declaring it", () => {
        const files = [file(command("only(path: String)") + command("sneaky(source: String)"))];
        const declared = [{ command: "only", parameters: ["path"] }];

        expect(verifyCommandPathSurface(files, declared).added).toEqual(["sneaky(source)"]);
    });
});

describe("the declared inventory", () => {
    it("is sorted by command name and free of duplicates", () => {
        // The inventory is regenerated from `--print`, which sorts; a hand edit that broke either
        // property would make the next regeneration a confusing diff.
        const names = DECLARED_PATH_SURFACE.map((entry) => entry.command);

        expect(names).toEqual([...names].sort((left, right) => left.localeCompare(right)));
        expect(new Set(names).size).toBe(names.length);
    });

    it("declares at least one path parameter per entry", () => {
        for (const entry of DECLARED_PATH_SURFACE) {
            expect(entry.parameters.length, entry.command).toBeGreaterThan(0);
        }
    });
});
