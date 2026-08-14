// CI gate over the two halves of the cross-cutting path rule: the set of `#[tauri::command]`s that
// accept a path from the caller, and the set of functions that refuse a network location before
// touching one. Either changing without its declared inventory below being updated fails the run.
//
// The second half was added after the first proved to cover less than it read as covering. The
// command inventory answers "which commands take a path"; `docs/THREAT-MODEL.md` also enumerates
// *which functions apply the refusal*, and that second list is what a review of a new command is
// checked against. Nothing held it: an audit found one enforcement site missing from the document
// and another command stat-ing a caller-supplied path with no refusal at all, while this gate
// passed - because both were, correctly, in the command inventory.
//
// docs/THREAT-MODEL.md states a cross-cutting rule - every command that accepts a path from the caller
// refuses a UNC / network location before any filesystem call touches it, and the library-relative
// and library-root paths go through `utils::path` / `services::library::guard` rather than being
// trusted - and then names the commands that satisfy it. Prose cannot hold that list in sync with
// the code, and it did not: an audit found the documented list had drifted from the call sites, and
// three commands were trusting a caller-supplied `library_path` on a premise no caller relied on.
//
// What this check does and does not prove is worth being exact about, because a gate that overstates
// itself is worse than none. It does NOT verify that a command applies the right guard: that needs
// the call chain, which a parser over one file cannot follow, and a check that guessed would hand
// out false confidence on exactly the surface it exists to protect. What it does is make the surface
// impossible to grow silently. Adding a command that takes a path - or adding a path parameter to an
// existing one - fails CI until the inventory is updated, and updating it is where the author has to
// decide which of the threat model's cases the new path falls into.
//
// The failure is deliberately two-directional. A removed or renamed command fails too, so the
// inventory cannot rot into a list of names that no longer exist, which is how the prose version
// died.
//
// Usage:
//     node scripts/verify-command-path-surface.js            # verify (CI)
//     node scripts/verify-command-path-surface.js --print     # emit the current surface to paste below

import { readFileSync, readdirSync } from "fs";
import { resolve, join, dirname, relative, sep } from "path";
import { fileURLToPath } from "url";

const COMMAND_ATTRIBUTE = "#[tauri::command]";

// A parameter whose name says it carries a filesystem path. Matched on the parameter name only,
// never the function name - `resolve_default_library_directory(app: AppHandle)` takes no path
// despite what it is called, and a check that read the signature as one string would list it.
export function isPathParameter(name) {
    return (
        name === "path" ||
        name === "dir" ||
        name === "destination" ||
        name === "source" ||
        /_(path|paths|dir|dirs|directory|directories)$/.test(name)
    );
}

// Splits a Rust parameter list on the commas that actually separate parameters. Generic arguments
// carry their own commas (`db: State<'_, Db>`), so a plain `split(",")` would tear one parameter
// into two and lose the name; depth is tracked across `<>`, `()` and `[]` for that reason.
export function splitParameters(parameterList) {
    const parameters = [];
    let depth = 0;
    let current = "";

    for (const character of parameterList) {
        if (character === "<" || character === "(" || character === "[") {
            depth += 1;
        } else if (character === ">" || character === ")" || character === "]") {
            depth -= 1;
        }

        if (character === "," && depth === 0) {
            parameters.push(current);
            current = "";
            continue;
        }

        current += character;
    }

    parameters.push(current);

    return parameters.map((parameter) => parameter.trim()).filter(Boolean);
}

// The offset of the annotation colon - the first `:` at depth 0 - or -1 when the parameter has
// none. Shared by `parameterName` and `parameterType` so the two cannot disagree about where the
// name ends and the type begins.
function annotationColonAt(parameter) {
    let depth = 0;

    for (let index = 0; index < parameter.length; index += 1) {
        const character = parameter[index];

        if (character === "<" || character === "(" || character === "[") {
            depth += 1;
        } else if (character === ">" || character === ")" || character === "]") {
            depth -= 1;
        } else if (character === ":" && depth === 0) {
            return index;
        }
    }

    return -1;
}

