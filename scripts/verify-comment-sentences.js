// CI gate. Fails when a code comment ends a line with a period and the comment line after it starts
// with a lowercase word, which is a sentence joined in the wrong place rather than a new one.
//
// The pattern is what a mass rewrite of `;` into `.` left behind across about thirty comments
// ("...holding that lock. / taking it a second time would deadlock"), each reading as two broken
// sentences. Reviewing did not catch them, since each looks fine on its own line.
//
// What it does not flag is a next line whose first word is not a plain word. A name like `yt-dlp`,
// a label like `path-surface:` or anything in backticks starts lowercase on purpose, and so does an
// `eslint-disable` directive. Abbreviations ending in a period (e.g., i.e., etc.) are skipped too.

import { execFileSync } from "child_process";
import { readFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { isMainModule } from "./script-entry.js";

const COMMENT_LINE = /^\s*(?:\/\/[/!]?|\*)\s?(.*)$/;
const ENDS_A_SENTENCE = /[^.]\.$/;
const ABBREVIATION = /\b(?:e\.g|i\.e|etc|vs)\.$/;
const FILE_NAME = /\.[a-z]{2,4}\.$/;
const PLAIN_LOWERCASE_WORD = /^[a-z]{2,}(?=[\s,]|$)/;

// The broken joins in `content`, as `{ line, end, next }` with `line` 1-based.
export function findBrokenSentences(content) {
    const lines = content.split(/\r?\n/);
    const found = [];

    for (let index = 0; index < lines.length - 1; index++) {
        const current = lines[index].match(COMMENT_LINE);
        const next = lines[index + 1].match(COMMENT_LINE);

        if (!current || !next) {
            continue;
        }

        const end = current[1].trimEnd();
        const start = next[1];

        if (
            ENDS_A_SENTENCE.test(end) &&
            !ABBREVIATION.test(end) &&
            !FILE_NAME.test(end) &&
            PLAIN_LOWERCASE_WORD.test(start) &&
            !start.startsWith("eslint-disable")
        ) {
            found.push({ line: index + 1, end, next: start });
        }
    }

    return found;
}

const SCANNED = ["src", "src-tauri/src", "src-tauri/build.rs", "scripts", "e2e"];
const SOURCE_FILE = /\.(?:ts|tsx|rs|js)$/;

if (isMainModule(import.meta.url)) {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const files = execFileSync("git", ["ls-files", "--", ...SCANNED], { cwd: root, encoding: "utf8" })
        .split(/\r?\n/)
        .filter((file) => SOURCE_FILE.test(file));

    const problems = files.flatMap((file) =>
        findBrokenSentences(readFileSync(resolve(root, file), "utf8")).map(
            ({ line, end, next }) => `${file}:${line}\n    ${end.slice(-80)}\n    ${next.slice(0, 80)}`
        )
    );

    if (problems.length > 0) {
        console.error(
            "These comments end a sentence and continue it on the next line in lowercase. Join them with a comma, or start the next sentence with a capital letter:\n" +
                problems.join("\n")
        );
        process.exit(1);
    }

    console.log(`No broken sentence joins in the comments of ${files.length} source files.`);
}
