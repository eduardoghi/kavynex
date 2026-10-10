import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EVENT_IMPORTED_DATABASE_MISSING_FILES } from "../constants/events";
import { useImportedDatabaseAlert } from "./use-imported-database-alert";

// Same shape as the pending-media alert test. The mock ignores the schema and captures the handler,
// so a test can fire the event by hand.
let capturedHandler: ((payload: unknown) => void) | null = null;
const unlisten = vi.fn();

// The backend's held notices, as `take_startup_notices` would return them. `fire` records one there
// and then fires the event, which is the order the backend uses.
const NO_NOTICES = {
    databaseIntegrityFailed: false,
    pendingMediaAbandoned: null,
    importedMissingFiles: null,
    importApplyFailed: false,
    databaseDisplaced: false,
};
let backendNotices: Record<string, unknown> = { ...NO_NOTICES };

function takeBackendNotices(): Record<string, unknown> {
    const taken = backendNotices;
    backendNotices = { ...NO_NOTICES };
    return taken;
}

async function flush(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
}

async function fire(notices: Record<string, unknown>): Promise<void> {
    backendNotices = { ...backendNotices, ...notices };
    capturedHandler?.({});
    await flush();
}

vi.mock("../lib/tauri-client", () => ({
    invokeCommand: vi.fn(async () => takeBackendNotices()),
    listenValidated: vi.fn((_event: string, _schema: unknown, handler: (payload: unknown) => void) => {
        capturedHandler = handler;
        return Promise.resolve(unlisten);
    }),
}));

vi.mock("../utils/app-logger", () => ({
    logError: vi.fn(),
}));

import { listenValidated } from "../lib/tauri-client";
import { logError } from "../utils/app-logger";
import { resetStartupNoticesForTests } from "../services/startup-notices";

const listenValidatedMock = vi.mocked(listenValidated);
const logErrorMock = vi.mocked(logError);

describe("useImportedDatabaseAlert", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        capturedHandler = null;
        backendNotices = { ...NO_NOTICES };
        resetStartupNoticesForTests();
    });

    it("subscribes to the imported-database-missing-files event", async () => {
        renderHook(() => useImportedDatabaseAlert({ onMissingFiles: vi.fn(), onImportFailed: vi.fn() }));

        await waitFor(() => expect(listenValidatedMock).toHaveBeenCalledTimes(1));
        expect(listenValidatedMock.mock.calls[0]?.[0]).toBe(EVENT_IMPORTED_DATABASE_MISSING_FILES);
    });

    it("says how many files are missing and both ways forward", async () => {
        const onMissingFiles = vi.fn();
        renderHook(() => useImportedDatabaseAlert({ onMissingFiles, onImportFailed: vi.fn() }));

        await waitFor(() => expect(capturedHandler).not.toBeNull());
        await fire({ importedMissingFiles: 42 });

        expect(onMissingFiles).toHaveBeenCalledTimes(1);
        const message = onMissingFiles.mock.calls[0]?.[0] as string;

        expect(message).toContain("42 files that are not");
        expect(message).toContain("Nothing was deleted");
        expect(message).toContain("Diagnostics");
        expect(message).toContain("An import can be undone");
    });

    it("reads a single missing file as singular", async () => {
        const onMissingFiles = vi.fn();
        renderHook(() => useImportedDatabaseAlert({ onMissingFiles, onImportFailed: vi.fn() }));

        await waitFor(() => expect(capturedHandler).not.toBeNull());
        await fire({ importedMissingFiles: 1 });

        const message = onMissingFiles.mock.calls[0]?.[0] as string;
        expect(message).toContain("1 file that is not");
    });

    it("says nothing for a count the backend would never emit", async () => {
        const onMissingFiles = vi.fn();
        renderHook(() => useImportedDatabaseAlert({ onMissingFiles, onImportFailed: vi.fn() }));

        await waitFor(() => expect(capturedHandler).not.toBeNull());
        await fire({ importedMissingFiles: 0 });
        await fire({ importedMissingFiles: -3 });

        expect(onMissingFiles).not.toHaveBeenCalled();
    });

    it("unsubscribes on unmount", async () => {
        const { unmount } = renderHook(() => useImportedDatabaseAlert({ onMissingFiles: vi.fn(), onImportFailed: vi.fn() }));

        await waitFor(() => expect(listenValidatedMock).toHaveBeenCalledTimes(1));
        unmount();

        expect(unlisten).toHaveBeenCalledTimes(1);
    });

    it("cleans up a subscription that resolves after unmount", async () => {
        let resolveListen: (stop: () => void) => void = () => {};
        const pendingSubscription = new Promise<() => void>((resolve) => {
            resolveListen = resolve;
        });
        listenValidatedMock.mockImplementationOnce(() => pendingSubscription);

        const { unmount } = renderHook(() => useImportedDatabaseAlert({ onMissingFiles: vi.fn(), onImportFailed: vi.fn() }));

        unmount();
        resolveListen(unlisten);

        await waitFor(() => expect(unlisten).toHaveBeenCalledTimes(1));
    });

    it("logs a failed subscription without throwing or surfacing it", async () => {
        listenValidatedMock.mockRejectedValueOnce(new Error("registration failed"));
        const onMissingFiles = vi.fn();

        renderHook(() => useImportedDatabaseAlert({ onMissingFiles, onImportFailed: vi.fn() }));

        await waitFor(() => expect(logErrorMock).toHaveBeenCalledTimes(1));
        expect(onMissingFiles).not.toHaveBeenCalled();
    });

    it("shows an import that could not be applied, which was recorded before the window loaded", async () => {
        backendNotices = { ...NO_NOTICES, importApplyFailed: true };
        const onImportFailed = vi.fn();

        renderHook(() => useImportedDatabaseAlert({ onMissingFiles: vi.fn(), onImportFailed }));

        await waitFor(() => expect(onImportFailed).toHaveBeenCalledTimes(1));
        expect(onImportFailed.mock.calls[0]?.[0]).toContain("still using the previous one");
    });

    it("shows a count recorded before it mounted, without waiting for the event", async () => {
        // The event went out while nothing was listening. The take on mount is what still reaches
        // the user.
        backendNotices = { ...NO_NOTICES, importedMissingFiles: 3 };
        const onMissingFiles = vi.fn();

        renderHook(() => useImportedDatabaseAlert({ onMissingFiles, onImportFailed: vi.fn() }));

        await waitFor(() => expect(onMissingFiles).toHaveBeenCalledTimes(1));
        expect(onMissingFiles.mock.calls[0]?.[0]).toContain("3 files");
    });
});