// The parameter's name, i.e. everything before the type annotation. Returns null for a parameter
// with no `:` at depth 0 (`self`, or a malformed signature), which is skipped rather than guessed at.
export function parameterName(parameter) {
    const colonAt = annotationColonAt(parameter);

    if (colonAt === -1) {
        return null;
    }

    return parameter.slice(0, colonAt).trim().replace(/^mut\s+/, "");
}

// The parameter's type, i.e. everything after the annotation colon. Null when there is none.
export function parameterType(parameter) {
    const colonAt = annotationColonAt(parameter);

    if (colonAt === -1) {
        return null;
    }

    return parameter.slice(colonAt + 1).trim();
}

// True for a type that could name a struct declared in this crate: a bare PascalCase identifier,
// with no generic argument, reference or path qualifier.
//
// Deliberately permissive, because it decides only whether to *look* for a declaration - a type
// that matches but has no `pub struct` behind it (`AppHandle`, `String`) resolves to no fields and
// is dropped. That is what keeps this from needing a list of built-in types to exclude, which is
// the kind of list that goes stale silently.
export function isCrateStructType(type) {
    return type !== null && /^[A-Z][A-Za-z0-9]*$/.test(type);
}

// The marker that declares a struct field to be part of the path surface even though its name does
// not say so, written as a `// path-surface: <reason>` comment on the field it applies to.
//
// It exists because one real field needs it and a naming rule cannot reach it.
// `CreateMediaRequest::source_value` is an absolute path for a local import and a URL for a yt-dlp
// run, so `source_value` is the honest name - and the obvious widenings all misfire. Matching a
// `source_` prefix would also catch `source_mode` (a two-value enum) in the very same struct.
// Renaming the field to `source_path` would make the name lie in the other mode and would churn the
// generated TypeScript binding.
//
// So the author states it instead. Removing the marker is not a way to quietly shrink the surface:
// it changes what this script reports, which fails the diff against the declared inventory below.
//
// Anchored to the start of the comment and requiring the colon, rather than tested with a bare
// `includes`. A loose substring test is not a style preference here - it was wrong, and this
// script's own name is what made it wrong: any comment that points a reader at
// `verify-command-path-surface.js` contains the marker text, so prose *explaining* the convention
// silently applied it to whatever field it sat above. Found by removing the real marker and
// watching the gate still pass. Same substring trap `isPathParameter` is deliberately written to
// avoid.
const PATH_SURFACE_MARKER = /^\/\/+\s*path-surface\s*:/;

// The fields of `pub struct <typeName>` that carry a caller-supplied path, in declaration order.
//
// This exists because the path surface is not only spelled as bare parameters any more. A command
// that groups its request into one struct - the shape this codebase deliberately moved toward, since
// `docs/THREAT-MODEL.md` states that the IPC surface exposes an operation rather than its steps -
// puts every one of those paths behind a parameter named something like `request`, which no
// name-based rule can see. `create_media(app, request: CreateMediaRequest)` is that case: it carries
// four caller-supplied paths and was reported as taking none.
//
// Returns an empty list for a type with no declaration in the sources, which is what makes
// `isCrateStructType` safe to leave permissive.
export function structPathFields(typeName, sources) {
    const declaration = new RegExp(`\\bpub struct\\s+${typeName}\\s*\\{`);

    for (const { content } of sources) {
        const match = declaration.exec(content);

        if (!match) {
            continue;
        }

        const bodyStart = match.index + match[0].length;
        let depth = 1;
        let bodyEnd = bodyStart;

        while (bodyEnd < content.length && depth > 0) {
            const character = content[bodyEnd];

            if (character === "{") {
                depth += 1;
            } else if (character === "}") {
                depth -= 1;

                if (depth === 0) {
                    break;
                }
            }

            bodyEnd += 1;
        }

        const fields = [];
        // Whether the contiguous run of comment lines directly above the next field carried the
        // marker. Reset by every field and by any non-comment, non-attribute line, so a marker
        // cannot drift onto a field it was not written for.
        let markerPending = false;

        for (const line of content.slice(bodyStart, bodyEnd).split("\n")) {
            const trimmed = line.trim();

            if (trimmed.startsWith("//")) {
                markerPending = markerPending || PATH_SURFACE_MARKER.test(trimmed);
                continue;
            }

            // Attributes (`#[serde(...)]`, `#[ts(...)]`) sit between the comments and the field, so
            // they must not clear a pending marker.
            if (trimmed.startsWith("#[") || trimmed.length === 0) {
                continue;
            }

            const fieldMatch = /^(?:pub(?:\([^)]*\))?\s+)?([a-z_][a-z0-9_]*)\s*:/.exec(trimmed);

            if (fieldMatch && (markerPending || isPathParameter(fieldMatch[1]))) {
                fields.push(fieldMatch[1]);
            }

            markerPending = false;
        }

        return fields;
    }

    return [];
}

