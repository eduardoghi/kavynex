import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/tauri-client", () => ({
    invokeCommand: vi.fn(),
    invokeVoid: vi.fn(),
    installAppUpdateWithProgress: vi.fn(),
}));

import { TAURI_COMMANDS } from "../constants/tauri-commands";
import { installAppUpdateWithProgress, invokeCommand, invokeVoid } from "../lib/tauri-client";
import type { AppUpdateDownloadProgress } from "../types/generated/AppUpdateDownloadProgress";
import {
    checkAppUpdate,
    installAppUpdate,
    lastCheckedUpdate,
    relaunchApp,
    resetLastCheckedUpdateForTests,
    type AppUpdateInfo,
    type AppUpdateProgress,
} from "./app-update-service";

const invokeCommandMock = vi.mocked(invokeCommand);
const invokeVoidMock = vi.mocked(invokeVoid);
const installMock = vi.mocked(installAppUpdateWithProgress);

function createUpdateInfo(overrides: Partial<AppUpdateInfo> = {}): AppUpdateInfo {
    return {
        currentVersion: "1.3.0",
        version: "1.4.0",
        date: "2026-08-13T00:00:00Z",
        body: "release notes",
        ...overrides,
    };
}

describe("checkAppUpdate", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        resetLastCheckedUpdateForTests();
    });

    it("remembers what the last check found for the rest of the session", async () => {
        // What lets Settings open on the update the startup check already found.
        const update = createUpdateInfo();
        invokeCommandMock.mockResolvedValueOnce(update);

        expect(lastCheckedUpdate()).toBeNull();
        await checkAppUpdate();
        expect(lastCheckedUpdate()).toBe(update);

        // A later check that finds nothing replaces it, so Settings never offers a stale install.
        invokeCommandMock.mockResolvedValueOnce(null);
        await checkAppUpdate();
        expect(lastCheckedUpdate()).toBeNull();
    });

    it("asks the backend with no arguments of its own", async () => {
        // The endpoint, the timeout and everything else come from the backend's configuration. A
        // renderer that could pass a proxy or headers here is the channel this design closes.
        invokeCommandMock.mockResolvedValue(null);

        await checkAppUpdate();

        expect(invokeCommandMock).toHaveBeenCalledWith(TAURI_COMMANDS.CHECK_FOR_APP_UPDATE);
    });

    it("returns null when the endpoint reports no newer version", async () => {
        // The hook branches on exactly this value to reach "not-available".
        invokeCommandMock.mockResolvedValue(null);

        await expect(checkAppUpdate()).resolves.toBeNull();
    });

    it("propagates a failed check rather than swallowing it into a null", async () => {
        // Swallowing here would make the hook render "you are up to date" for a check that never
        // completed, so a user on an outdated build is told the opposite.
        invokeCommandMock.mockRejectedValue(new Error("network unreachable"));

        await expect(checkAppUpdate()).rejects.toThrow("network unreachable");
    });
});

describe("installAppUpdate", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    /// Runs an install over the backend's progress `messages` and returns every progress payload the
    /// service emitted.
    async function collectProgress(
        messages: AppUpdateDownloadProgress[]
    ): Promise<AppUpdateProgress[]> {
        const progress: AppUpdateProgress[] = [];

        installMock.mockImplementationOnce(async (onProgress) => {
            for (const message of messages) {
                onProgress(message);
            }
        });

        await installAppUpdate((update) => progress.push(update));

        return progress;
    }

    it("reports the bytes downloaded and a whole-number percentage", async () => {
        const progress = await collectProgress([
            { downloaded: 1, total: 3, finished: false },
            { downloaded: 2, total: 3, finished: false },
        ]);

        // 1/3 and 2/3 of the total, rounded, not the raw 33.333.../66.666... a bar cannot render.
        expect(progress).toEqual([
            { downloaded: 1, total: 3, percent: 33 },
            { downloaded: 2, total: 3, percent: 67 },
        ]);
    });

    it("reports no percentage when the server did not send a size", async () => {
        // `total: null` is what the UI switches to an indeterminate bar on.
        const progress = await collectProgress([{ downloaded: 512, total: null, finished: false }]);

        expect(progress).toEqual([{ downloaded: 512, total: null, percent: null }]);
    });

    it("reports no percentage when the size is zero", async () => {
        // A zero total would divide by zero, so it takes the unknown-size path.
        const progress = await collectProgress([{ downloaded: 10, total: 0, finished: false }]);

        expect(progress.map((entry) => entry.percent)).toEqual([null]);
    });

    it("finishes at 100 percent even when the bytes never reached the total", async () => {
        // The finished message is what the bar completes on, not the byte count. A size that
        // disagrees with the bytes delivered would otherwise leave the bar short for an install that
        // succeeded.
        const progress = await collectProgress([
            { downloaded: 100, total: 1000, finished: false },
            { downloaded: 100, total: 1000, finished: true },
        ]);

        expect(progress[progress.length - 1]).toEqual({
            downloaded: 100,
            total: 1000,
            percent: 100,
        });
    });

    it("installs without a progress callback", async () => {
        installMock.mockImplementationOnce(async (onProgress) => {
            onProgress({ downloaded: 10, total: 10, finished: true });
        });

        await expect(installAppUpdate()).resolves.toBeUndefined();
        expect(installMock).toHaveBeenCalledTimes(1);
    });

    it("propagates a failed install so the caller can surface it", async () => {
        installMock.mockRejectedValueOnce(new Error("signature mismatch"));

        await expect(installAppUpdate()).rejects.toThrow("signature mismatch");
    });
});

describe("relaunchApp", () => {
    it("asks the backend to relaunch", async () => {
        invokeVoidMock.mockResolvedValueOnce(undefined);

        await relaunchApp();

        expect(invokeVoidMock).toHaveBeenCalledWith(TAURI_COMMANDS.RELAUNCH_APP);
    });
});
