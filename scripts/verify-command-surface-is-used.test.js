import { describe, expect, it } from "vitest";
import {
    extractRegisteredCommands,
    extractCommandConstants,
    findCommandWrapper,
    findCallers,
    stripReExports,
    verifyCommandSurfaceIsUsed,
} from "./verify-command-surface-is-used.js";

// A miniature version of the real shape. Two commands, each registered, named by a constant,
// invoked by an exported wrapper, and called from a hook. Every refusal below is this baseline with
// exactly one thing broken, so a test that fails names the branch it broke.
function passingInput(overrides = {}) {
    return {
        handlerSource: `
            .invoke_handler(tauri::generate_handler![
                commands::videos::list_media_page,
                commands::library::open_path_in_system
            ])
        `,
        constantsSource: `
export const TAURI_COMMANDS = {
    LIST_MEDIA_PAGE: "list_media_page",
    OPEN_PATH_IN_SYSTEM: "open_path_in_system",
} as const;
        `,
        sources: [
            {
                name: "src/repositories/media-repository.ts",
                content: `
export async function listMediaPage(channelId) {
    return invokeCommand(TAURI_COMMANDS.LIST_MEDIA_PAGE, { channelId });
}
                `,
            },
            {
                name: "src/services/library-service.ts",
                content: `
export async function openPathInSystem(path) {
    await invokeVoid(TAURI_COMMANDS.OPEN_PATH_IN_SYSTEM, { path });
}
                `,
            },
            {
                name: "src/hooks/use-library.ts",
                content: `
import { listMediaPage } from "../repositories/media-repository";
import { openPathInSystem } from "../services/library-service";
export function useLibrary() {
    return { listMediaPage, openPathInSystem };
}
                `,
            },
        ],
        ...overrides,
    };
}

describe("extractRegisteredCommands", () => {
    it("reads every entry of the generate_handler list, including the last one without a comma", () => {
        // The trailing entry carries no comma, which is the shape a comma-anchored match would drop,
        // and dropping the last command silently is the direction that makes this gate under-report.
        expect(extractRegisteredCommands(passingInput().handlerSource)).toEqual([
            "list_media_page",
            "open_path_in_system",
        ]);
    });

    it("returns nothing when the handler list is not there", () => {
        expect(extractRegisteredCommands("fn main() {}")).toEqual([]);
    });
});

describe("extractCommandConstants", () => {
    it("pairs each constant with the command name it holds", () => {
        expect(extractCommandConstants(passingInput().constantsSource)).toEqual([
            { constant: "LIST_MEDIA_PAGE", command: "list_media_page" },
            { constant: "OPEN_PATH_IN_SYSTEM", command: "open_path_in_system" },
        ]);
    });
});

describe("findCommandWrapper", () => {
    it("finds the exported function the invoke sits in", () => {
        expect(findCommandWrapper("LIST_MEDIA_PAGE", passingInput().sources)).toEqual({
            file: "src/repositories/media-repository.ts",
            fn: "listMediaPage",
        });
    });

    it("takes the nearest exported function above the invoke, not the first in the file", () => {
        // A repository file holds many wrappers in a row. Matching the first export would attribute
        // every command in the file to it, and then a genuinely uncalled wrapper further down would
        // pass because the first one has callers.
        const sources = [
            {
                name: "src/repositories/media-repository.ts",
                content: `
export async function markMediaAsWatched(id) {
    return invokeVoid(TAURI_COMMANDS.MARK_MEDIA_AS_WATCHED, { id });
}

export async function listMediaPage(channelId) {
    return invokeCommand(TAURI_COMMANDS.LIST_MEDIA_PAGE, { channelId });
}
                `,
            },
        ];

        expect(findCommandWrapper("LIST_MEDIA_PAGE", sources)?.fn).toBe("listMediaPage");
    });

    it("reports a null function when the invoke is not inside an exported one", () => {
        const sources = [
            { name: "src/hooks/use-thing.ts", content: "invokeVoid(TAURI_COMMANDS.LIST_MEDIA_PAGE);" },
        ];

        expect(findCommandWrapper("LIST_MEDIA_PAGE", sources)).toEqual({
            file: "src/hooks/use-thing.ts",
            fn: null,
        });
    });

    it("answers null when nothing references the constant", () => {
        expect(findCommandWrapper("MISSING", passingInput().sources)).toBeNull();
    });
});

