import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAppUpdate } from "./use-app-update";
import {
    checkAppUpdate,
    installAppUpdate,
    toAppUpdateInfo,
    type AppUpdateInfo,
} from "../services/app-update-service";
import { logError } from "../utils/app-logger";

vi.mock("../services/app-update-service", () => ({
    checkAppUpdate: vi.fn(),
    installAppUpdate: vi.fn(),
    toAppUpdateInfo: vi.fn(),
}));

vi.mock("../utils/app-logger", () => ({
    logError: vi.fn(),
}));

const checkAppUpdateMock = vi.mocked(checkAppUpdate);
const installAppUpdateMock = vi.mocked(installAppUpdate);
const toAppUpdateInfoMock = vi.mocked(toAppUpdateInfo);
const logErrorMock = vi.mocked(logError);

function createUpdate(overrides: Partial<Record<string, unknown>> = {}) {
    return {
        currentVersion: "1.0.0",
        version: "1.1.0",
        date: "2026-01-01",
        body: "release notes",
        downloadAndInstall: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
        ...overrides,
    } as unknown as Parameters<typeof installAppUpdate>[0];
}

function createUpdateInfo(overrides: Partial<AppUpdateInfo> = {}): AppUpdateInfo {
    return {
        currentVersion: "1.0.0",
        version: "1.1.0",
        date: "2026-01-01",
        body: "release notes",
        ...overrides,
    };
}

describe("useAppUpdate", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("starts in idle state with no update info, progress or error", () => {
        const { result } = renderHook(() => useAppUpdate());

        expect(result.current.status).toBe("idle");
        expect(result.current.updateInfo).toBeNull();
        expect(result.current.progress).toBeNull();
        expect(result.current.errorMessage).toBe("");
    });

    it("transitions to available with update info when an update exists", async () => {
        const update = createUpdate();
        checkAppUpdateMock.mockResolvedValueOnce(update);
        toAppUpdateInfoMock.mockReturnValueOnce(createUpdateInfo());

        const { result } = renderHook(() => useAppUpdate());

        await act(async () => {
            await result.current.checkForUpdate();
        });

        expect(toAppUpdateInfoMock).toHaveBeenCalledWith(update);
        expect(result.current.status).toBe("available");
        expect(result.current.updateInfo).toEqual(createUpdateInfo());
        expect(result.current.errorMessage).toBe("");
    });

    it("transitions to not-available and clears update info when there is no update", async () => {
        checkAppUpdateMock.mockResolvedValueOnce(null);

        const { result } = renderHook(() => useAppUpdate());

        await act(async () => {
            await result.current.checkForUpdate();
        });

        expect(result.current.status).toBe("not-available");
        expect(result.current.updateInfo).toBeNull();
        expect(toAppUpdateInfoMock).not.toHaveBeenCalled();
    });

    it("sets an error state with the exact user-facing message when checking fails", async () => {
        const error = new Error("network down");
        checkAppUpdateMock.mockRejectedValueOnce(error);

        const { result } = renderHook(() => useAppUpdate());

        await act(async () => {
            await result.current.checkForUpdate();
        });

        expect(result.current.status).toBe("error");
        expect(result.current.errorMessage).toBe("Could not check for updates.");
        expect(result.current.updateInfo).toBeNull();
        expect(logErrorMock).toHaveBeenCalledWith(
            "app-update",
            "Failed to check app update.",
            error
        );
    });

    it("resets the error message when a new check starts after a previous error", async () => {
        checkAppUpdateMock.mockRejectedValueOnce(new Error("boom"));

        const { result } = renderHook(() => useAppUpdate());

        await act(async () => {
            await result.current.checkForUpdate();
        });

        expect(result.current.errorMessage).toBe("Could not check for updates.");

        checkAppUpdateMock.mockResolvedValueOnce(null);

        await act(async () => {
            await result.current.checkForUpdate();
        });

        expect(result.current.errorMessage).toBe("");
        expect(result.current.status).toBe("not-available");
    });

    it("does nothing when installUpdate is called with no update available", async () => {
        const { result } = renderHook(() => useAppUpdate());

        await act(async () => {
            await result.current.installUpdate();
        });

        expect(result.current.status).toBe("idle");
        expect(installAppUpdateMock).not.toHaveBeenCalled();
    });

    it("installs the update, reports download progress and reaches installed", async () => {
        const update = createUpdate();
        checkAppUpdateMock.mockResolvedValueOnce(update);
        toAppUpdateInfoMock.mockReturnValueOnce(createUpdateInfo());

        installAppUpdateMock.mockImplementationOnce(async (_update, onProgress) => {
            onProgress?.({ downloaded: 50, total: 100, percent: 50 });
        });

        const { result } = renderHook(() => useAppUpdate());

        await act(async () => {
            await result.current.checkForUpdate();
        });

        await act(async () => {
            await result.current.installUpdate();
        });

        expect(installAppUpdateMock).toHaveBeenCalledWith(update, expect.any(Function));
        expect(result.current.status).toBe("installed");
        expect(result.current.progress).toEqual({ downloaded: 50, total: 100, percent: 50 });
        expect(result.current.errorMessage).toBe("");
    });

    it("sets an error state with the exact user-facing message when installing fails", async () => {
        const update = createUpdate();
        checkAppUpdateMock.mockResolvedValueOnce(update);
        toAppUpdateInfoMock.mockReturnValueOnce(createUpdateInfo());

        const error = new Error("disk full");
        installAppUpdateMock.mockRejectedValueOnce(error);

        const { result } = renderHook(() => useAppUpdate());

        await act(async () => {
            await result.current.checkForUpdate();
        });

        await act(async () => {
            await result.current.installUpdate();
        });

        expect(result.current.status).toBe("error");
        expect(result.current.errorMessage).toBe("Could not install the update.");
        expect(logErrorMock).toHaveBeenCalledWith(
            "app-update",
            "Failed to install app update.",
            error
        );
    });

    it("resets the error message and recovers when retrying installUpdate after a failure", async () => {
        const update = createUpdate();
        checkAppUpdateMock.mockResolvedValueOnce(update);
        toAppUpdateInfoMock.mockReturnValueOnce(createUpdateInfo());
        installAppUpdateMock.mockRejectedValueOnce(new Error("first failure"));

        const { result } = renderHook(() => useAppUpdate());

        await act(async () => {
            await result.current.checkForUpdate();
        });

        await act(async () => {
            await result.current.installUpdate();
        });

        expect(result.current.errorMessage).toBe("Could not install the update.");

        installAppUpdateMock.mockResolvedValueOnce(undefined);

        await act(async () => {
            await result.current.installUpdate();
        });

        expect(result.current.errorMessage).toBe("");
        expect(result.current.status).toBe("installed");
    });

    it("recreates installUpdate after checkForUpdate loads a real update (kills [update] -> [] dep mutant)", async () => {
        const update = createUpdate();
        checkAppUpdateMock.mockResolvedValueOnce(update);
        toAppUpdateInfoMock.mockReturnValueOnce(createUpdateInfo());
        installAppUpdateMock.mockResolvedValueOnce(undefined);

        const { result } = renderHook(() => useAppUpdate());

        const installBeforeCheck = result.current.installUpdate;

        await act(async () => {
            await result.current.checkForUpdate();
        });

        const installAfterCheck = result.current.installUpdate;

        expect(installAfterCheck).not.toBe(installBeforeCheck);

        await act(async () => {
            await installAfterCheck();
        });

        expect(installAppUpdateMock).toHaveBeenCalledWith(update, expect.any(Function));
        expect(result.current.status).toBe("installed");
    });
});
