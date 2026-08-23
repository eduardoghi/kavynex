// CI gate over the mapping between the commands `generate_handler!` registers and the code in
// `src/` that actually calls them.
//
// Every other inventory in this repository is checked by something: the capability grants against
// the Tauri seam (verify-capability-surface.js), the path arguments against the rule each answers to
// (verify-command-path-surface.js), the release asset names against the README
// (verify-readme-asset-names.js). The registered command list was checked by nothing, and it drifted
// exactly the way an unchecked list does.
//
// Two commands outlived their callers. `cleanup_unreferenced_media_artifacts` lost its last one in
// `eed1ea6`, the commit that moved the creation sequence into the backend and carefully listed which
// steps it was deregistering; this one was in neither list. `delete_live_chat_file` was never wired
// to a UI at all. Both stayed registered for weeks, and one of them was *hardened* five days before
// it was removed. See docs/decisions/2026-08-16-no-command-without-a-caller.md.
//
// Why that matters here rather than only as tidiness: docs/THREAT-MODEL.md measures the attack
// surface by what a compromised renderer can invoke. Both of those unlink files. A guard on a
// command nothing calls is a guard whose only job is to survive an attacker, which is the wrong
// trade when deleting the command is free.
//
// What it proves and what it does not, stated exactly. It proves that the registered list, the
// frontend's command-name constants and the wrapper functions cannot drift apart silently: a command
// registered without a caller fails here, a constant naming an unregistered command fails here, and
// a wrapper nobody calls fails here. It does NOT prove the call is ever *reached* at runtime (a
// wrapper called only from a branch that never executes still passes), and it deliberately does not
// try: reachability needs the whole render graph, and the failure this file exists for is a command
// with no textual caller at all.
//
// Usage:
//     node scripts/verify-command-surface-is-used.js
//     node scripts/verify-command-surface-is-used.js --print   # emit constant -> wrapper -> callers

import { readFileSync, readdirSync } from "fs";
import { resolve, join, dirname } from "path";
import { fileURLToPath } from "url";

// Command names registered with Tauri, read from the `generate_handler!` list in lib.rs.
//
// The entries are `commands::<module>::<name>`, one per line, the last without a trailing comma. The
// name is taken from the final path segment rather than by matching the whole path, so a module
// rename does not quietly stop this from finding anything.
export function extractRegisteredCommands(handlerSource) {
    const list = handlerSource.match(/generate_handler!\[([\s\S]*?)\]/);

    if (!list) {
        return [];
    }

    return [...list[1].matchAll(/commands::[a-z_0-9]+::([a-z_0-9]+)/g)].map((match) => match[1]);
}

// The `NAME: "command_name"` pairs in src/constants/tauri-commands.ts.
export function extractCommandConstants(constantsSource) {
    return [...constantsSource.matchAll(/^\s+([A-Z_0-9]+): "([a-z_0-9]+)"/gm)].map((match) => ({
        constant: match[1],
        command: match[2],
    }));
}

// The exported function that invokes `constant`, or `null` when nothing references it.
//
// The wrapper is found by locating the first `TAURI_COMMANDS.<constant>` outside the constants file
// and taking the nearest `export function` above it. That is a heuristic and worth naming as one:
// it assumes the invoke sits inside an exported function in the same file, which is the shape every
// wrapper in this repository has (a repository module, a service module, or the two seam files).
// A future wrapper that broke the assumption would be reported as unwrapped rather than silently
// skipped, which is the safe direction: the gate complains about a real file instead of passing
// vacuously.
export function findCommandWrapper(constant, sources) {
    const reference = `TAURI_COMMANDS.${constant}`;

    for (const { name, content } of sources) {
        const index = content.indexOf(reference);

        if (index === -1) {
            continue;
        }

        const declarations = [
            ...content.slice(0, index).matchAll(/export\s+(?:async\s+)?function\s+([a-zA-Z0-9_]+)/g),
        ];

        return {
            file: name,
            // `null` when the reference is not inside an exported function: the caller reports that
            // as its own failure rather than treating it as "no wrapper at all".
            fn: declarations.length > 0 ? declarations[declarations.length - 1][1] : null,
        };
    }

    return null;
}

// `content` with every re-export statement removed: `export { a, b } from "./x"` (single- or
// multi-line) and `export * from "./x"`.
//
// A re-export names a function without calling it. This gate counted one as a caller for as long as
// `src/services/index.ts` existed, which is how `delete_thumbnail_file` stayed registered for six
// weeks after its last real caller went: the barrel mentioned the wrapper, so the wrapper looked
// used. A file that imports from a barrel and calls the function still mentions the name in its own
// text, so dropping the barrel's lines costs a legitimate caller nothing.
export function stripReExports(content) {
    return content
        .replace(/export\s*\{[^}]*\}\s*from\s*["'][^"']+["']\s*;?/g, "")
        .replace(/export\s*\*\s*(?:as\s+[a-zA-Z0-9_$]+\s*)?from\s*["'][^"']+["']\s*;?/g, "");
}

// The files, other than the one that defines it, that name `fn` somewhere other than a re-export.
//
// A word-boundary match on the identifier, not an import parse. The question this answers is the
// loose one on purpose: does anything at all mention this name in a position that could be a call.
// A wrapper with zero such mentions anywhere is the defect; anything more is out of scope.
export function findCallers(fn, definitionFile, sources) {
    const identifier = new RegExp(`\\b${fn}\\b`);

    return sources
        .filter(
            ({ name, content }) =>
                name !== definitionFile && identifier.test(stripReExports(content))
        )
        .map(({ name }) => name);
}

