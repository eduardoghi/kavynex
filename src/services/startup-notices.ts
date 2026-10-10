import { TAURI_COMMANDS } from "../constants/tauri-commands";
import { invokeCommand } from "../lib/tauri-client";
import type { StartupNotices } from "../types/generated/StartupNotices";

// What the backend's startup tasks found for the user. The backend keeps each finding until it is
// taken, because the event announcing it reaches only a listener that is already attached (see
// src-tauri/src/services/startup_notices.rs). Taking clears all of them at once, and each alert hook
// wants only its own, so what one take returns is held here until the hook it belongs to consumes
// it.

const NONE: StartupNotices = {
    databaseIntegrityFailed: false,
    pendingMediaAbandoned: null,
    importedMissingFiles: null,
    importApplyFailed: false,
    databaseDisplaced: false,
};

let held: StartupNotices = { ...NONE };

function merge(into: StartupNotices, taken: StartupNotices): StartupNotices {
    return {
        databaseIntegrityFailed: into.databaseIntegrityFailed || taken.databaseIntegrityFailed,
        pendingMediaAbandoned:
            into.pendingMediaAbandoned === null && taken.pendingMediaAbandoned === null
                ? null
                : (into.pendingMediaAbandoned ?? 0) + (taken.pendingMediaAbandoned ?? 0),
        importedMissingFiles: taken.importedMissingFiles ?? into.importedMissingFiles,
        importApplyFailed: into.importApplyFailed || taken.importApplyFailed,
        databaseDisplaced: into.databaseDisplaced || taken.databaseDisplaced,
    };
}

// Takes whatever the backend recorded since the last take and holds it. The three alert hooks pull
// at once on mount and the take is destructive, so only the first answer carries anything. `held`
// is read after the await, or a later empty answer would merge into the snapshot taken before the
// first one arrived and wipe what it held.
export async function pullStartupNotices(): Promise<void> {
    const taken = await invokeCommand(TAURI_COMMANDS.TAKE_STARTUP_NOTICES);
    held = merge(held, taken);
}

// Returns one held notice and clears it, so it is shown once.
export function consumeStartupNotice<K extends keyof StartupNotices>(key: K): StartupNotices[K] {
    const value = held[key];
    held = { ...held, [key]: NONE[key] };
    return value;
}

// For tests only. The held notices are module state.
export function resetStartupNoticesForTests(): void {
    held = { ...NONE };
}
