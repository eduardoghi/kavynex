import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EVENT_IMPORTED_DATABASE_MISSING_FILES } from "../constants/events";
import { useImportedDatabaseAlert } from "./use-imported-database-alert";

// Same shape as the pending-media alert test. The mock ignores the schema and captures the handler,
// so a test can fire the event by hand.
let capturedHandler: ((payload: unknown) => void) | null = null;
const unlisten = vi.fn();

vi.mock("../lib/tauri-client", () => ({
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

const listenValidatedMock = vi.mocked(listenValidated);
const logErrorMock = vi.mocked(logError);

describe("useImportedDatabaseAlert", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        capturedHandler = null;
    });

    it("subscribes to the imported-database-missing-files event", async () => {
        renderHook(() => useImportedDatabaseAlert({ onMissingFiles: vi.fn() }));

        await waitFor(() => expect(listenValidatedMock).toHaveBeenCalledTimes(1));
        expect(listenValidatedMock.mock.calls[0]?.[0]).toBe(EVENT_IMPORTED_DATABASE_MISSING_FILES);
    });

    it("says how many files are missing and both ways forward", async () => {
        const onMissingFiles = vi.fn();
        renderHook(() => useImportedDatabaseAlert({ onMissingFiles }));

        await waitFor(() => expect(capturedHandler).not.toBeNull());
        capturedHandler?.({ missing: 42 });

        expect(onMissingFiles).toHaveBeenCalledTimes(1);
        const message = onMissingFiles.mock.calls[0]?.[0] as string;

        expect(message).toContain("42 files that are not");
        expect(message).toContain("Nothing was deleted");
        expect(message).toContain("Diagnostics");
        expect(message).toContain("undo the import");
    });

    it("reads a single missing file as singular", async () => {
        const onMissingFiles = vi.fn();
        renderHook(() => useImportedDatabaseAlert({ onMissingFiles }));

        await waitFor(() => expect(capturedHandler).not.toBeNull());
        capturedHandler?.({ missing: 1 });

        const message = onMissingFiles.mock.calls[0]?.[0] as string;
        expect(message).toContain("1 file that is not");
    });

    it("says nothing for a count the backend would never emit", async () => {
        const onMissingFiles = vi.fn();
        renderHook(() => useImportedDatabaseAlert({ onMissingFiles }));

        await waitFor(() => expect(capturedHandler).not.toBeNull());
        capturedHandler?.({ missing: 0 });
        capturedHandler?.({ missing: -3 });

        expect(onMissingFiles).not.toHaveBeenCalled();
    });

    it("unsubscribes on unmount", async () => {
        const { unmount } = renderHook(() => useImportedDatabaseAlert({ onMissingFiles: vi.fn() }));

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

        const { unmount } = renderHook(() => useImportedDatabaseAlert({ onMissingFiles: vi.fn() }));

        unmount();
        resolveListen(unlisten);

        await waitFor(() => expect(unlisten).toHaveBeenCalledTimes(1));
    });

    it("logs a failed subscription without throwing or surfacing it", async () => {
        listenValidatedMock.mockRejectedValueOnce(new Error("registration failed"));
        const onMissingFiles = vi.fn();

        renderHook(() => useImportedDatabaseAlert({ onMissingFiles }));

        await waitFor(() => expect(logErrorMock).toHaveBeenCalledTimes(1));
        expect(onMissingFiles).not.toHaveBeenCalled();
    });
});
