import { beforeEach, describe, expect, it, vi } from "vitest";
import { openFileDialog, openUrl } from "../lib/tauri-platform";
import { invokeCommand, invokeVoid, streamLibraryVerification } from "../lib/tauri-client";
import { TAURI_COMMANDS } from "../constants/tauri-commands";
import {
    cancelLibraryVerification,
    chooseLibraryDirectory,
    ensureDirectoryExists,
    getLibrarySummary,
    isDirectoryEmpty,
    migrateLibraryDirectory,
    openExternalUrl,
    openFileLocation,
    openLibraryDirectory,
    openLogDirectory,
    resolveExistingDirectory,
    verifyLibraryContent,
} from "./library-service";

vi.mock("../lib/tauri-platform", () => ({
    openUrl: vi.fn(),
    openFileDialog: vi.fn(),
}));

vi.mock("../lib/tauri-client", () => ({
    invokeVoid: vi.fn(),
    invokeCommand: vi.fn(),
    streamLibraryVerification: vi.fn(),
}));

vi.mock("../utils/app-logger", () => ({
    logError: vi.fn(),
}));

const openUrlMock = vi.mocked(openUrl);
const invokeVoidMock = vi.mocked(invokeVoid);

describe("openExternalUrl", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        openUrlMock.mockResolvedValue(null as never);
    });

    it("opens https urls", async () => {
        await openExternalUrl("https://www.youtube.com/watch?v=abc");
        expect(openUrlMock).toHaveBeenCalledWith("https://www.youtube.com/watch?v=abc");
    });

    it("opens http urls", async () => {
        await openExternalUrl("http://example.com/");
        expect(openUrlMock).toHaveBeenCalledWith("http://example.com/");
    });

    it("rejects non-http schemes without opening them", async () => {
        for (const url of ["file:///etc/passwd", "javascript:alert(1)", "ftp://host/x"]) {
            await expect(openExternalUrl(url)).rejects.toThrow();
        }

        expect(openUrlMock).not.toHaveBeenCalled();
    });

    it("rejects empty and malformed urls", async () => {
        await expect(openExternalUrl("   ")).rejects.toThrow("URL is required.");
        await expect(openExternalUrl("not a url")).rejects.toThrow("Invalid URL.");

        expect(openUrlMock).not.toHaveBeenCalled();
    });
});

describe("openLogDirectory", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        invokeVoidMock.mockResolvedValue(undefined);
    });

    it("invokes the log-directory command", async () => {
        await openLogDirectory();

        expect(invokeVoidMock).toHaveBeenCalledTimes(1);
        expect(invokeVoidMock).toHaveBeenCalledWith(TAURI_COMMANDS.OPEN_LOG_DIRECTORY);
    });

    it("sends no arguments at all", async () => {
        // The security property of this command, asserted rather than left to the signature. The
        // backend resolves the log directory from `app_log_dir()` precisely so there is no path for
        // a caller to redirect; a second argument appearing here would mean a path had been
        // reintroduced on the way in, which is the change that should have to delete this test.
        await openLogDirectory();

        const [command, ...rest] = invokeVoidMock.mock.calls[0] ?? [];

        expect(command).toBe(TAURI_COMMANDS.OPEN_LOG_DIRECTORY);
        expect(rest).toEqual([]);
    });

    it("propagates a failure to the caller", async () => {
        // The hook above it turns this into a user-facing notice; swallowing it here would leave a
        // button that silently does nothing, which is the whole failure mode worth avoiding.
        invokeVoidMock.mockRejectedValueOnce(new Error("no file manager"));

        await expect(openLogDirectory()).rejects.toThrow("no file manager");
    });
});

const invokeCommandMock = vi.mocked(invokeCommand);

describe("directory commands", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("trims the path, sends it as `path` and trims what comes back", async () => {
        invokeCommandMock.mockResolvedValue("  D:/Library  " as never);

        await expect(ensureDirectoryExists("  D:/Library ")).resolves.toBe("D:/Library");
        await expect(resolveExistingDirectory(" D:/Library")).resolves.toBe("D:/Library");

        expect(invokeCommandMock.mock.calls).toEqual([
            [TAURI_COMMANDS.ENSURE_DIRECTORY_EXISTS, { path: "D:/Library" }],
            [TAURI_COMMANDS.RESOLVE_EXISTING_DIRECTORY, { path: "D:/Library" }],
        ]);
    });

    it("asks whether a directory is empty", async () => {
        invokeCommandMock.mockResolvedValueOnce(true as never);

        await expect(isDirectoryEmpty(" D:/New ")).resolves.toBe(true);
        expect(invokeCommandMock).toHaveBeenCalledWith(TAURI_COMMANDS.IS_DIRECTORY_EMPTY, {
            path: "D:/New",
        });
    });

    it("refuses an empty path before reaching the backend", async () => {
        await expect(ensureDirectoryExists("  ")).rejects.toThrow("Directory path is required.");
        await expect(resolveExistingDirectory("")).rejects.toThrow("Directory path is required.");
        await expect(isDirectoryEmpty(" ")).rejects.toThrow("Directory path is required.");

        expect(invokeCommandMock).not.toHaveBeenCalled();
    });
});

