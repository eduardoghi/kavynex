import { useSyncExternalStore } from "react";
import type { YtDlpProgress } from "../services/yt-dlp-progress";
import type { YtDlpLogLine } from "./use-yt-dlp-events";

// How the last run ended, null while one runs or before the first. A failed or cancelled run
// keeps its log on screen, and the terminal's badge reads this rather than the log to tell it from
// one that finished.
export type YtDlpRunOutcome = "finished" | "failed" | "cancelled";

export type YtDlpTerminalSnapshot = {
    logs: YtDlpLogLine[];
    progress: YtDlpProgress | null;
    outcome: YtDlpRunOutcome | null;
};

// The yt-dlp terminal's lines and progress, kept outside React state on purpose. A download writes
// a line many times a second, and as hook state every line re-rendered the hook's owner, which is
// the Home page with the channel list and the library grid under it. Held here, a line re-renders
// only what subscribes (the add media modal), and the owner never sees it.
export type YtDlpTerminalStore = {
    getSnapshot: () => YtDlpTerminalSnapshot;
    subscribe: (listener: () => void) => () => void;
    update: (change: (current: YtDlpTerminalSnapshot) => YtDlpTerminalSnapshot) => void;
};

const EMPTY_SNAPSHOT: YtDlpTerminalSnapshot = { logs: [], progress: null, outcome: null };

export function createYtDlpTerminalStore(): YtDlpTerminalStore {
    let snapshot = EMPTY_SNAPSHOT;
    const listeners = new Set<() => void>();

    return {
        getSnapshot: () => snapshot,
        subscribe: (listener) => {
            listeners.add(listener);

            return () => {
                listeners.delete(listener);
            };
        },
        update: (change) => {
            const next = change(snapshot);

            if (next === snapshot) {
                return;
            }

            snapshot = next;

            for (const listener of listeners) {
                listener();
            }
        },
    };
}

export function useYtDlpTerminal(store: YtDlpTerminalStore): YtDlpTerminalSnapshot {
    return useSyncExternalStore(store.subscribe, store.getSnapshot);
}