/**
 * Decides the gate from raw file contents, returning `{ ok, message }` rather than reading files or
 * exiting: the same shape as the sibling verify-* scripts, so every refusal branch is unit-testable.
 *
 * `sources` is every non-test file under src/, each `{ name, content }`. Test files are excluded
 * deliberately: a wrapper whose only caller is its own unit test is exactly the state this gate is
 * meant to report, and counting the test as a caller would make it pass.
 */
export function verifyCommandSurfaceIsUsed({ handlerSource, constantsSource, sources }) {
    const registered = extractRegisteredCommands(handlerSource);

    // A scan that matched nothing would make every check below pass vacuously, which is the one
    // outcome a gate must never produce quietly.
    if (registered.length === 0) {
        return {
            ok: false,
            message:
                "No command was found in lib.rs's generate_handler! list. Either the registration moved or this scan no longer matches it, and an empty list would make every check below pass for the wrong reason.",
        };
    }

    const constants = extractCommandConstants(constantsSource);

    if (constants.length === 0) {
        return {
            ok: false,
            message:
                "No command constant was found in src/constants/tauri-commands.ts. Either the file moved or this scan no longer matches it.",
        };
    }

    const problems = [];

    const registeredNames = new Set(registered);
    const declaredNames = new Set(constants.map((entry) => entry.command));

    const unreachable = registered.filter((name) => !declaredNames.has(name)).sort();

    if (unreachable.length > 0) {
        problems.push(
            "These commands are registered in generate_handler! but no constant in src/constants/tauri-commands.ts names them, so nothing in the app can call them. Remove the command, or add the constant and the wrapper that uses it:\n" +
                unreachable.map((name) => `  - ${name}`).join("\n")
        );
    }

    const unregistered = [...declaredNames].filter((name) => !registeredNames.has(name)).sort();

    if (unregistered.length > 0) {
        problems.push(
            "These command constants name a command generate_handler! does not register. Invoking one fails at runtime with an unknown-command error:\n" +
                unregistered.map((name) => `  - ${name}`).join("\n")
        );
    }

    const callersByConstant = new Map();

    for (const { constant, command } of constants) {
        const wrapper = findCommandWrapper(constant, sources);

        if (!wrapper) {
            problems.push(
                `TAURI_COMMANDS.${constant} (${command}) is declared but no file under src/ references it. Remove the constant and deregister the command, or add the wrapper that invokes it.`
            );
            continue;
        }

        if (!wrapper.fn) {
            problems.push(
                `TAURI_COMMANDS.${constant} (${command}) is invoked in ${wrapper.file} but not from inside an exported function, so this gate cannot tell whether anything calls it. Move the invoke into an exported wrapper, which is the shape every other command uses.`
            );
            continue;
        }

        const callers = findCallers(wrapper.fn, wrapper.file, sources);

        if (callers.length === 0) {
            problems.push(
                `${wrapper.fn}() in ${wrapper.file} is the only thing that invokes ${command}, and nothing outside that file calls it. A registered command with no caller is privilege the renderer holds for free: remove the command, the constant and the wrapper, or add the caller that was meant to exist.`
            );
            continue;
        }

        callersByConstant.set(constant, { ...wrapper, callers });
    }

    if (problems.length > 0) {
        return { ok: false, message: problems.join("\n\n") };
    }

    return {
        ok: true,
        message: `The command surface is fully used: ${registered.length} registered commands, each with a constant, a wrapper and at least one caller across ${sources.length} source files.`,
    };
}

// Every non-test file under `dir`, as `{ name, content }` with a forward-slash relative name.
function readSourceFiles(root, dir) {
    const collected = [];

    const walk = (current) => {
        for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) =>
            a.name.localeCompare(b.name)
        )) {
            const full = join(current, entry.name);

            if (entry.isDirectory()) {
                walk(full);
                continue;
            }

            if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) {
                continue;
            }

            const name = full.slice(root.length + 1).split("\\").join("/");

            // src/test/ holds the harness (factories, render helpers), not app code. A wrapper
            // reached only from there is as unused as one reached only from a .test file.
            if (name.startsWith("src/test/")) {
                continue;
            }

            collected.push({ name, content: readFileSync(full, "utf8") });
        }
    };

    walk(dir);

    return collected;
}

// Only run the gate when invoked as a script, so the exports above stay unit-testable (importing
// this file must not read files or exit).
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"))) {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

    const handlerSource = readFileSync(join(root, "src-tauri", "src", "lib.rs"), "utf8");
    const constantsSource = readFileSync(
        join(root, "src", "constants", "tauri-commands.ts"),
        "utf8"
    );
    const sources = readSourceFiles(root, join(root, "src"));

    if (process.argv[2] === "--print") {
        for (const { constant, command } of extractCommandConstants(constantsSource)) {
            const wrapper = findCommandWrapper(constant, sources);
            const callers = wrapper?.fn ? findCallers(wrapper.fn, wrapper.file, sources) : [];
            console.log(
                `${command}\t${wrapper?.fn ?? "<none>"}\t${wrapper?.file ?? "<none>"}\t${callers.length}`
            );
        }
    } else {
        const result = verifyCommandSurfaceIsUsed({ handlerSource, constantsSource, sources });

        if (result.ok) {
            console.log(result.message);
        } else {
            console.error(result.message);
            process.exit(1);
        }
    }
}
