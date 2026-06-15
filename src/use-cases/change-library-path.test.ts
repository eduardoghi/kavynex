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
});