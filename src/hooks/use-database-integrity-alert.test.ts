import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EVENT_DATABASE_INTEGRITY_FAILED } from "../constants/events";
import { useDatabaseIntegrityAlert } from "./use-database-integrity-alert";

// The hook subscribes through listenValidated(eventName, schema, handler); the schema itself is
// covered by the ipc-schemas tests, so this mock ignores it and captures the handler so a test can
// fire the event by hand. The returned unlisten is a shared spy so the cleanup path is observable.
let capturedHandler: ((payload: unknown) => void) | null = null;
const unlisten = vi.fn();

vi.mock("../lib/tauri-client", () => ({
    listenValidated: vi.fn(
        async (_eventName: string, _schema: unknown, handler: (payload: unknown) => void) => {
            capturedHandler = handler;
            return unlisten;
        }
    ),
}));

vi.mock("../utils/app-logger", () => ({
    logError: vi.fn(),
}));

import { listenValidated } from "../lib/tauri-client";
import { logError } from "../utils/app-logger";

const listenValidatedMock = vi.mocked(listenValidated);
const logErrorMock = vi.mocked(logError);

describe("useDatabaseIntegrityAlert", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        capturedHandler = null;
    });

    it("subscribes to the integrity-failed event", async () => {
        renderHook(() => useDatabaseIntegrityAlert({ onIntegrityFailure: vi.fn() }));

        await waitFor(() => expect(listenValidatedMock).toHaveBeenCalledTimes(1));
        expect(listenValidatedMock.mock.calls[0]?.[0]).toBe(EVENT_DATABASE_INTEGRITY_FAILED);
    });

    it("surfaces a non-technical message when the event fires", async () => {
        const onIntegrityFailure = vi.fn();
        renderHook(() => useDatabaseIntegrityAlert({ onIntegrityFailure }));

        await waitFor(() => expect(capturedHandler).not.toBeNull());
        capturedHandler?.({ problems: ["*** in database main"] });

        expect(onIntegrityFailure).toHaveBeenCalledTimes(1);
        const message = onIntegrityFailure.mock.calls[0]?.[0] as string;
        // Action-oriented and non-technical: it points at the restore flow and never echoes the raw
        // PRAGMA problem text (which stays in the log and the event payload for a bug report).
        expect(message).toContain("Settings > Database");
        expect(message).not.toContain("***");
    });

    it("unsubscribes on unmount", async () => {
        const { unmount } = renderHook(() =>
            useDatabaseIntegrityAlert({ onIntegrityFailure: vi.fn() })
        );

        await waitFor(() => expect(listenValidatedMock).toHaveBeenCalledTimes(1));
        unmount();

        expect(unlisten).toHaveBeenCalledTimes(1);
    });

    it("stops a listener that resolves after the hook was disposed", async () => {
        // Model the StrictMode/teardown race: the subscription promise resolves only after the hook
        // has been disposed. The hook must call the returned stop() rather than leak the listener,
        // and must never fire the handler for a subscription that outlived its effect.
        let resolveListen!: (stop: () => void) => void;
        const pendingSubscription = new Promise<() => void>((resolve) => {
            resolveListen = resolve;
        });
        listenValidatedMock.mockImplementationOnce(() => pendingSubscription);

        const onIntegrityFailure = vi.fn();
        const { unmount } = renderHook(() =>
            useDatabaseIntegrityAlert({ onIntegrityFailure })
        );

        unmount();
        resolveListen(unlisten);

        await waitFor(() => expect(unlisten).toHaveBeenCalledTimes(1));
        expect(onIntegrityFailure).not.toHaveBeenCalled();
    });

    it("logs a failed subscription without throwing or surfacing it", async () => {
        listenValidatedMock.mockRejectedValueOnce(new Error("registration failed"));
        const onIntegrityFailure = vi.fn();

        renderHook(() => useDatabaseIntegrityAlert({ onIntegrityFailure }));

        await waitFor(() => expect(logErrorMock).toHaveBeenCalledTimes(1));
        expect(onIntegrityFailure).not.toHaveBeenCalled();
    });
});
