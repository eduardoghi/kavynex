// CI gate: fails when an `exclude_re` entry in src-tauri/.cargo/mutants.toml no longer matches any
// mutant cargo-mutants would generate.
//
// An exclusion that stops matching is silent in both directions, and both are bad. The mutant it
// used to suppress comes back and the weekly run turns red for a reason that has nothing to do with
// the tests, or, worse, the function it named was renamed and its *real* mutant is now unexcluded
// and unnoticed among the survivors, with nothing in the config to suggest the entry rather than the
// tests had gone stale.
//
// That is not hypothetical here. Two entries in that file have already died this way, both after a
// pure extraction moved the code they named: `replace < with <= in is_recent` (the comparison became
// `duration_is_recent`) and `in ensure_schema` (the guard became `needs_migration`). Both were found
// by hand, by someone deciding to check. Nothing in the pipeline was looking.
//
// The check is deliberately narrow. It answers "does this pattern still name something?" and not
// "is this exclusion still *justified*". The second needs the triage the file's comments record,
// which no script can do. What it removes is the failure where the answer to the first question
// silently became no.
//
// Run locally (needs cargo-mutants installed):
//     mapfile -t FILE_ARGS < <(node scripts/verify-mutants-exclusions.js --file-args)
//     cargo mutants --manifest-path src-tauri/Cargo.toml --list --no-config --colors never \
//         "${FILE_ARGS[@]}" > /tmp/mutants.txt
//     node scripts/verify-mutants-exclusions.js /tmp/mutants.txt
//
// The array is not cosmetic. `examine_globs` holds two directory globs (`db_backup/*.rs`,
// `db_schema/*.rs`), and interpolating the arguments unquoted lets the *shell* expand those into
// one path per file, which cargo-mutants then rejects, since `--file` takes a single value. One
// token per line plus `mapfile` keeps each glob intact and hands it to cargo-mutants to expand,
// which is the only expansion that matches what the real run scopes itself to.

import { readFileSync } from "fs";
import { resolve, dirname, join } from "path";
import { fileURLToPath } from "url";

// Pulls one `name = [ ... ]` array out of the TOML and returns its raw element strings, in document
// order. Hand-rolled rather than pulling in a TOML parser: this file is the only consumer, the two
// arrays it reads are plain lists of quoted strings, and a dependency added to a supply-chain-gated
// repository to read two arrays is a poor trade. Comment lines inside the array are skipped, which
// matters because mutants.toml is mostly comment (roughly 400 of its 600 lines), and several of
// those comments quote a pattern while explaining why it was removed.
function extractQuotedArray(tomlContent, name, quote) {
    const start = new RegExp(`^${name}\\s*=\\s*\\[`, "m").exec(tomlContent);

    if (!start) {
        return null;
    }

    const from = start.index + start[0].length;
    const end = tomlContent.indexOf("\n]", from);

    if (end === -1) {
        return null;
    }

    const values = [];

    for (const line of tomlContent.slice(from, end).split(/\r?\n/)) {
        const trimmed = line.trim();

        if (trimmed.startsWith("#")) {
            continue;
        }

        // One value per line is the shape this file uses throughout. Anything else is not something
        // to guess at, so it simply yields nothing rather than a half-parsed pattern.
        const match = new RegExp(`^${quote}(.*)${quote},?$`).exec(trimmed);

        if (match) {
            values.push(match[1]);
        }
    }

    return values;
}

// The `exclude_re` patterns, as written (single-quoted TOML literal strings, so no escape
// processing. What is between the quotes is the regex).
export function parseExcludePatterns(tomlContent) {
    return extractQuotedArray(tomlContent, "exclude_re", "'");
}

// The `examine_globs` entries (double-quoted). Read so the caller can reconstruct the file scope on
// the command line: `--list` has to run with `--no-config` here, since a run that applied the config
// would already have removed every mutant the exclusions name, leaving nothing to match against and
// making this gate pass vacuously. `--no-config` also drops `examine_globs`, so it is passed back in
// as `--file` arguments, from this same list, so the scope the check sees cannot drift from the
// scope the real run uses.
export function parseExamineGlobs(tomlContent) {
    return extractQuotedArray(tomlContent, "examine_globs", '"');
}

