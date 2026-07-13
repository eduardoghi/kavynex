import {
    chooseLibraryDirectory,
    ensureDirectoryExists,
    isDirectoryEmpty,
    migrateLibraryDirectory,
} from "../services/library-service";
import { isFilesystemRootPath } from "../utils/paths";
import { ClientError } from "../utils/app-error";

type ExecuteChangeLibraryPathInput = {
    currentLibraryPath: string;
};

export type ExecuteChangeLibraryPathResult = {
    changed: boolean;
    finalLibraryPath: string;
};

function createNonEmptyFolderError(): ClientError {
    return new ClientError(
        "The selected folder must be empty before it can be used as the library folder."
    );
}

function createDriveRootError(): ClientError {
    return new ClientError(
        "A drive or volume root cannot be used as the library folder. Choose a regular folder instead."
    );
}

export async function executeChangeLibraryPath({
    currentLibraryPath,
}: ExecuteChangeLibraryPathInput): Promise<ExecuteChangeLibraryPathResult> {
    const normalizedCurrentLibraryPath = currentLibraryPath.trim();

    const selectedPath = await chooseLibraryDirectory();

    if (!selectedPath) {
        return {
            changed: false,
            finalLibraryPath: normalizedCurrentLibraryPath,
        };
    }

    const normalizedSelectedPath = selectedPath.trim();

    if (!normalizedSelectedPath) {
        return {
            changed: false,
            finalLibraryPath: normalizedCurrentLibraryPath,
        };
    }

    if (isFilesystemRootPath(normalizedSelectedPath)) {
        throw createDriveRootError();
    }

    const ensuredSelectedPath = await ensureDirectoryExists(normalizedSelectedPath);

    if (ensuredSelectedPath === normalizedCurrentLibraryPath) {
        return {
            changed: false,
            finalLibraryPath: normalizedCurrentLibraryPath,
        };
    }

    const destinationIsEmpty = await isDirectoryEmpty(ensuredSelectedPath);

    if (!destinationIsEmpty && normalizedCurrentLibraryPath) {
        throw createNonEmptyFolderError();
    }

    if (!normalizedCurrentLibraryPath) {
        return {
            changed: true,
            finalLibraryPath: ensuredSelectedPath,
        };
    }

    const migrationResult = await migrateLibraryDirectory(
        normalizedCurrentLibraryPath,
        ensuredSelectedPath
    );

    return {
        changed: migrationResult.changed,
        finalLibraryPath: migrationResult.final_library_path,
    };
}