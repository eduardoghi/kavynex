import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../services/library-service", () => ({
    chooseLibraryDirectory: vi.fn(),
    ensureDirectoryExists: vi.fn(),
    migrateLibraryDirectory: vi.fn(),
}));

import {
    chooseLibraryDirectory,
    ensureDirectoryExists,
    migrateLibraryDirectory,
} from "../services/library-service";
import { moveLibrary, planChangeLibraryPath } from "./change-library-path";

const chooseLibraryDirectoryMock = vi.mocked(chooseLibraryDirectory);
const ensureDirectoryExistsMock = vi.mocked(ensureDirectoryExists);
const migrateLibraryDirectoryMock = vi.mocked(migrateLibraryDirectory);

describe("planChangeLibraryPath", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("changes nothing when the user cancels the dialog", async () => {
        chooseLibraryDirectoryMock.mockResolvedValueOnce(null);

        await expect(planChangeLibraryPath({ currentLibraryPath: "/library" })).resolves.toEqual({
            kind: "unchanged",
        });
        expect(ensureDirectoryExistsMock).not.toHaveBeenCalled();
    });

    it("changes nothing when the selected path is whitespace only", async () => {
        chooseLibraryDirectoryMock.mockResolvedValueOnce("   ");

        await expect(planChangeLibraryPath({ currentLibraryPath: "/library" })).resolves.toEqual({
            kind: "unchanged",
        });
        expect(ensureDirectoryExistsMock).not.toHaveBeenCalled();
    });

    it("changes nothing when the chosen folder is the current one", async () => {
        chooseLibraryDirectoryMock.mockResolvedValueOnce("/library");
        ensureDirectoryExistsMock.mockResolvedValueOnce("/library");

        await expect(
            planChangeLibraryPath({ currentLibraryPath: "  /library  " })
        ).resolves.toEqual({ kind: "unchanged" });
    });

    it("uses the folder as it is when there is no library yet", async () => {
        chooseLibraryDirectoryMock.mockResolvedValueOnce("/backup-library");
        ensureDirectoryExistsMock.mockResolvedValueOnce("/backup-library");

        await expect(planChangeLibraryPath({ currentLibraryPath: "" })).resolves.toEqual({
            kind: "apply",
            finalLibraryPath: "/backup-library",
        });
        expect(migrateLibraryDirectoryMock).not.toHaveBeenCalled();
    });

    it("asks to move an existing library instead of moving it right away", async () => {
        chooseLibraryDirectoryMock.mockResolvedValueOnce(" /new-library ");
        ensureDirectoryExistsMock.mockResolvedValueOnce("/new-library");

        await expect(planChangeLibraryPath({ currentLibraryPath: "/library" })).resolves.toEqual({
            kind: "move",
            currentLibraryPath: "/library",
            destination: "/new-library",
        });
        expect(ensureDirectoryExistsMock).toHaveBeenCalledWith("/new-library");
        expect(migrateLibraryDirectoryMock).not.toHaveBeenCalled();
    });

    it("rejects a Windows drive root selection without touching the filesystem", async () => {
        chooseLibraryDirectoryMock.mockResolvedValueOnce("C:\\");

        await expect(planChangeLibraryPath({ currentLibraryPath: "/library" })).rejects.toThrow(
            "A drive or volume root cannot be used as the library folder. Choose a regular folder instead."
        );
        expect(ensureDirectoryExistsMock).not.toHaveBeenCalled();
    });

    it("rejects a UNC share root selection", async () => {
        chooseLibraryDirectoryMock.mockResolvedValueOnce("\\\\server\\share");

        await expect(planChangeLibraryPath({ currentLibraryPath: "/library" })).rejects.toThrow(
            "A drive or volume root cannot be used as the library folder. Choose a regular folder instead."
        );
        expect(ensureDirectoryExistsMock).not.toHaveBeenCalled();
    });
});

describe("moveLibrary", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("moves the library and reports where it ended up", async () => {
        migrateLibraryDirectoryMock.mockResolvedValueOnce({
            final_library_path: "/new-library",
            changed: true,
            old_directory_retained: true,
        });

        await expect(
            moveLibrary({
                currentLibraryPath: "/library",
                destination: "/new-library",
                currentFolderUnreachable: false,
            })
        ).resolves.toEqual({
            changed: true,
            finalLibraryPath: "/new-library",
            oldDirectoryRetained: true,
        });
        expect(migrateLibraryDirectoryMock).toHaveBeenCalledWith("/library", "/new-library", {
            switchWithoutMoving: false,
        });
    });

    it("switches without moving once the user accepted that the current folder is unreachable", async () => {
        migrateLibraryDirectoryMock.mockResolvedValueOnce({
            final_library_path: "/new-library",
            changed: true,
            old_directory_retained: false,
        });

        await moveLibrary({
            currentLibraryPath: "/library",
            destination: "/new-library",
            currentFolderUnreachable: true,
        });

        expect(migrateLibraryDirectoryMock).toHaveBeenCalledWith("/library", "/new-library", {
            switchWithoutMoving: true,
        });
    });
});