describe("findCallers", () => {
    it("does not count the defining file as a caller of its own wrapper", () => {
        // The whole gate rests on this. A wrapper's own file always mentions its name, so counting
        // it would make every wrapper look called.
        expect(
            findCallers("listMediaPage", "src/repositories/media-repository.ts", passingInput().sources)
        ).toEqual(["src/hooks/use-library.ts"]);
    });

    it("does not count a barrel that only re-exports the wrapper", () => {
        // How `delete_thumbnail_file` outlived its last caller by six weeks. src/services/index.ts
        // re-exported every service function, the gate saw the name there, and the wrapper passed
        // as called. Single-line, multi-line and star re-exports are all names without calls.
        const sources = passingInput().sources.filter(
            (file) => file.name !== "src/hooks/use-library.ts"
        );
        sources.push({
            name: "src/services/index.ts",
            content: `
export { openPathInSystem } from "./library-service";
export {
    listMediaPage,
} from "../repositories/media-repository";
export * from "./thumbnail-service";
            `,
        });

        expect(
            findCallers("listMediaPage", "src/repositories/media-repository.ts", sources)
        ).toEqual([]);
        expect(
            findCallers("openPathInSystem", "src/services/library-service.ts", sources)
        ).toEqual([]);
    });

    it("still counts a file that imports through a barrel and calls the wrapper", () => {
        // Stripping the barrel's lines must not cost a legitimate caller. The calling file names
        // the function in its own text, which is what the match reads.
        const sources = passingInput().sources.filter(
            (file) => file.name !== "src/hooks/use-library.ts"
        );
        sources.push(
            {
                name: "src/services/index.ts",
                content: `export { listMediaPage } from "../repositories/media-repository";`,
            },
            {
                name: "src/hooks/use-library.ts",
                content: `
import { listMediaPage } from "../services";
export function useLibrary() {
    return { listMediaPage };
}
                `,
            }
        );

        expect(
            findCallers("listMediaPage", "src/repositories/media-repository.ts", sources)
        ).toEqual(["src/hooks/use-library.ts"]);
    });
});

describe("stripReExports", () => {
    it("removes every re-export form and leaves the rest of the file alone", () => {
        const content = `
import { a } from "./a";
export { b, c } from "./bc";
export {
    d,
    e as f,
} from "./de";
export * from "./star";
export * as ns from "./ns";
export function g() {
    return b();
}
        `;

        const stripped = stripReExports(content);

        expect(stripped).not.toContain('from "./bc"');
        expect(stripped).not.toContain('from "./de"');
        expect(stripped).not.toContain('from "./star"');
        expect(stripped).not.toContain('from "./ns"');
        expect(stripped).toContain('import { a } from "./a";');
        expect(stripped).toContain("export function g()");
        expect(stripped).toContain("return b();");
    });
});

describe("verifyCommandSurfaceIsUsed", () => {
    it("passes when every registered command has a constant, a wrapper and a caller", () => {
        const result = verifyCommandSurfaceIsUsed(passingInput());

        expect(result.ok).toBe(true);
        expect(result.message).toContain("2 registered commands");
    });

    it("refuses a registered command whose wrapper nothing calls", () => {
        // This is the defect the gate was written for, in the exact shape it shipped in twice.
        // `cleanup_unreferenced_media_artifacts` and `delete_live_chat_file` were registered, had a
        // constant, had a wrapper, and had no caller anywhere in the app. Both unlinked files.
        const input = passingInput();
        input.sources = input.sources.filter((file) => file.name !== "src/hooks/use-library.ts");

        const result = verifyCommandSurfaceIsUsed(input);

        expect(result.ok).toBe(false);
        expect(result.message).toContain("listMediaPage()");
        expect(result.message).toContain("no caller");
    });

    it("refuses a registered command that no constant names", () => {
        const input = passingInput();
        input.constantsSource = input.constantsSource.replace(
            '    OPEN_PATH_IN_SYSTEM: "open_path_in_system",\n',
            ""
        );

        const result = verifyCommandSurfaceIsUsed(input);

        expect(result.ok).toBe(false);
        expect(result.message).toContain("open_path_in_system");
        expect(result.message).toContain("nothing in the app can call them");
    });

    it("refuses a constant naming a command that is not registered", () => {
        // The other direction, and it fails at runtime rather than silently. Invoking a command the
        // handler does not register comes back as an unknown-command error on the first click.
        const input = passingInput();
        input.handlerSource = input.handlerSource.replace(
            "                commands::library::open_path_in_system\n",
            ""
        );

        const result = verifyCommandSurfaceIsUsed(input);

        expect(result.ok).toBe(false);
        expect(result.message).toContain("does not register");
    });

    it("refuses a constant no file under src/ references", () => {
        const input = passingInput();
        input.sources = input.sources.filter(
            (file) => file.name !== "src/services/library-service.ts"
        );

        const result = verifyCommandSurfaceIsUsed(input);

        expect(result.ok).toBe(false);
        expect(result.message).toContain("no file under src/ references it");
    });

    it("refuses an invoke that is not inside an exported wrapper", () => {
        const input = passingInput();
        input.sources = input.sources.map((file) =>
            file.name === "src/services/library-service.ts"
                ? { ...file, content: "invokeVoid(TAURI_COMMANDS.OPEN_PATH_IN_SYSTEM, { path });" }
                : file
        );

        const result = verifyCommandSurfaceIsUsed(input);

        expect(result.ok).toBe(false);
        expect(result.message).toContain("not from inside an exported function");
    });

    it("refuses an empty handler list rather than passing vacuously", () => {
        // A scan that matched nothing would report success while checking nothing, which is the one
        // failure mode a gate must not have.
        const result = verifyCommandSurfaceIsUsed(passingInput({ handlerSource: "fn main() {}" }));

        expect(result.ok).toBe(false);
        expect(result.message).toContain("No command was found");
    });

    it("refuses an empty constant list rather than passing vacuously", () => {
        const result = verifyCommandSurfaceIsUsed(passingInput({ constantsSource: "export {};" }));

        expect(result.ok).toBe(false);
        expect(result.message).toContain("No command constant was found");
    });
});
