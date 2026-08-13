import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/tauri-platform", () => ({
    checkForAppUpdate: vi.fn(),
    relaunch: vi.fn(),
}));

import { checkForAppUpdate, relaunch, type Update } from "../lib/tauri-platform";
import {
    checkAppUpdate,
    installAppUpdate,
    toAppUpdateInfo,
    type AppUpdateProgress,
} from "./app-update-service";

const checkForAppUpdateMock = vi.mocked(checkForAppUpdate);
const relaunchMock = vi.mocked(relaunch);

// The subset of the plugin's `DownloadEvent` union `installAppUpdate` actually reads. Declared here
// rather than imported so the test pins the wire shape the service is written against: the plugin
// type is what a dependency bump changes, and the point of these assertions is to notice when the
// service stops agreeing with it.
type DownloadEvent =
    | { event: "Started"; data: { contentLength?: number } }
    | { event: "Progress"; data: { chunkLength: number } }
    | { event: "Finished" };

type DownloadDriver = (emit: (event: DownloadEvent) => void) => void;

/// A stand-in for the plugin's `Update`. `downloadAndInstall` hands the service's own callback to
/// `drive`, so a test emits the progress events by hand - nothing here reaches the network, which is
/// the whole reason this module could not be tested through the real plugin.
function createUpdate(
    drive: DownloadDriver = () => {},
    overrides: Partial<Record<string, unknown>> = {}
): Update {
    return {
        currentVersion: "1.3.0",
        version: "1.4.0",
        date: "2026-08-13",
        body: "release notes",
        downloadAndInstall: vi.fn(async (onEvent: (event: DownloadEvent) => void) => {
            drive(onEvent);
        }),
        close: vi.fn().mockResolvedValue(undefined),
        ...overrides,
    } as unknown as Update;
}

describe("checkAppUpdate", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("asks the plugin with the 30s timeout the caller depends on", async () => {
        // The timeout is the only argument this function contributes, and it is load-bearing:
        // useAppUpdate's request guard exists because a check can hang for this long, so a check
        // left unbounded would hang the Settings button with nothing to supersede it.
        checkForAppUpdateMock.mockResolvedValue(null);

        await checkAppUpdate();

        expect(checkForAppUpdateMock).toHaveBeenCalledWith({ timeout: 30000 });
    });

    it("returns the available update unchanged", async () => {
        const update = createUpdate();
        checkForAppUpdateMock.mockResolvedValue(update);

        await expect(checkAppUpdate()).resolves.toBe(update);
    });

    it("returns null when the endpoint reports no newer version", async () => {
        // The hook branches on exactly this value to reach "not-available", so a null that came
        // back as anything else would show an update that does not exist.
        checkForAppUpdateMock.mockResolvedValue(null);

        await expect(checkAppUpdate()).resolves.toBeNull();
    });

    it("propagates a failed check rather than swallowing it into a null", async () => {
        // Swallowing here would be the worse failure: the hook would render "you are up to date"
        // for a check that never completed, so a user on an outdated build is told the opposite.
        checkForAppUpdateMock.mockRejectedValue(new Error("network unreachable"));

        await expect(checkAppUpdate()).rejects.toThrow("network unreachable");
    });
});

describe("toAppUpdateInfo", () => {
    it("carries every field the update notice renders", () => {
        expect(toAppUpdateInfo(createUpdate())).toEqual({
            currentVersion: "1.3.0",
            version: "1.4.0",
            date: "2026-08-13",
            body: "release notes",
        });
    });

    it("keeps an absent date and body absent instead of inventing a value", () => {
        // Both are optional on the plugin's type, and the notice renders them conditionally. A
        // placeholder here would show an empty date row for every release that carries none.
        const info = toAppUpdateInfo(
            createUpdate(() => {}, { date: undefined, body: undefined })
        );

        expect(info.date).toBeUndefined();
        expect(info.body).toBeUndefined();
        expect(info.version).toBe("1.4.0");
    });

    it("does not confuse the current version with the available one", () => {
        // The two are adjacent strings of the same shape on the same object, and the notice reads
        // "1.3.0 -> 1.4.0" off them; swapped, it tells the user to downgrade.
        const info = toAppUpdateInfo(
            createUpdate(() => {}, { currentVersion: "1.0.0", version: "9.9.9" })
        );

        expect(info.currentVersion).toBe("1.0.0");
        expect(info.version).toBe("9.9.9");
    });
});