// Every `#[tauri::command]` in one source file that takes at least one path parameter, as
// `{ command, parameters }` with the path parameters in declaration order. A command with no path
// parameter is omitted entirely - the inventory is about the path surface, not about every command.
//
// `structSources` are the files searched for a struct declaration when a parameter's type names one;
// pass none and the function behaves exactly as it did before struct parameters were followed.
export function extractPathTakingCommands(source, structSources = []) {
    const found = [];
    let searchFrom = 0;

    for (;;) {
        const attributeAt = source.indexOf(COMMAND_ATTRIBUTE, searchFrom);

        if (attributeAt === -1) {
            break;
        }

        searchFrom = attributeAt + COMMAND_ATTRIBUTE.length;

        const signatureMatch = /\bfn\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(source.slice(searchFrom));

        if (!signatureMatch) {
            continue;
        }

        const command = signatureMatch[1];
        const openParenAt = searchFrom + signatureMatch.index + signatureMatch[0].length;

        let depth = 1;
        let closeParenAt = openParenAt;

        while (closeParenAt < source.length && depth > 0) {
            const character = source[closeParenAt];

            if (character === "(") {
                depth += 1;
            } else if (character === ")") {
                depth -= 1;

                if (depth === 0) {
                    break;
                }
            }

            closeParenAt += 1;
        }

        // A parameter contributes either its own name (when that name says it carries a path) or,
        // when its type names a struct declared in this crate, that struct's path-carrying fields.
        // The two are mutually exclusive in practice - a struct parameter is called `request`, not
        // `request_path` - but the flatMap does not need them to be.
        const parameters = splitParameters(source.slice(openParenAt, closeParenAt)).flatMap(
            (parameter) => {
                const name = parameterName(parameter);

                if (name === null) {
                    return [];
                }

                if (isPathParameter(name)) {
                    return [name];
                }

                const type = parameterType(parameter);

                if (!isCrateStructType(type)) {
                    return [];
                }

                return structPathFields(type, structSources);
            }
        );

        if (parameters.length > 0) {
            found.push({ command, parameters });
        }
    }

    return found;
}

// The whole path surface across every command module, sorted by command name so the comparison and
// the `--print` output are stable regardless of file or declaration order.
//
// `structSources` are searched for the declaration of a struct-typed parameter. They are a separate
// argument from `files` because the two sets differ: the commands live in `commands/`, while the
// request struct one of them takes is declared beside the service that consumes it
// (`services/media_creation.rs`).
export function collectPathSurface(files, structSources = []) {
    const surface = files.flatMap(({ content }) =>
        extractPathTakingCommands(content, structSources)
    );

    return surface.sort((left, right) => left.command.localeCompare(right.command));
}

