import { describe, expect, it } from "vitest";
import { findBrokenSentences } from "./verify-comment-sentences.js";

describe("findBrokenSentences", () => {
    it("flags a sentence that ends on one line and continues in lowercase on the next", () => {
        const source = [
            "    // The failure path has to clean up while still holding that lock.",
            "    // taking it a second time would deadlock.",
        ].join("\n");

        expect(findBrokenSentences(source)).toEqual([
            {
                line: 1,
                end: "The failure path has to clean up while still holding that lock.",
                next: "taking it a second time would deadlock.",
            },
        ]);
    });

    it("reads doc comments and block comment lines too", () => {
        expect(findBrokenSentences("/// Kept on purpose.\n/// otherwise it reads wrong.")).toHaveLength(1);
        expect(findBrokenSentences(" * Kept on purpose.\n * otherwise it reads wrong.")).toHaveLength(1);
    });

    it("leaves a next line that starts a new sentence or a joined clause alone", () => {
        expect(findBrokenSentences("// One sentence.\n// Another one.")).toEqual([]);
        expect(findBrokenSentences("// One clause,\n// and another.")).toEqual([]);
    });

    it("leaves names, labels and directives that start lowercase on purpose alone", () => {
        for (const next of [
            "yt-dlp prints several a second.",
            "path-surface: an absolute path in local-import mode.",
            "`desc` keeps the group key.",
            "eslint-disable-next-line no-control-regex",
        ]) {
            expect(findBrokenSentences(`// The line before.\n// ${next}`)).toEqual([]);
        }
    });

    it("leaves abbreviations and file names at the end of a line alone", () => {
        expect(findBrokenSentences("// A sink, e.g.\n// a log line.")).toEqual([]);
        expect(findBrokenSentences("// See cleanup.rs.\n// see also guard.rs.")).toEqual([]);
    });

    it("ignores code lines, which are not prose", () => {
        expect(findBrokenSentences("let value = a.\n    method();")).toEqual([]);
    });
});