// Strips the ANSI colour sequences cargo-mutants writes into `--list` output when colour is on.
//
// This is not defensive tidying, it is the fix for a real false failure. cargo-mutants honours
// `CARGO_TERM_COLOR`, which `mutation.yml` sets to `always` at the workflow level, and it colourizes
// the *function name and the replacement* inside each mutant description, so the line reads
// `replace <esc>[38;5;13mpin_process_start<esc>[0m with <esc>[33m()<esc>[0m` rather than
// `replace pin_process_start with ()`. Every pattern here names a function, so every pattern whose
// text spans one of those boundaries stops matching, and the gate reports it as an exclusion that
// no longer names a mutant.
//
// That is exactly backwards, and expensively so: it fired on this check's first ever run
// (2026-08-03) against twenty-six live patterns, and the obvious response to a red run (delete the
// exclusions it names) would have silently unexcluded twenty-six real mutants in the security
// modules this gate exists to protect. The workflow now also passes `--colors never`, but the
// stripping stays: this function's contract is "given a `cargo mutants --list` output, which
// patterns are dead", and a caller who produced that output with colour on deserves the right
// answer rather than an inverted one.
function stripAnsi(value) {
    // eslint-disable-next-line no-control-regex
    return value.replace(/\u001b\[[0-9;]*m/g, "");
}

// Which patterns match nothing in `mutantList`, and which could not be compiled at all.
//
// The regex flavors are not identical (cargo-mutants uses the Rust `regex` crate and this runs in
// JavaScript), so a pattern that JavaScript refuses is reported as its own outcome rather than
// silently counted as dead. Every pattern in the file today is plain enough that the two agree
// (character classes, alternation, escaped parens and pipes). A future one that needs a
// Rust-specific construct should show up here as a question to answer, not as a false failure.
export function findDeadPatterns(patterns, mutantList) {
    const lines = stripAnsi(mutantList)
        .split(/\r?\n/)
        .filter((line) => line.trim().length > 0);
    const dead = [];
    const uncompilable = [];

    for (const pattern of patterns) {
        let expression;

        try {
            expression = new RegExp(pattern);
        } catch (error) {
            uncompilable.push({ pattern, reason: error.message });
            continue;
        }

        if (!lines.some((line) => expression.test(line))) {
            dead.push(pattern);
        }
    }

    return { dead, uncompilable };
}

// Decides the gate from the raw file contents, returning `{ ok, message }` rather than reading files
// or exiting itself. The same shape as the other verify-* scripts, so the wording and every refusal
// branch are unit-testable without a cargo-mutants run.
export function verifyMutantsExclusions({ tomlContent, mutantList }) {
    const patterns = parseExcludePatterns(tomlContent);

    if (patterns === null) {
        return {
            ok: false,
            message:
                "No exclude_re array was found in mutants.toml. If the key was renamed or removed, update this check. If it was not, the parse above is wrong and this gate is verifying nothing.",
        };
    }

    // An empty list is a legitimate state (every exclusion triaged away), but a list this check
    // reads as empty when the file plainly has one is the vacuous pass worth refusing. The
    // difference is not observable from here, so an empty list simply reports what it saw.
    if (patterns.length === 0) {
        return { ok: true, message: "mutants.toml declares no exclude_re patterns to verify." };
    }

    const trimmedList = mutantList.trim();

    if (!trimmedList) {
        return {
            ok: false,
            message:
                "The mutant list is empty, so every pattern would read as dead. Check that `cargo mutants --list --no-config` ran with the examine_globs passed back as --file arguments.",
        };
    }

    const { dead, uncompilable } = findDeadPatterns(patterns, mutantList);

    if (uncompilable.length > 0) {
        return {
            ok: false,
            message:
                "An exclude_re pattern is not a valid JavaScript regular expression, so this gate cannot judge it. Rewrite it in a form both flavors accept, or teach this script the construct:\n" +
                uncompilable
                    .map(({ pattern, reason }) => `  - ${pattern}\n    ${reason}`)
                    .join("\n"),
        };
    }

    if (dead.length > 0) {
        return {
            ok: false,
            message:
                "An exclude_re pattern in src-tauri/.cargo/mutants.toml matches no mutant. The function it names was probably renamed, moved or extracted, so the exclusion suppresses nothing and the mutant it was written for is now unexcluded. Re-triage each one: either point it at the mutant's new description, or delete it because the code it covered is gone.\n" +
                dead.map((pattern) => `  - ${pattern}`).join("\n"),
        };
    }

    return {
        ok: true,
        message: `Every one of the ${patterns.length} exclude_re patterns still names a real mutant.`,
    };
}

// Only run the gate when invoked as a script, so the exports above stay unit-testable (importing
// this file must not read files or exit).
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"))) {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const tomlPath = join(root, "src-tauri", ".cargo", "mutants.toml");
    const tomlContent = readFileSync(tomlPath, "utf8");

    // `--file-args` prints the `--file <glob>` arguments the `--list` invocation needs, so the
    // workflow does not restate examine_globs and the two cannot disagree about the scope.
    //
    // One token per line, for the caller to read into a shell array. Printed on one line, the
    // directory globs in that list (`db_backup/*.rs`) would be expanded by the shell before
    // cargo-mutants ever saw them, and it rejects the several paths that produces because `--file`
    // takes one value.
    if (process.argv[2] === "--file-args") {
        const globs = parseExamineGlobs(tomlContent);

        if (globs === null || globs.length === 0) {
            console.error("No examine_globs array was found in mutants.toml.");
            process.exit(1);
        }

        console.log(globs.flatMap((glob) => ["--file", glob]).join("\n"));
    } else {
        const listPath = process.argv[2];

        if (!listPath) {
            console.error(
                "Usage: node scripts/verify-mutants-exclusions.js <cargo-mutants --list output file>"
            );
            process.exit(1);
        }

        const result = verifyMutantsExclusions({
            tomlContent,
            mutantList: readFileSync(listPath, "utf8"),
        });

        if (result.ok) {
            console.log(result.message);
        } else {
            console.error(result.message);
            process.exit(1);
        }
    }
}
