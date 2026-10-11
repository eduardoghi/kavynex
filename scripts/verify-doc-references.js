// Checks that the docs still describe the tree they sit in.
//
// Two things drifted between audits, every time. A path a doc or a code comment cites stopped
// existing (a file renamed, a module split into a directory), and a module added under
// `src-tauri/src` never made it into `docs/ARCHITECTURE.md`. Neither fails anything on its own, so
// both were found by reading. This makes them fail CI instead:
//
// - Every path written in backticks in a Markdown doc, and every path in a Rust `//` comment, has to
//   resolve to a file or folder. A path is a token with a `/` that ends in a source or doc extension,
//   or in `/` for a folder. It is resolved from the repository root and from the source roots, so
//   `services/db_backup/import.rs`, `db_backup/import.rs` and `src-tauri/src/...` all work. Tokens
//   with a placeholder (`<N>`, `*`, `...`) are skipped, and so are `docs/decisions/` and the
//   changelog, which record what the tree was.
// - Every Rust module under `src-tauri/src` (not `mod.rs` or a test file) has to be named in
//   `docs/ARCHITECTURE.md`. A nested one counts when its file name appears in a paragraph that also
//   names its folder.
//
// It checks names, not behavior. A doc that still names the right file and describes it wrong
// passes.

import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { basename, dirname, join, relative, resolve, sep } from "path";
import { fileURLToPath } from "url";
import { isMainModule } from "./script-entry.js";

const PATH_EXTENSIONS = ["rs", "ts", "tsx", "js", "md", "yml", "yaml", "toml", "json"];
const PATH_TOKEN = new RegExp(
    `^[A-Za-z0-9_.\\-/]*/[A-Za-z0-9_.\\-/]*(\\.(${PATH_EXTENSIONS.join("|")})|/)$`
);

// Where a path in a doc is looked up, in order. The first that has it wins.
export const RESOLUTION_ROOTS = [
    ".",
    "src-tauri",
    "src-tauri/src",
    "src-tauri/src/services",
    "src",
    "docs",
    ".github/workflows",
];

const SKIPPED_DOCS = ["CHANGELOG.md", "docs/decisions/"];
const SKIPPED_DIRS = new Set(["node_modules", "target", "dist", ".git", "coverage", "gen"]);
const TEST_FILE_NAMES = new Set(["mod.rs", "tests.rs", "test_support.rs", "test_ipc.rs"]);

// A backticked or comment token that names a path, cleaned of what commonly trails it. `null` when
// it is not one.
export function asPathReference(token) {
    // `dir/sub/..` is a path being reasoned about, not one being cited.
    if (/(^|\/)\.\.(\/|$)/.test(token.trim())) {
        return null;
    }

    const cleaned = token
        .trim()
        .replace(/[),.:;]+$/, "")
        .replace(/::.*$/, "")
        .replace(/:\d+(-\d+)?$/, "");

    if (/[<>*]|\.\.\.|\{|\}/.test(cleaned) || cleaned.startsWith("http")) {
        return null;
    }

    if (cleaned.startsWith("/") || cleaned.startsWith("~") || /^[A-Za-z]:/.test(cleaned)) {
        return null;
    }

    return PATH_TOKEN.test(cleaned) ? cleaned.replace(/^\.\//, "") : null;
}

