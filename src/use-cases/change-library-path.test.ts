import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../services/library-service", () => ({
    chooseLibraryDirectory: vi.fn(),
    ensureDirectoryExists: vi.fn(),
    isDirectoryEmpty: vi.fn(),
    migrateLibraryDirectory: vi.fn(),
}));

import {
    chooseLibraryDirectory,
    ensureDirectoryExists,
    isDirectoryEmpty,
    migrateLibraryDirectory,
} from "../services/library-service";
import { executeChangeLibraryPath } from "./change-library-path";

const chooseLibraryDirectoryMock = vi.mocked(chooseLibraryDirectory);
const ensureDirectoryExistsMock = vi.mocked(ensureDirectoryExists);
const isDirectoryEmptyMock = vi.mocked(isDirectoryEmpty);
const migrateLibraryDirectoryMock = vi.mocked(migrateLibraryDirectory);

describe("executeChangeLibraryPath", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("returns unchanged when user cancels selection", async () => {
        chooseLibraryDirectoryMock.mockResolvedValueOnce(null);

        const result = await executeChangeLibraryPath({
            currentLibraryPath: "/library",
        });

        expect(result).toEqual({
            changed: false,
            finalLibraryPath: "/library",
        });
        expect(ensureDirectoryExistsMock).not.toHaveBeenCalled();
        expect(isDirectoryEmptyMock).not.toHaveBeenCalled();
        expect(migrateLibraryDirectoryMock).not.toHaveBeenCalled();
    });

    it("returns the trimmed current path when the user cancels selection", async () => {
        chooseLibraryDirectoryMock.mockResolvedValueOnce(null);

        const result = await executeChangeLibraryPath({
            currentLibraryPath: "  /library  ",
        });

        expect(result).toEqual({
            changed: false,
            finalLibraryPath: "/library",
        });
    });

    it("returns unchanged when the selected path is whitespace only", async () => {
        chooseLibraryDirectoryMock.mockResolvedValueOnce("   ");

        const result = await executeChangeLibraryPath({
            currentLibraryPath: "/library",
        });

        expect(result).toEqual({
            changed: false,
            finalLibraryPath: "/library",
        });
        expect(ensureDirectoryExistsMock).not.toHaveBeenCalled();
        expect(isDirectoryEmptyMock).not.toHaveBeenCalled();
        expect(migrateLibraryDirectoryMock).not.toHaveBeenCalled();
    });

    it("returns unchanged when ensured path matches current path", async () => {
        chooseLibraryDirectoryMock.mockResolvedValueOnce("/library");
        ensureDirectoryExistsMock.mockResolvedValueOnce("/library");

        const result = await executeChangeLibraryPath({
            currentLibraryPath: "/library",
        });

        expect(isDirectoryEmptyMock).not.toHaveBeenCalled();
        expect(migrateLibraryDirectoryMock).not.toHaveBeenCalled();
        expect(result).toEqual({
            changed: false,
            finalLibraryPath: "/library",
        });
    });

    it("migrates when current path exists and a different path is selected", async () => {
        chooseLibraryDirectoryMock.mockResolvedValueOnce("/new-library");
        ensureDirectoryExistsMock.mockResolvedValueOnce("/new-library");
        isDirectoryEmptyMock.mockResolvedValueOnce(true);
        migrateLibraryDirectoryMock.mockResolvedValueOnce({
            final_library_path: "/new-library",
            changed: true,
        });

        const result = await executeChangeLibraryPath({
            currentLibraryPath: "/library",
        });

        expect(isDirectoryEmptyMock).toHaveBeenCalledWith("/new-library");
        expect(migrateLibraryDirectoryMock).toHaveBeenCalledWith(
            "/library",
            "/new-library"
        );
        expect(result).toEqual({
            changed: true,
            finalLibraryPath: "/new-library",
        });
    });

    it("uses ensured path directly when there is no current library path", async () => {
        chooseLibraryDirectoryMock.mockResolvedValueOnce("/new-library");
        ensureDirectoryExistsMock.mockResolvedValueOnce("/new-library");
        isDirectoryEmptyMock.mockResolvedValueOnce(true);

        const result = await executeChangeLibraryPath({
            currentLibraryPath: "",
        });

        expect(isDirectoryEmptyMock).toHaveBeenCalledWith("/new-library");
        expect(migrateLibraryDirectoryMock).not.toHaveBeenCalled();
        expect(result).toEqual({
            changed: true,
            finalLibraryPath: "/new-library",
        });
    });

    it("allows non-empty folder when there is no current library path", async () => {
        chooseLibraryDirectoryMock.mockResolvedValueOnce("/backup-library");
        ensureDirectoryExistsMock.mockResolvedValueOnce("/backup-library");
        isDirectoryEmptyMock.mockResolvedValueOnce(false);

        const result = await executeChangeLibraryPath({
            currentLibraryPath: "",
        });

        expect(migrateLibraryDirectoryMock).not.toHaveBeenCalled();
        expect(result).toEqual({
            changed: true,
            finalLibraryPath: "/backup-library",
        });
    });

    it("throws a specific error when selected folder is not empty", async () => {
        chooseLibraryDirectoryMock.mockResolvedValueOnce("/new-library");
        ensureDirectoryExistsMock.mockResolvedValueOnce("/new-library");
        isDirectoryEmptyMock.mockResolvedValueOnce(false);

        await expect(
            executeChangeLibraryPath({
                currentLibraryPath: "/library",
            })
        ).rejects.toThrow(
            "The selected folder must be empty before it can be used as the library folder."
        );

        expect(migrateLibraryDirectoryMock).not.toHaveBeenCalled();
    });

    it("rejects a Windows drive root selection without touching the filesystem", async () => {
        chooseLibraryDirectoryMock.mockResolvedValueOnce("C:\\");

        await expect(
            executeChangeLibraryPath({
                currentLibraryPath: "/library",
            })
        ).rejects.toThrow(
            "A drive or volume root cannot be used as the library folder. Choose a regular folder instead."
        );

        expect(ensureDirectoryExistsMock).not.toHaveBeenCalled();
        expect(isDirectoryEmptyMock).not.toHaveBeenCalled();
        expect(migrateLibraryDirectoryMock).not.toHaveBeenCalled();
    });

    it("rejects a UNC share root selection", async () => {
        chooseLibraryDirectoryMock.mockResolvedValueOnce("\\\\server\\share");

        await expect(
            executeChangeLibraryPath({
                currentLibraryPath: "/library",
            })
        ).rejects.toThrow(
            "A drive or volume root cannot be used as the library folder. Choose a regular folder instead."
        );

        expect(ensureDirectoryExistsMock).not.toHaveBeenCalled();
    });

    it("accepts a normal empty folder that is not a drive root", async () => {
        chooseLibraryDirectoryMock.mockResolvedValueOnce("C:\\Users\\bob\\Library");
        ensureDirectoryExistsMock.mockResolvedValueOnce("C:\\Users\\bob\\Library");
        isDirectoryEmptyMock.mockResolvedValueOnce(true);
        migrateLibraryDirectoryMock.mockResolvedValueOnce({
            final_library_path: "C:\\Users\\bob\\Library",
            changed: true,
        });

        const result = await executeChangeLibraryPath({
            currentLibraryPath: "/library",
        });

        expect(result).toEqual({
            changed: true,
            finalLibraryPath: "C:\\Users\\bob\\Library",
        });
    });
});