// Renders a surface as the literal below, so a failing run can be fixed by pasting the output of
// `--print` rather than by hand-editing 28 entries and getting one wrong.
export function formatSurface(surface) {
    return surface
        .map(({ command, parameters }) => {
            const rendered = parameters.map((name) => `"${name}"`).join(", ");
            return `    { command: "${command}", parameters: [${rendered}] },`;
        })
        .join("\n");
}

// Set difference in both directions, over already-rendered entry strings. Shared by the two
// inventories below so a change to one cannot report differently from the other.
export function diffEntries(actual, declared) {
    const actualEntries = new Set(actual);
    const declaredEntries = new Set(declared);

    return {
        added: [...actualEntries].filter((entry) => !declaredEntries.has(entry)).sort(),
        removed: [...declaredEntries].filter((entry) => !actualEntries.has(entry)).sort(),
    };
}

// Compares the surface found in the tree against the declared inventory, by the exact
// `command(param, param)` spelling, so a path parameter added to an existing command is a change
// too - not only a whole new command.
export function diffSurface(actual, declared) {
    const render = ({ command, parameters }) => `${command}(${parameters.join(", ")})`;

    return diffEntries(actual.map(render), declared.map(render));
}

// The source with its `#[cfg(test)] mod tests { ... }` block removed, so a call site that only
// exists in a test - or a comment inside one quoting the call - is not read as production code.
//
// Anchored to `#[cfg(test)]` *followed by* `mod tests`, not to `#[cfg(test)]` alone. That
// distinction is load-bearing rather than pedantic: `db_backup/mod.rs` carries `#[cfg(test)] use
// submodule::{...}` lines partway up the file, and truncating there would silently drop everything
// below - which in a security gate is a false negative, the one direction that must not happen.
export function stripTestModule(source) {
    const testModuleAt = /#\[cfg\(test\)\]\s*mod\s+tests\s*\{/.exec(source);

    return testModuleAt === null ? source : source.slice(0, testModuleAt.index);
}

// The functions in one source file that call `is_network_path`, i.e. the sites enforcing the
// cross-cutting network-path rule, as `<file>::<fn>` in the order they appear.
//
// This is the second half of what this script gates, and it exists because the first half does not
// cover it. `DECLARED_PATH_SURFACE` answers "which commands take a path from the caller"; it says
// nothing about which functions refuse a UNC before touching one, and that second list is the one
// `docs/THREAT-MODEL.md` enumerates and a review is actually checked against. It drifted: an audit
// found `thumbnail::picked::validate_picked_thumbnail_path` applying the rule while the document
// did not list it, and `thumbnail::temp::validate_temporary_thumbnail_delete_path` stat-ing a
// caller-supplied path with no refusal at all - the exact failure the prose list is meant to make
// visible, in the one place the command inventory could not see.
//
// The enclosing function is found by scanning back for the nearest `fn` declaration, which is
// enough here because these are all free functions. A line whose trimmed form starts with `//` is
// skipped so prose *about* the rule is not read as an application of it; a trailing comment on a
// code line is deliberately not stripped, because a false positive fails loudly and gets fixed
// while a false negative hides a missing guard.
export function extractNetworkRefusalSites(fileName, source) {
    const lines = stripTestModule(source).split("\n");
    const declaration = /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)/;
    const sites = [];
    let enclosing = null;

    for (const line of lines) {
        const declared = declaration.exec(line);

        if (declared) {
            enclosing = declared[1];
        }

        if (line.trim().startsWith("//") || !line.includes("is_network_path(")) {
            continue;
        }

        // The predicate's own definition is not an application of it.
        if (enclosing === null || enclosing === "is_network_path") {
            continue;
        }

        const site = `${fileName}::${enclosing}`;

        if (!sites.includes(site)) {
            sites.push(site);
        }
    }

    return sites;
}

// Every network-refusal site across the backend, sorted so the comparison and the `--print` output
// do not depend on directory order.
export function collectNetworkRefusalSites(sources) {
    return sources
        .flatMap(({ name, content }) => extractNetworkRefusalSites(name, content))
        .sort((left, right) => left.localeCompare(right));
}