// Every path written in backticks in a Markdown text.
export function markdownReferences(text) {
    const references = [];

    for (const [, token] of text.matchAll(/`([^`\n]+)`/g)) {
        const reference = asPathReference(token);

        if (reference) {
            references.push(reference);
        }
    }

    return references;
}

// Every path in the `//` comments of a Rust source, with or without backticks around it.
export function rustCommentReferences(text) {
    const references = [];

    for (const line of text.split("\n")) {
        const comment = line.match(/^\s*\/\/[/!]?(.*)$/);

        if (!comment) {
            continue;
        }

        for (const token of comment[1].replace(/`/g, " ").split(/[\s(]+/)) {
            const reference = asPathReference(token);

            if (reference) {
                references.push(reference);
            }
        }
    }

    return references;
}

// Whether `reference` names something on disk under any of the roots, or is the tail of a path
// that exists. The second is how a doc names a file inside the folder its sentence is about
// (`home/use-home-media-actions.ts` in a paragraph on `src/hooks/`), and why the check is about a
// path that names nothing rather than one that is ambiguous.
export function resolves(reference, exists, knownPaths = [], roots = RESOLUTION_ROOTS) {
    if (roots.some((root) => exists(join(root, reference)))) {
        return true;
    }

    const tail = `/${reference}`;
    return knownPaths.some((path) => `${path}/`.endsWith(tail) || path.endsWith(tail));
}

// The paragraphs of a Markdown text, so a list that wraps over several lines is read as one.
function paragraphs(text) {
    return text.split(/\r?\n\s*\r?\n/);
}

// The modules (relative to `src-tauri/src`, with `/`) that `architecture` does not name.
export function unlistedModules(modules, architecture) {
    const blocks = paragraphs(architecture);

    return modules.filter((module) => {
        const name = basename(module);
        const folder = dirname(module).split("/").pop();

        if (dirname(module) === "." || folder === "services") {
            return !architecture.includes(name);
        }

        return !blocks.some((block) => block.includes(name) && block.includes(folder));
    });
}

function walk(dir, visit) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (SKIPPED_DIRS.has(entry.name)) {
            continue;
        }

        const path = join(dir, entry.name);

        if (entry.isDirectory()) {
            walk(path, visit);
        } else {
            visit(path);
        }
    }
}

function toPosix(path) {
    return path.split(sep).join("/");
}

function existsFrom(repoRoot) {
    return (path) => {
        const full = resolve(repoRoot, path);

        if (!existsSync(full)) {
            return false;
        }

        // A reference written with a trailing `/` names a folder, and a folder is all it can match.
        return !path.endsWith("/") || statSync(full).isDirectory();
    };
}

export function findProblems(repoRoot) {
    const exists = existsFrom(repoRoot);
    const problems = [];

    const docs = [];
    const knownPaths = new Set();
    walk(repoRoot, (path) => {
        const rel = toPosix(relative(repoRoot, path));

        for (let folder = dirname(rel); folder !== "."; folder = dirname(folder)) {
            knownPaths.add(folder);
        }
        knownPaths.add(rel);

        if (rel.endsWith(".md") && !SKIPPED_DOCS.some((skipped) => rel.startsWith(skipped))) {
            docs.push(rel);
        }
    });
    const known = [...knownPaths];

    for (const doc of docs) {
        for (const reference of markdownReferences(readFileSync(join(repoRoot, doc), "utf-8"))) {
            if (!resolves(reference, exists, known)) {
                problems.push(`${doc} cites \`${reference}\`, which does not exist`);
            }
        }
    }

    const rustRoot = join(repoRoot, "src-tauri", "src");
    const modules = [];

    walk(rustRoot, (path) => {
        if (!path.endsWith(".rs")) {
            return;
        }

        const rel = toPosix(relative(rustRoot, path));

        for (const reference of rustCommentReferences(readFileSync(path, "utf-8"))) {
            if (!resolves(reference, exists, known)) {
                problems.push(`src-tauri/src/${rel} cites \`${reference}\`, which does not exist`);
            }
        }

        if (!TEST_FILE_NAMES.has(basename(rel)) && !rel.split("/").includes("tests")) {
            modules.push(rel);
        }
    });

    const architecture = readFileSync(join(repoRoot, "docs", "ARCHITECTURE.md"), "utf-8");

    for (const module of unlistedModules(modules, architecture)) {
        problems.push(`src-tauri/src/${module} is not named in docs/ARCHITECTURE.md`);
    }

    return problems;
}

if (isMainModule(import.meta.url)) {
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const problems = findProblems(repoRoot);

    if (problems.length > 0) {
        for (const problem of problems) {
            console.error(problem);
        }

        console.error(`\n${problems.length} doc reference(s) no longer match the tree.`);
        process.exit(1);
    }

    console.log("Every path the docs and comments cite exists, and ARCHITECTURE.md names every module.");
}
