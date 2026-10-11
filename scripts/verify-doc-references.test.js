import { describe, expect, it } from "vitest";
import {
    asPathReference,
    markdownReferences,
    resolves,
    rustCommentReferences,
    unlistedModules,
} from "./verify-doc-references.js";

describe("asPathReference", () => {
    it("takes a path with a source or doc extension, or a folder", () => {
        expect(asPathReference("services/db_backup/import.rs")).toBe("services/db_backup/import.rs");
        expect(asPathReference("docs/DATABASE.md")).toBe("docs/DATABASE.md");
        expect(asPathReference("hooks/settings/")).toBe("hooks/settings/");
        expect(asPathReference("./scripts/before-build.js")).toBe("scripts/before-build.js");
    });

    it("drops what commonly trails a path in prose", () => {
        expect(asPathReference("lib.rs:373-388")).toBeNull();
        expect(asPathReference("services/logger.rs:72")).toBe("services/logger.rs");
        expect(asPathReference("commands/security.rs::managed_asset_scope_dirs")).toBe(
            "commands/security.rs"
        );
        expect(asPathReference("src/utils/youtube.ts),")).toBe("src/utils/youtube.ts");
    });

    it("skips what is not a citation of a file in this tree", () => {
        for (const token of [
            "kavynex.db",
            "video/media_abc.mp4",
            "kavynex.db.pre-migration-v<N>",
            "src/**/*.ts",
            "https://example.com/a.js",
            "/usr/bin/env.js",
            "C:/Users/a.md",
            "~/notes.md",
            "dir/sub/..",
        ]) {
            expect(asPathReference(token)).toBeNull();
        }
    });
});

describe("markdownReferences", () => {
    it("reads only what is in backticks", () => {
        const text = "See `docs/DATABASE.md` and services/logger.rs, or `kavynex.db`.";

        expect(markdownReferences(text)).toEqual(["docs/DATABASE.md"]);
    });
});

describe("rustCommentReferences", () => {
    it("reads comments, with or without backticks, and leaves code alone", () => {
        const text = [
            "/// Looks it up (`services/thumbnail/download.rs`), see",
            "// also thumbnail/temp.rs.",
            'let path = "services/not_a_comment.rs";',
        ].join("\n");

        expect(rustCommentReferences(text)).toEqual([
            "services/thumbnail/download.rs",
            "thumbnail/temp.rs",
        ]);
    });
});

describe("resolves", () => {
    const onDisk = new Set(["src-tauri/src/services/logger.rs", "src/hooks/home"]);
    const exists = (path) => onDisk.has(path.replace(/\\/g, "/"));

    it("finds a path under any of the roots", () => {
        expect(resolves("services/logger.rs", exists)).toBe(true);
        expect(resolves("logger.rs/missing.rs", exists)).toBe(false);
    });

    it("accepts the tail of a path that exists, and nothing shorter than a segment", () => {
        const known = ["src/hooks/home/use-home-media-actions.ts"];

        expect(resolves("home/use-home-media-actions.ts", exists, known)).toBe(true);
        expect(resolves("me/use-home-media-actions.ts", exists, known)).toBe(false);
    });
});

describe("unlistedModules", () => {
    const architecture = [
        "The flat files are `logger.rs` and `database.rs`.",
        "",
        "`db_backup/` holds `snapshot.rs` and `restore.rs`.",
        "",
        "`library/` holds `integrity.rs`.",
    ].join("\n");

    it("names a module that the architecture guide does not", () => {
        expect(
            unlistedModules(
                [
                    "services/logger.rs",
                    "services/media_protocol.rs",
                    "services/db_backup/snapshot.rs",
                    "services/db_backup/lineage.rs",
                    "main_window.rs",
                ],
                architecture
            )
        ).toEqual(["services/media_protocol.rs", "services/db_backup/lineage.rs", "main_window.rs"]);
    });

    it("needs a nested module named in a paragraph about its own folder", () => {
        expect(unlistedModules(["services/db_backup/integrity.rs"], architecture)).toEqual([
            "services/db_backup/integrity.rs",
        ]);
    });
});
