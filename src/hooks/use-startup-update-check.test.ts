import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useStartupUpdateCheck } from "./use-startup-update-check";
import { checkAppUpdate } from "../services/app-update-service";
import { logError } from "../utils/app-logger";

vi.mock("../services/app-update-service", () => ({
    checkAppUpdate: vi.fn(),
}));

vi.mock("../utils/app-logger", () => ({
    logError: vi.fn(),
}));

const checkAppUpdateMock = vi.mocked(checkAppUpdate);
const logErrorMock = vi.mocked(logError);

function updateWithVersion(version: string): Awaited<ReturnType<typeof checkAppUpdate>> {
    return { version } as unknown as Awaited<ReturnType<typeof checkAppUpdate>>;
}

describe("useStartupUpdateCheck", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("does not contact the update endpoint while disabled", () => {
        const onUpdateAvailable = vi.fn();

        renderHook(() => useStartupUpdateCheck({ enabled: false, onUpdateAvailable }));

        // Off by default: a launch makes no update request until the user opts in.
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

        // A fresh callback identity re-runs the effect; the ref guard must still keep it to a single
        // check for the whole session rather than one per render.
        rerender({ onUpdateAvailable: vi.fn() });
        rerender({ onUpdateAvailable: vi.fn() });

        expect(checkAppUpdateMock).toHaveBeenCalledTimes(1);
    });

    it("swallows and logs a failed check without surfacing it", async () => {
        checkAppUpdateMock.mockRejectedValueOnce(new Error("network down"));
        const onUpdateAvailable = vi.fn();

        renderHook(() => useStartupUpdateCheck({ enabled: true, onUpdateAvailable }));

        // A failed passive check must never interrupt startup: it is logged and stays quiet.
        await waitFor(() => expect(logErrorMock).toHaveBeenCalledTimes(1));
        expect(onUpdateAvailable).not.toHaveBeenCalled();
    });
});
