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

import { execFileSync } from "child_process";
import { readFileSync } from "fs";
import { basename, dirname, join, resolve, sep } from "path";
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

    // A checkout with CRLF endings leaves a `\r` that `.` does not match, which would skip every
    // comment on Windows while CI, with LF, reads them all.
    for (const line of text.split(/\r?\n/)) {
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

// The files git tracks, relative to the repository root with `/`. The check reads these rather than
// the disk, so an untracked copy (an editor's worktree, a build output) can neither make a cited
// path look present nor add a doc to check, and the answer is the same locally and in CI.
function trackedFiles(repoRoot) {
    return execFileSync("git", ["ls-files", "-z"], { cwd: repoRoot, encoding: "utf-8" })
        .split("\0")
        .filter(Boolean);
}

function toPosix(path) {
    return path.split(sep).join("/");
}

// An `exists` over the tracked tree. A reference written with a trailing `/` names a folder, and a
// folder is all it can match.
function existsIn(files, folders) {
    return (path) => {
        const posix = toPosix(path);
        const wantsFolder = posix.endsWith("/");
        const trimmed = posix.replace(/\/+$/, "");

        return wantsFolder ? folders.has(trimmed) : files.has(trimmed) || folders.has(trimmed);
    };
}

export function findProblems(repoRoot) {
    const files = trackedFiles(repoRoot);
    const fileSet = new Set(files);
    const folders = new Set();

    for (const file of files) {
        for (let folder = posixDirname(file); folder !== "."; folder = posixDirname(folder)) {
            folders.add(folder);
        }
    }

    const exists = existsIn(fileSet, folders);
    const known = [...files, ...folders];
    const problems = [];

    const docs = files.filter(
        (file) => file.endsWith(".md") && !SKIPPED_DOCS.some((skipped) => file.startsWith(skipped))
    );

    for (const doc of docs) {
        for (const reference of markdownReferences(readFileSync(join(repoRoot, doc), "utf-8"))) {
            if (!resolves(reference, exists, known)) {
                problems.push(`${doc} cites \`${reference}\`, which does not exist`);
            }
        }
    }

    const rustPrefix = "src-tauri/src/";
    const modules = [];

    for (const file of files) {
        if (!file.startsWith(rustPrefix) || !file.endsWith(".rs")) {
            continue;
        }

        const rel = file.slice(rustPrefix.length);

        for (const reference of rustCommentReferences(readFileSync(join(repoRoot, file), "utf-8"))) {
            if (!resolves(reference, exists, known)) {
                problems.push(`${file} cites \`${reference}\`, which does not exist`);
            }
        }

        if (!TEST_FILE_NAMES.has(basename(rel)) && !rel.split("/").includes("tests")) {
            modules.push(rel);
        }
    }

    const architecture = readFileSync(join(repoRoot, "docs", "ARCHITECTURE.md"), "utf-8");

    for (const module of unlistedModules(modules, architecture)) {
        problems.push(`src-tauri/src/${module} is not named in docs/ARCHITECTURE.md`);
    }

    return problems;
}

function posixDirname(path) {
    const index = path.lastIndexOf("/");
    return index < 0 ? "." : path.slice(0, index);
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
