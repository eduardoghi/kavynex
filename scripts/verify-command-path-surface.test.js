import { describe, expect, it } from "vitest";
import {
    DECLARED_PATH_SURFACE,
    collectPathSurface,
    diffSurface,
    extractPathTakingCommands,
    formatSurface,
    isCrateStructType,
    isPathParameter,
    parameterName,
    parameterType,
    splitParameters,
    structPathFields,
    verifyCommandPathSurface,
} from "./verify-command-path-surface.js";

const file = (content) => ({ name: "test.rs", content });

const command = (signature) => `#[tauri::command]\npub async fn ${signature} -> AppResult<()> {\n}\n`;

// A stand-in for `CreateMediaRequest`, carrying the four shapes that matter: a path-named field, a
// field whose name says nothing and is declared by the marker, the near-miss sibling that must stay
// out, and an attribute between the comments and the field.
const requestStruct = `
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateMediaRequest {
    #[ts(type = "number")]
    pub channel_id: i64,
    pub title: String,
    pub source_mode: MediaSourceMode,
    /// A URL for a yt-dlp run, an absolute path for a local import.
    // path-surface: an absolute path in local-import mode.
    pub source_value: String,
    #[serde(default)]
    pub thumbnail_source_path: Option<String>,
    pub library_path: String,
    pub download_live_chat: bool,
}
`;

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

describe("parameterType", () => {
    it("returns the type after the annotation colon", () => {
        expect(parameterType("request: CreateMediaRequest")).toBe("CreateMediaRequest");
        expect(parameterType("db: State<'_, Db>")).toBe("State<'_, Db>");
    });

    it("splits at the annotation colon, not at a path type's own", () => {
        // `library::migration::Report` carries four colons; taking the first would yield a type of
        // `:library::migration::Report`, which no struct lookup could match.
        expect(parameterType("report: library::migration::Report")).toBe(
            "library::migration::Report"
        );
    });

    it("returns null for a parameter with no annotation", () => {
        expect(parameterType("self")).toBeNull();
    });
});

describe("isCrateStructType", () => {
    it("accepts a bare PascalCase type that could name a struct in this crate", () => {
        for (const type of ["CreateMediaRequest", "MediaPageQuery", "Db"]) {
            expect(isCrateStructType(type), type).toBe(true);
        }
    });

    it("rejects anything that cannot be a bare struct name", () => {
        // A generic, a reference, a qualified path and a primitive are all types no `pub struct
        // <name>` lookup should be attempted for. `String` is deliberately absent from this list:
        // it matches the shape, and is rejected one step later by simply having no declaration in
        // the tree - which is what keeps this from needing a built-in list that would go stale.
        for (const type of [
            "State<'_, Db>",
            "Option<String>",
            "Vec<String>",
            "&str",
            "library::migration::Report",
            "i64",
            "bool",
            null,
        ]) {
            expect(isCrateStructType(type), String(type)).toBe(false);
        }
    });
});

describe("structPathFields", () => {
    const sources = [file(requestStruct)];

    it("finds the path-named fields of a struct, in declaration order", () => {
        expect(structPathFields("CreateMediaRequest", sources)).toEqual([
            "source_value",
            "thumbnail_source_path",
            "library_path",
        ]);
    });

    it("includes a field the marker declares even though its name says nothing", () => {
        // This is the case a naming rule cannot reach: `source_value` is an absolute path for a
        // local import and a URL for a yt-dlp run, so the name is honest and still says nothing.
        expect(structPathFields("CreateMediaRequest", sources)).toContain("source_value");
    });

    it("leaves the near-miss sibling out", () => {
        // `source_mode` is a two-value enum sitting directly above the marked field, and it is why
        // a `source_` prefix rule was rejected in favour of the marker.
        const fields = structPathFields("CreateMediaRequest", sources);

        expect(fields).not.toContain("source_mode");
        expect(fields).not.toContain("channel_id");
        expect(fields).not.toContain("download_live_chat");
    });

    it("does not let a marker drift onto the field below the one it was written for", () => {
        // The marker applies to the field its comment block sits on. If a plain field intervened
        // and still picked it up, any struct with one marked field would report every field after
        // it - which would read as a much larger surface than there is.
        const source = file(`
pub struct Drifting {
    // path-surface: the marked one.
    pub marked_value: String,
    pub unmarked_value: String,
}
`);

        expect(structPathFields("Drifting", [source])).toEqual(["marked_value"]);
    });

    it("does not read prose mentioning the checker's filename as a marker", () => {
        // This was a real bug in the first version of the marker, not a hypothetical. The test was
        // `includes("path-surface")`, and the checker is called `verify-command-path-surface.js` -
        // so any comment pointing a reader at it contained the marker text, and prose *explaining*
        // the convention applied it to whatever field it happened to sit above. The marker is a
        // directive now, anchored and requiring its colon.
        const source = file(`
pub struct Documented {
    // See scripts/verify-command-path-surface.js for how the inventory is regenerated.
    pub title: String,
    // path-surface: this one really is a path.
    pub opaque_value: String,
}
`);

        expect(structPathFields("Documented", [source])).toEqual(["opaque_value"]);
    });

    it("returns nothing for a type with no declaration in the sources", () => {
        // What makes `isCrateStructType` safe to leave permissive: `AppHandle` matches its shape
        // and simply resolves to no fields.
        expect(structPathFields("AppHandle", sources)).toEqual([]);
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

    it("follows a struct-typed parameter into the paths it carries", () => {
        // The blind spot this closes, and the one that mattered most: `create_media` groups its
        // whole request into one struct, so matching on parameter names alone reported the app's
        // largest write command as taking no path at all. It is not an exotic shape either - it is
        // the direction this codebase deliberately moved in when the seven media-creation commands
        // became one, so every future command that groups its steps inherits it.
        const source = command("create_media(app: AppHandle, request: CreateMediaRequest)");

        expect(extractPathTakingCommands(source, [file(requestStruct)])).toEqual([
            {
                command: "create_media",
                parameters: ["source_value", "thumbnail_source_path", "library_path"],
            },
        ]);
    });

    it("reports a struct parameter as no path surface when the struct carries none", () => {
        const source = command("save(app: AppHandle, request: PlainRequest)");
        const structSource = file("pub struct PlainRequest {\n    pub title: String,\n}\n");

        expect(extractPathTakingCommands(source, [structSource])).toEqual([]);
    });

    it("behaves as before when no struct sources are supplied", () => {
        // The struct lookup is additive: a caller that passes none (every existing test, and the
        // exported helpers' default) still gets exactly the name-matched surface.
        const source = command("create_media(app: AppHandle, request: CreateMediaRequest)");

        expect(extractPathTakingCommands(source)).toEqual([]);
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