describe("migrateLibraryDirectory", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("sends the two paths under the keys the backend reads and returns its result", async () => {
        // The backend treats oldLibraryPath as the configured library and newLibraryPath as the
        // destination. Swapping the two keys would ask it to move the library the other way.
        const result = { library_path: "E:/Library", changed: true, old_directory_retained: false };
        invokeCommandMock.mockResolvedValueOnce(result as never);

        await expect(migrateLibraryDirectory(" D:/Library ", " E:/Library ")).resolves.toBe(result);
        expect(invokeCommandMock).toHaveBeenCalledWith(TAURI_COMMANDS.MIGRATE_LIBRARY_DIRECTORY, {
            oldLibraryPath: "D:/Library",
            newLibraryPath: "E:/Library",
        });
    });

    it("refuses a missing path on either side before reaching the backend", async () => {
        await expect(migrateLibraryDirectory("", "E:/Library")).rejects.toThrow(
            "Current library path is required."
        );
        await expect(migrateLibraryDirectory("D:/Library", " ")).rejects.toThrow(
            "New library path is required."
        );

        expect(invokeCommandMock).not.toHaveBeenCalled();
    });
});

describe("getLibrarySummary", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("returns an empty summary without asking the backend when no library is set", async () => {
        await expect(getLibrarySummary("  ")).resolves.toEqual({
            total_bytes: 0,
            formatted_size: "0 B",
            video_files: 0,
            audio_files: 0,
            thumbnail_files: 0,
        });
        expect(invokeCommandMock).not.toHaveBeenCalled();
    });

    it("sends the library as `libraryPath` and fills in what the backend left out", async () => {
        invokeCommandMock.mockResolvedValueOnce({
            total_bytes: 2048,
            formatted_size: "  ",
            video_files: 3,
        } as never);

        await expect(getLibrarySummary(" D:/Library ")).resolves.toEqual({
            total_bytes: 2048,
            formatted_size: "0 B",
            video_files: 3,
            audio_files: 0,
            thumbnail_files: 0,
        });
        expect(invokeCommandMock).toHaveBeenCalledWith(TAURI_COMMANDS.GET_LIBRARY_SUMMARY, {
            libraryPath: "D:/Library",
        });
    });

    it("lets a backend failure reach the caller", async () => {
        invokeCommandMock.mockRejectedValueOnce({ code: "INVALID_LIBRARY_PATH" });

        await expect(getLibrarySummary("D:/Library")).rejects.toMatchObject({
            code: "INVALID_LIBRARY_PATH",
        });
    });
});

describe("opening paths in the file manager", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("checks the library exists, then opens it as its own library", async () => {
        invokeCommandMock.mockResolvedValueOnce("D:/Library" as never);

        await openLibraryDirectory(" D:/Library ");

        expect(invokeCommandMock).toHaveBeenCalledWith(TAURI_COMMANDS.RESOLVE_EXISTING_DIRECTORY, {
            path: "D:/Library",
        });
        expect(invokeVoidMock).toHaveBeenCalledWith(TAURI_COMMANDS.OPEN_PATH_IN_SYSTEM, {
            path: "D:/Library",
            libraryPath: "D:/Library",
        });
    });

    it("does not open a library that no longer exists", async () => {
        invokeCommandMock.mockRejectedValueOnce({ code: "INVALID_DIRECTORY_PATH" });

        await expect(openLibraryDirectory("D:/Gone")).rejects.toMatchObject({
            code: "INVALID_DIRECTORY_PATH",
        });
        expect(invokeVoidMock).not.toHaveBeenCalled();
    });

    it("opens a file location with the library it has to stay inside", async () => {
        // The backend confines `path` to `libraryPath`, so both have to arrive.
        await openFileLocation(" video/media_abc.mp4 ", " D:/Library ");

        expect(invokeVoidMock).toHaveBeenCalledWith(TAURI_COMMANDS.OPEN_PATH_IN_SYSTEM, {
            path: "video/media_abc.mp4",
            libraryPath: "D:/Library",
        });
    });

    it("refuses to open a location without both paths", async () => {
        await expect(openFileLocation("", "D:/Library")).rejects.toThrow("Path is required.");
        await expect(openFileLocation("video/a.mp4", " ")).rejects.toThrow(
            "Library path is required."
        );
        await expect(openLibraryDirectory(" ")).rejects.toThrow("Library path is required.");

        expect(invokeVoidMock).not.toHaveBeenCalled();
    });
});

describe("library verification", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("streams the verification for the trimmed library path", async () => {
        const report = { checked: 0 };
        vi.mocked(streamLibraryVerification).mockResolvedValueOnce(report as never);
        const onProgress = vi.fn();

        await expect(verifyLibraryContent(" D:/Library ", onProgress)).resolves.toBe(report);
        expect(streamLibraryVerification).toHaveBeenCalledWith("D:/Library", onProgress);
    });

    it("refuses to verify without a library", async () => {
        await expect(verifyLibraryContent("  ", vi.fn())).rejects.toThrow(
            "A library folder is required."
        );
        expect(streamLibraryVerification).not.toHaveBeenCalled();
    });

    it("asks a running verification to stop", async () => {
        await cancelLibraryVerification();

        expect(invokeVoidMock).toHaveBeenCalledWith(TAURI_COMMANDS.CANCEL_LIBRARY_VERIFICATION);
    });
});

describe("chooseLibraryDirectory", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("returns the trimmed folder, or null when nothing usable was picked", async () => {
        vi.mocked(openFileDialog).mockResolvedValueOnce(" D:/Library ");
        await expect(chooseLibraryDirectory()).resolves.toBe("D:/Library");
        expect(openFileDialog).toHaveBeenCalledWith({ directory: true, multiple: false });

        vi.mocked(openFileDialog).mockResolvedValueOnce(null);
        await expect(chooseLibraryDirectory()).resolves.toBeNull();

        vi.mocked(openFileDialog).mockResolvedValueOnce("  ");
        await expect(chooseLibraryDirectory()).resolves.toBeNull();
    });
});
