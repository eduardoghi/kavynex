import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ANNOUNCED_UPDATE_STORAGE_KEY, useStartupUpdateCheck } from "./use-startup-update-check";
import { checkAppUpdate } from "../services/app-update-service";
import { logWarn } from "../utils/app-logger";

vi.mock("../services/app-update-service", () => ({
    checkAppUpdate: vi.fn(),
}));

vi.mock("../utils/app-logger", () => ({
    logWarn: vi.fn(),
}));

const checkAppUpdateMock = vi.mocked(checkAppUpdate);
const logWarnMock = vi.mocked(logWarn);

function updateWithVersion(version: string): Awaited<ReturnType<typeof checkAppUpdate>> {
    return { version } as unknown as Awaited<ReturnType<typeof checkAppUpdate>>;
}

describe("useStartupUpdateCheck", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        window.localStorage.clear();
    });

    it("announces a version once, and a newer one again", async () => {
        // A user who chose to update later is not asked on every launch.
        window.localStorage.setItem(ANNOUNCED_UPDATE_STORAGE_KEY, "1.5.0");
        checkAppUpdateMock.mockResolvedValueOnce(updateWithVersion("1.5.0"));
        const quiet = vi.fn();

        renderHook(() => useStartupUpdateCheck({ enabled: true, onUpdateAvailable: quiet }));

        await waitFor(() => expect(checkAppUpdateMock).toHaveBeenCalledTimes(1));
        expect(quiet).not.toHaveBeenCalled();

        checkAppUpdateMock.mockResolvedValueOnce(updateWithVersion("1.6.0"));
        const announced = vi.fn();

        renderHook(() => useStartupUpdateCheck({ enabled: true, onUpdateAvailable: announced }));

        await waitFor(() => expect(announced).toHaveBeenCalledTimes(1));
        expect(window.localStorage.getItem(ANNOUNCED_UPDATE_STORAGE_KEY)).toBe("1.6.0");
    });

    it("does not contact the update endpoint while disabled", () => {
        const onUpdateAvailable = vi.fn();

        renderHook(() => useStartupUpdateCheck({ enabled: false, onUpdateAvailable }));

        // The startup check is on by default, so this pins the other direction. A user who turned
        // it off in Settings gets no update request at launch.
        expect(checkAppUpdateMock).not.toHaveBeenCalled();
        expect(onUpdateAvailable).not.toHaveBeenCalled();
    });

    it("surfaces a notice when an update is available", async () => {
        checkAppUpdateMock.mockResolvedValueOnce(updateWithVersion("1.5.0"));
        const onUpdateAvailable = vi.fn();

        renderHook(() => useStartupUpdateCheck({ enabled: true, onUpdateAvailable }));

        await waitFor(() =>
            expect(onUpdateAvailable).toHaveBeenCalledWith(
                "Version 1.5.0 of Kavynex is available. Open Settings to update."
            )
        );
        expect(checkAppUpdateMock).toHaveBeenCalledTimes(1);
    });

    it("stays quiet when no update is available", async () => {
        checkAppUpdateMock.mockResolvedValueOnce(null);
        const onUpdateAvailable = vi.fn();

        renderHook(() => useStartupUpdateCheck({ enabled: true, onUpdateAvailable }));

        await waitFor(() => expect(checkAppUpdateMock).toHaveBeenCalledTimes(1));
        expect(onUpdateAvailable).not.toHaveBeenCalled();
    });

    it("checks at most once per session even when the effect re-runs", async () => {
        checkAppUpdateMock.mockResolvedValue(null);

        const { rerender } = renderHook(
            (props: { onUpdateAvailable: (message: string) => void }) =>
                useStartupUpdateCheck({
                    enabled: true,
                    onUpdateAvailable: props.onUpdateAvailable,
                }),
            { initialProps: { onUpdateAvailable: vi.fn() } }
        );

        await waitFor(() => expect(checkAppUpdateMock).toHaveBeenCalledTimes(1));

        // A fresh callback identity re-runs the effect. The ref guard must still keep it to a
        // single check for the whole session rather than one per render.
        rerender({ onUpdateAvailable: vi.fn() });
        rerender({ onUpdateAvailable: vi.fn() });

        expect(checkAppUpdateMock).toHaveBeenCalledTimes(1);
    });

    it("swallows and logs a failed check without surfacing it", async () => {
        checkAppUpdateMock.mockRejectedValueOnce(new Error("network down"));
        const onUpdateAvailable = vi.fn();

        renderHook(() => useStartupUpdateCheck({ enabled: true, onUpdateAvailable }));

        // A failed passive check must never interrupt startup. It is logged and stays quiet.
        await waitFor(() => expect(logWarnMock).toHaveBeenCalledTimes(1));
        expect(onUpdateAvailable).not.toHaveBeenCalled();
    });
});