// The declared enforcement sites for the network-path rule, matching the list
// `docs/THREAT-MODEL.md` enumerates under "Path safety". Adding a call to `is_network_path`
// anywhere in the backend fails this check until both lists learn about it, which is the point:
// the document is what a review of a new command is checked against, and prose kept in sync by
// discipline alone is what already drifted once.
//
// Regenerate with: node scripts/verify-command-path-surface.js --print
export const DECLARED_NETWORK_REFUSAL_SITES = [
    "commands/database.rs::prepare_export_destination",
    "commands/database.rs::prepare_import_source",
    "services/library/guard.rs::paths_refer_to_same_location",
    "services/library/media.rs::import_media_file_cancellable_sync",
    "services/library/mod.rs::resolve_path_inside_library",
    "services/thumbnail/picked.rs::validate_picked_thumbnail_path",
    "services/thumbnail/temp.rs::validate_source_media_path",
    "services/thumbnail/temp.rs::validate_temporary_thumbnail_delete_path",
    "services/yt_dlp/cookies.rs::normalize_cookies_path",
];

// The declared path surface. Every entry is a command that takes a path from the caller; how each
// one satisfies the rule (a network refusal, the library guard, a strictly-relative path that
// cannot express an absolute one, or a documented exception) is recorded in docs/THREAT-MODEL.md, not here -
// duplicating it would give this file a second job it cannot keep honest.
//
// Regenerate with: node scripts/verify-command-path-surface.js --print
export const DECLARED_PATH_SURFACE = [
    { command: "check_library_integrity", parameters: ["library_path"] },
    { command: "cleanup_unreferenced_media_artifacts", parameters: ["file_path", "thumbnail_path", "live_chat_file_path"] },
    { command: "create_media", parameters: ["source_value", "thumbnail_source_path", "library_path", "cookies_path"] },
    { command: "delete_live_chat_file", parameters: ["relative_path"] },
    { command: "delete_temporary_thumbnail", parameters: ["path"] },
    { command: "delete_thumbnail_file", parameters: ["thumbnail_path", "library_path"] },
    { command: "download_channel_avatar_from_handle", parameters: ["library_path"] },
    { command: "ensure_directory_exists", parameters: ["path"] },
    { command: "export_database", parameters: ["destination_path"] },
    { command: "fetch_youtube_comments", parameters: ["cookies_path"] },
    { command: "generate_temporary_thumbnail", parameters: ["path"] },
    { command: "get_library_summary", parameters: ["library_path"] },
    { command: "import_database", parameters: ["source_path"] },
    { command: "insert_channel", parameters: ["avatar_path"] },
    { command: "is_directory_empty", parameters: ["path"] },
    { command: "list_yt_dlp_formats", parameters: ["cookies_path"] },
    { command: "migrate_library_directory", parameters: ["old_library_path", "new_library_path"] },
    { command: "open_path_in_system", parameters: ["path", "library_path"] },
    { command: "persist_thumbnail_file", parameters: ["path", "library_path"] },
    { command: "register_library_asset_scope", parameters: ["library_path"] },
    { command: "replace_channel_avatar", parameters: ["avatar_path"] },
    { command: "resolve_display_thumbnails", parameters: ["relative_paths", "library_path"] },
    { command: "resolve_existing_directory", parameters: ["path"] },
    { command: "set_app_settings", parameters: ["library_path"] },
    { command: "set_external_backup_dir", parameters: ["path"] },
    { command: "stage_manual_thumbnail", parameters: ["path"] },
    { command: "stream_live_chat_file", parameters: ["relative_path"] },
];

export function readCommandFiles(commandsDir) {
    return readdirSync(commandsDir)
        .filter((name) => name.endsWith(".rs"))
        .sort()
        .map((name) => ({
            name,
            content: readFileSync(join(commandsDir, name), "utf8"),
        }));
}

