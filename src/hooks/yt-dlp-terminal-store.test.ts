import { describe, expect, it, vi } from "vitest";
import { createYtDlpTerminalStore } from "./yt-dlp-terminal-store";

describe("createYtDlpTerminalStore", () => {
    it("starts empty and notifies subscribers of a change", () => {
        const store = createYtDlpTerminalStore();
        const listener = vi.fn();
        store.subscribe(listener);

        expect(store.getSnapshot()).toEqual({ logs: [], progress: null, outcome: null });

        store.update((current) => ({
            ...current,
            logs: [{ id: 1, text: "line", level: "info" }],
        }));

        expect(listener).toHaveBeenCalledTimes(1);
        expect(store.getSnapshot().logs).toHaveLength(1);
    });

    it("keeps its snapshot and stays quiet when an update changes nothing", () => {
        // useSyncExternalStore re-renders on a new snapshot, so an unchanged one must be the
        // same object.
        const store = createYtDlpTerminalStore();
        const listener = vi.fn();
        store.subscribe(listener);
        const before = store.getSnapshot();

        store.update((current) => current);

        expect(store.getSnapshot()).toBe(before);
        expect(listener).not.toHaveBeenCalled();
    });

    it("stops notifying a subscriber that unsubscribed", () => {
        const store = createYtDlpTerminalStore();
        const listener = vi.fn();
        const unsubscribe = store.subscribe(listener);

        unsubscribe();
        store.update((current) => ({ ...current, progress: null, logs: [] }));

        expect(listener).not.toHaveBeenCalled();
    });
});
