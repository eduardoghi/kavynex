import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EVENT_PENDING_MEDIA_ABANDONED } from "../constants/events";
import { usePendingMediaAlert } from "./use-pending-media-alert";

// The hook subscribes through listenValidated(eventName, schema, handler); the schema itself is
// covered by the ipc-schemas tests, so this mock ignores it and captures the handler so a test can
// fire the event by hand. The returned unlisten is a shared spy so the cleanup path is observable.
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

describe("usePendingMediaAlert", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        capturedHandler = null;
    });

    it("subscribes to the pending-media-abandoned event", async () => {
        renderHook(() => usePendingMediaAlert({ onArtifactsAbandoned: vi.fn() }));

        await waitFor(() => expect(listenValidatedMock).toHaveBeenCalledTimes(1));
        expect(listenValidatedMock.mock.calls[0]?.[0]).toBe(EVENT_PENDING_MEDIA_ABANDONED);
    });

    it("surfaces a message that says what happened and where to go", async () => {
        const onArtifactsAbandoned = vi.fn();
        renderHook(() => usePendingMediaAlert({ onArtifactsAbandoned }));

        await waitFor(() => expect(capturedHandler).not.toBeNull());
        capturedHandler?.({ abandoned: 2 });

        expect(onArtifactsAbandoned).toHaveBeenCalledTimes(1);
        const message = onArtifactsAbandoned.mock.calls[0]?.[0] as string;

        expect(message).toContain("2 unfinished media imports");
        // The point of the notice is the next step; a message without it is just an alarm.
        expect(message).toContain("Diagnostics");
        // And the next step has to be the one that exists. Diagnostics reports and never deletes,
        // so the message names the file manager. The earlier wording sent the user there to "remove
        // them", which is an action that screen does not have.
        expect(message).toContain("file manager");
        // And it must not read as data loss, because nothing was lost. The files are still there.
        expect(message).toContain("Nothing was lost");
        // No marker file name, no library-relative path. The banner says that something is there,
        // and Diagnostics says what.
        expect(message).not.toContain("pending-");
    });

    it("reads the count as a singular when only one import was abandoned", async () => {
        const onArtifactsAbandoned = vi.fn();
        renderHook(() => usePendingMediaAlert({ onArtifactsAbandoned }));

        await waitFor(() => expect(capturedHandler).not.toBeNull());
        capturedHandler?.({ abandoned: 1 });

        const message = onArtifactsAbandoned.mock.calls[0]?.[0] as string;
        expect(message).toContain("1 unfinished media import ");
        expect(message).not.toContain("imports");
    });

    it("says nothing for a count the backend would never emit", async () => {
        // The backend only emits with at least one, but the value crosses IPC and the schema proves
        // only that it is a number, so a zero must not produce a notice about "0 unfinished imports".
        const onArtifactsAbandoned = vi.fn();
        renderHook(() => usePendingMediaAlert({ onArtifactsAbandoned }));

        await waitFor(() => expect(capturedHandler).not.toBeNull());
        capturedHandler?.({ abandoned: 0 });
        capturedHandler?.({ abandoned: -3 });

        expect(onArtifactsAbandoned).not.toHaveBeenCalled();
    });

    it("unsubscribes on unmount", async () => {
        const { unmount } = renderHook(() =>
            usePendingMediaAlert({ onArtifactsAbandoned: vi.fn() })
        );

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

        const { unmount } = renderHook(() =>
            usePendingMediaAlert({ onArtifactsAbandoned: vi.fn() })
        );

        unmount();
        resolveListen(unlisten);

        await waitFor(() => expect(unlisten).toHaveBeenCalledTimes(1));
    });

    it("logs a failed subscription without throwing or surfacing it", async () => {
        listenValidatedMock.mockRejectedValueOnce(new Error("registration failed"));
        const onArtifactsAbandoned = vi.fn();

        renderHook(() => usePendingMediaAlert({ onArtifactsAbandoned }));

        await waitFor(() => expect(logErrorMock).toHaveBeenCalledTimes(1));
        expect(onArtifactsAbandoned).not.toHaveBeenCalled();
    });
});