// Every `.rs` file under `root`, for resolving a struct-typed parameter's declaration. The whole
// backend tree rather than only `commands/`, because a request struct is declared beside the service
// that consumes it, not beside the command that receives it.
//
// `name` is the path relative to `base` in posix spelling, so the refusal-site inventory below reads
// the same on every platform - a Windows separator would otherwise put `services\library\guard.rs`
// in a list a Linux CI run spells with slashes.
export function readRustSources(root, base = root) {
    return readdirSync(root, { withFileTypes: true })
        .sort((left, right) => left.name.localeCompare(right.name))
        .flatMap((entry) => {
            const entryPath = join(root, entry.name);

            if (entry.isDirectory()) {
                return readRustSources(entryPath, base);
            }

            if (!entry.name.endsWith(".rs")) {
                return [];
            }

            return [
                {
                    name: relative(base, entryPath).split(sep).join("/"),
                    content: readFileSync(entryPath, "utf8"),
                },
            ];
        });
}

export function verifyCommandPathSurface(
    files,
    declared = DECLARED_PATH_SURFACE,
    structSources = []
) {
    return diffSurface(collectPathSurface(files, structSources), declared);
}

export function verifyNetworkRefusalSites(
    sources,
    declared = DECLARED_NETWORK_REFUSAL_SITES
) {
    return diffEntries(collectNetworkRefusalSites(sources), declared);
}

function main() {
    const scriptDir = dirname(fileURLToPath(import.meta.url));
    const backendDir = resolve(scriptDir, "..", "src-tauri", "src");
    const commandsDir = join(backendDir, "commands");
    const files = readCommandFiles(commandsDir);
    const structSources = readRustSources(backendDir);

    if (process.argv.includes("--print")) {
        console.log("// DECLARED_PATH_SURFACE");
        console.log(formatSurface(collectPathSurface(files, structSources)));
        console.log("\n// DECLARED_NETWORK_REFUSAL_SITES");
        for (const site of collectNetworkRefusalSites(structSources)) {
            console.log(`    "${site}",`);
        }
        return;
    }

    const surface = verifyCommandPathSurface(files, DECLARED_PATH_SURFACE, structSources);
    const refusals = verifyNetworkRefusalSites(structSources, DECLARED_NETWORK_REFUSAL_SITES);

    const report = (changed, title) => {
        if (changed.added.length === 0 && changed.removed.length === 0) {
            return false;
        }

        console.error(`${title}\n`);

        if (changed.added.length > 0) {
            console.error("Not in the declared inventory:");
            for (const entry of changed.added) {
                console.error(`  + ${entry}`);
            }
            console.error("");
        }

        if (changed.removed.length > 0) {
            console.error("Declared but no longer present:");
            for (const entry of changed.removed) {
                console.error(`  - ${entry}`);
            }
            console.error("");
        }

        return true;
    };

    const surfaceChanged = report(
        surface,
        "The set of commands accepting a caller-supplied path has changed."
    );
    const refusalsChanged = report(
        refusals,
        "The set of functions refusing a network path has changed."
    );

    if (!surfaceChanged && !refusalsChanged) {
        console.log(
            `The command path surface matches the declared inventory ` +
                `(${DECLARED_PATH_SURFACE.length} commands, ` +
                `${DECLARED_NETWORK_REFUSAL_SITES.length} network-refusal sites).`
        );
        return;
    }

    console.error(
        "Every command taking a path from the caller has to satisfy the cross-cutting path rule in\n" +
            "docs/THREAT-MODEL.md - a UNC/network refusal before any filesystem call, the library\n" +
            "guard, or a strictly-relative path - and say which in that document. The second list is\n" +
            "the enforcement side of the same rule: that document enumerates the functions applying\n" +
            "it, and a new one belongs in the enumeration before it belongs here. Once both are\n" +
            "right, refresh the inventories with:\n\n" +
            "    node scripts/verify-command-path-surface.js --print\n"
    );

    process.exitCode = 1;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"))) {
    main();
}
