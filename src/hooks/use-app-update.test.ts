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

    it("lets the newest check win when two overlap and the older one resolves last", async () => {
        // The overlap this guards is not the double click the Settings button already disables: it
        // is a user-driven check racing the opt-in startup one (useStartupUpdateCheck), which the
        // button cannot see. Resolving the *first* call last is the ordering that made the stale
        // answer win before the guard existed.
        let resolveFirst: (value: null) => void = () => {};
        const firstCheck = new Promise<null>((resolve) => {
            resolveFirst = resolve;
        });

        const update = createUpdate();
        checkAppUpdateMock.mockReturnValueOnce(
            firstCheck as unknown as ReturnType<typeof checkAppUpdate>
        );
        checkAppUpdateMock.mockResolvedValueOnce(update);
        toAppUpdateInfoMock.mockReturnValueOnce(createUpdateInfo());

        const { result } = renderHook(() => useAppUpdate());

        await act(async () => {
            // Started but not awaited: this is the request that will be superseded.
            void result.current.checkForUpdate();
            await result.current.checkForUpdate();
        });

        expect(result.current.status).toBe("available");

        await act(async () => {
            resolveFirst(null);
            await firstCheck;
        });

        // Without the guard the superseded call's "no update" answer lands here and replaces the
        // newer one, leaving the user told they are up to date while an update is available.
        expect(result.current.status).toBe("available");
        expect(result.current.updateInfo).toEqual(createUpdateInfo());
    });

    it("does not let a superseded check report an error over a newer result", async () => {
        // The failure branch needs its own coverage: it sets state through a different path, and a
        // guard applied to only the success branch would still let a slow failure overwrite a good
        // answer with "Could not check for updates."
        let rejectFirst: (reason: Error) => void = () => {};
        const firstCheck = new Promise<null>((_resolve, reject) => {
            rejectFirst = reject;
        });

        const update = createUpdate();
        checkAppUpdateMock.mockReturnValueOnce(
            firstCheck as unknown as ReturnType<typeof checkAppUpdate>
        );
        checkAppUpdateMock.mockResolvedValueOnce(update);
        toAppUpdateInfoMock.mockReturnValueOnce(createUpdateInfo());

        const { result } = renderHook(() => useAppUpdate());

        await act(async () => {
            void result.current.checkForUpdate();
            await result.current.checkForUpdate();
        });

        await act(async () => {
            rejectFirst(new Error("network down"));
            await firstCheck.catch(() => undefined);
        });

        expect(result.current.status).toBe("available");
        expect(result.current.errorMessage).toBe("");
        // Still logged, though: a failed check is worth recording whichever request it belonged to,
        // and only the user-facing half is suppressed.
        expect(logErrorMock).toHaveBeenCalledWith(
            "app-update",
            "Failed to check app update.",
            expect.any(Error)
        );
    });

    it("does not let a check landing after an install started move the status off downloading", async () => {
        // The case the guard matters most for. `installUpdate` leaves the status on "downloading"
        // until the relaunch replaces the process, and both readers depend on that: the install
        // button stays disabled and the settings modal stays locked. A check resolving into that
        // window would unlock both mid-install.
        let resolveStaleCheck: (value: null) => void = () => {};
        const staleCheck = new Promise<null>((resolve) => {
            resolveStaleCheck = resolve;
        });

        const update = createUpdate();
        checkAppUpdateMock.mockResolvedValueOnce(update);
        toAppUpdateInfoMock.mockReturnValueOnce(createUpdateInfo());
        installAppUpdateMock.mockResolvedValueOnce(undefined);

        const { result } = renderHook(() => useAppUpdate());

        await act(async () => {
            await result.current.checkForUpdate();
        });

        checkAppUpdateMock.mockReturnValueOnce(
            staleCheck as unknown as ReturnType<typeof checkAppUpdate>
        );

        await act(async () => {
            void result.current.checkForUpdate();
            await result.current.installUpdate();
        });

        expect(result.current.status).toBe("downloading");

        await act(async () => {
            resolveStaleCheck(null);
            await staleCheck;
        });

        expect(result.current.status).toBe("downloading");
    });

    it("does nothing when installUpdate is called with no update available", async () => {
        const { result } = renderHook(() => useAppUpdate());

        await act(async () => {
            await result.current.installUpdate();
        });

        expect(result.current.status).toBe("idle");
        expect(installAppUpdateMock).not.toHaveBeenCalled();
    });

    it("installs the update, reports download progress and stays on downloading", async () => {
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
        expect(result.current.progress).toEqual({ downloaded: 50, total: 100, percent: 50 });
        expect(result.current.errorMessage).toBe("");

        // A successful install sets no terminal state: in production the relaunch has replaced the
        // process by now, and the two readers of this status both want it to still say
        // "downloading" - the install button stays disabled and the settings modal stays locked
        // right through to the relaunch. This test only observes the gap because the mock removes
        // the process replacement, which is exactly why the assertion has to name the real
        // post-state rather than the one a mock makes reachable.
        expect(result.current.status).toBe("downloading");
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
        // Back to the in-flight state a successful install leaves behind, and specifically no
        // longer "error": the retry is what clears it.
        expect(result.current.status).toBe("downloading");
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
        expect(result.current.status).toBe("downloading");
    });

    it("keeps the settings modal's in-progress check true through a successful install", async () => {
        // settings-modal.tsx locks the modal while `appUpdateStatus` is "checking" or "downloading",
        // so the relaunch is never a surprise. A terminal success state used to break that in the
        // one window where it mattered - the modal unlocked between the install finishing and the
        // process being replaced. This pins the status against the exact set that lock reads, so
        // reintroducing such a state fails here rather than as a modal that closes on its own.
        const update = createUpdate();
        checkAppUpdateMock.mockResolvedValueOnce(update);
        toAppUpdateInfoMock.mockReturnValueOnce(createUpdateInfo());
        installAppUpdateMock.mockResolvedValueOnce(undefined);

        const { result } = renderHook(() => useAppUpdate());

        await act(async () => {
            await result.current.checkForUpdate();
        });

        await act(async () => {
            await result.current.installUpdate();
        });

        const isUpdateInProgress =
            result.current.status === "checking" || result.current.status === "downloading";

        expect(isUpdateInProgress).toBe(true);
    });
});