describe("installAppUpdate", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        relaunchMock.mockResolvedValue(undefined);
    });

    /// Runs an install over `events` and returns every progress payload the service emitted.
    async function collectProgress(events: DownloadEvent[]): Promise<AppUpdateProgress[]> {
        const progress: AppUpdateProgress[] = [];

        await installAppUpdate(
            createUpdate((emit) => {
                for (const event of events) {
                    emit(event);
                }
            }),
            (update) => progress.push(update)
        );

        return progress;
    }

    it("reports the download size up front with no percentage yet", async () => {
        // `Started` is the only event carrying the content length, and the percentage is
        // deliberately null here rather than 0: nothing has been downloaded, and a 0% bar is
        // indistinguishable from a stalled one.
        const progress = await collectProgress([
            { event: "Started", data: { contentLength: 400 } },
        ]);

        expect(progress).toEqual([{ downloaded: 0, total: 400, percent: null }]);
    });

    it("accumulates chunk lengths rather than reporting each chunk on its own", async () => {
        // The plugin sends the size of *this* chunk, not the running total. Reporting it verbatim
        // would make the bar jump back to near zero on every event.
        const progress = await collectProgress([
            { event: "Started", data: { contentLength: 400 } },
            { event: "Progress", data: { chunkLength: 100 } },
            { event: "Progress", data: { chunkLength: 100 } },
            { event: "Progress", data: { chunkLength: 200 } },
        ]);

        expect(progress.map((entry) => entry.downloaded)).toEqual([0, 100, 200, 400]);
        expect(progress.map((entry) => entry.percent)).toEqual([null, 25, 50, 100]);
    });

    it("rounds the percentage to a whole number", async () => {
        const progress = await collectProgress([
            { event: "Started", data: { contentLength: 3 } },
            { event: "Progress", data: { chunkLength: 1 } },
            { event: "Progress", data: { chunkLength: 1 } },
        ]);

        // 1/3 and 2/3 of the total, rounded - not the raw 33.333.../66.666... a bar cannot render.
        expect(progress.map((entry) => entry.percent)).toEqual([null, 33, 67]);
    });

    it("reports no percentage when the server did not send a content length", async () => {
        // A download with no known size still has to report progress; what it cannot report is how
        // far along it is. `total: null` is what the UI switches to an indeterminate bar on.
        const progress = await collectProgress([
            { event: "Started", data: {} },
            { event: "Progress", data: { chunkLength: 512 } },
        ]);

        expect(progress).toEqual([
            { downloaded: 0, total: null, percent: null },
            { downloaded: 512, total: null, percent: null },
        ]);
    });

    it("reports no percentage when the content length is zero", async () => {
        // A zero total would divide by zero. The guard is a truthiness check, so this pins that a
        // reported length of 0 takes the unknown-size path rather than producing Infinity.
        const progress = await collectProgress([
            { event: "Started", data: { contentLength: 0 } },
            { event: "Progress", data: { chunkLength: 10 } },
        ]);

        expect(progress.map((entry) => entry.percent)).toEqual([null, null]);
    });

    it("finishes at 100 percent even when the chunks never summed to the total", async () => {
        // `Finished` is what the bar completes on, and it must not be derived from the byte count:
        // a content length that disagrees with the bytes actually delivered would otherwise leave
        // the bar short of the end for an install that succeeded.
        const progress = await collectProgress([
            { event: "Started", data: { contentLength: 1000 } },
            { event: "Progress", data: { chunkLength: 100 } },
            { event: "Finished" },
        ]);

        expect(progress[progress.length - 1]).toEqual({
            downloaded: 100,
            total: 1000,
            percent: 100,
        });
    });

    it("resets the byte count when a retried download starts again", async () => {
        // The plugin can emit a second `Started` when it restarts a download. Without the reset the
        // count would carry over and the bar would run past 100 percent.
        const progress = await collectProgress([
            { event: "Started", data: { contentLength: 200 } },
            { event: "Progress", data: { chunkLength: 200 } },
            { event: "Started", data: { contentLength: 200 } },
            { event: "Progress", data: { chunkLength: 50 } },
        ]);

        expect(progress.map((entry) => entry.downloaded)).toEqual([0, 200, 0, 50]);
        expect(progress.map((entry) => entry.percent)).toEqual([null, 100, null, 25]);
    });

    it("ignores an event it does not recognize", async () => {
        // Forward compatibility rather than a shape the plugin emits today: `DownloadEvent` is a
        // union a minor bump can grow, and the three branches here are checks rather than an
        // exhaustive match, so an unknown variant has to fall through silently. Throwing would fail
        // an install that was otherwise fine.
        const progress = await collectProgress([
            { event: "Started", data: { contentLength: 100 } },
            { event: "Paused" } as unknown as DownloadEvent,
            { event: "Progress", data: { chunkLength: 100 } },
        ]);

        expect(progress.map((entry) => entry.downloaded)).toEqual([0, 100]);
    });

    it("installs without a progress callback", async () => {
        // The callback is optional, and the events keep arriving whether or not one was passed, so
        // the emit sites have to stay optional-chained.
        const update = createUpdate((emit) => {
            emit({ event: "Started", data: { contentLength: 10 } });
            emit({ event: "Progress", data: { chunkLength: 10 } });
            emit({ event: "Finished" });
        });

        await expect(installAppUpdate(update)).resolves.toBeUndefined();
        expect(relaunchMock).toHaveBeenCalledTimes(1);
    });

    it("relaunches once the install completes", async () => {
        // The relaunch is what makes the new version the running one. Without it the user sees a
        // finished progress bar and keeps running the old build until they close the app by hand.
        const update = createUpdate();

        await installAppUpdate(update);

        expect(update.downloadAndInstall).toHaveBeenCalledTimes(1);
        expect(relaunchMock).toHaveBeenCalledTimes(1);
    });

    it("does not relaunch when the download or install fails", async () => {
        // Relaunching after a failed install would restart the app into whichever half-written
        // state the installer left behind, and the caller would see a restart instead of an error.
        const update = createUpdate(() => {}, {
            downloadAndInstall: vi.fn().mockRejectedValue(new Error("signature mismatch")),
        });

        await expect(installAppUpdate(update)).rejects.toThrow("signature mismatch");
        expect(relaunchMock).not.toHaveBeenCalled();
    });

    it("propagates a failed relaunch so the caller can surface it", async () => {
        // On Windows the installer can end the process from inside downloadAndInstall, so this
        // rejection is only reachable when the process is still alive - which makes it a real
        // failure to report rather than the expected end of the process.
        relaunchMock.mockRejectedValue(new Error("relaunch refused"));

        await expect(installAppUpdate(createUpdate())).rejects.toThrow("relaunch refused");
    });
});
