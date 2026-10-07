import {
    chooseLibraryDirectory,
    ensureDirectoryExists,
    migrateLibraryDirectory,
} from "../services/library-service";
import type { LibrarySummaryInfo } from "../types/generated/LibrarySummaryInfo";
import { isFilesystemRootPath } from "../utils/paths";
import { ClientError } from "../utils/app-error";

type PlanChangeLibraryPathInput = {
    currentLibraryPath: string;
};

// What choosing a folder leads to. A first library is used as it is. Moving an existing one waits
// for the user to confirm, since it copies the whole library and then deletes the old folder.
export type LibraryPathChangePlan =
    | { kind: "unchanged" }
    | { kind: "apply"; finalLibraryPath: string }
    | { kind: "move"; currentLibraryPath: string; destination: string };

// A move waiting for the user's answer.
export type PendingLibraryMove = {
    currentLibraryPath: string;
    destination: string;
    // What is about to be copied, or null when it could not be read, which an unreachable current
    // folder is one reason for.
    summary: LibrarySummaryInfo | null;
    // The current folder cannot be reached while media are registered in it. Confirming then
    // switches to the destination without moving anything.
    currentFolderUnreachable: boolean;
};

export type ExecuteChangeLibraryPathResult = {
    changed: boolean;
    finalLibraryPath: string;
    // True when the backend copied the library to the new location but kept the old directory in
    // place (the crash-recovery commit marker could not be written). The new library works, but a
    // full duplicate of the media remains on the old volume, so the UI warns the user about it.
    oldDirectoryRetained: boolean;
};

function createDriveRootError(): ClientError {
    return new ClientError(
        "A drive or volume root cannot be used as the library folder. Choose a regular folder instead."
    );
}

export async function planChangeLibraryPath({
    currentLibraryPath,
}: PlanChangeLibraryPathInput): Promise<LibraryPathChangePlan> {
    const normalizedCurrentLibraryPath = currentLibraryPath.trim();

    const selectedPath = (await chooseLibraryDirectory())?.trim() ?? "";

    if (!selectedPath) {
        return { kind: "unchanged" };
    }

    if (isFilesystemRootPath(selectedPath)) {
        throw createDriveRootError();
    }

    const ensuredSelectedPath = await ensureDirectoryExists(selectedPath);

    if (ensuredSelectedPath === normalizedCurrentLibraryPath) {
        return { kind: "unchanged" };
    }

    if (!normalizedCurrentLibraryPath) {
        return { kind: "apply", finalLibraryPath: ensuredSelectedPath };
    }

    // Whether the destination can take the library (empty, or holding only an interrupted move)
    // is the backend's to decide. Checking emptiness here refused the folder of an interrupted
    // move, which is exactly the one a retry has to accept.
    return {
        kind: "move",
        currentLibraryPath: normalizedCurrentLibraryPath,
        destination: ensuredSelectedPath,
    };
}

export async function moveLibrary(
    move: Pick<PendingLibraryMove, "currentLibraryPath" | "destination" | "currentFolderUnreachable">
): Promise<ExecuteChangeLibraryPathResult> {
    const migrationResult = await migrateLibraryDirectory(move.currentLibraryPath, move.destination, {
        switchWithoutMoving: move.currentFolderUnreachable,
    });

    return {
        changed: migrationResult.changed,
        finalLibraryPath: migrationResult.final_library_path,
        oldDirectoryRetained: migrationResult.old_directory_retained,
    };
}
