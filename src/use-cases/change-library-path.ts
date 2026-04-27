import {
    chooseLibraryDirectory,
    ensureDirectoryExists,
    isDirectoryEmpty,
    migrateLibraryDirectory,
} from "../services/library-service";

type ExecuteChangeLibraryPathInput = {
    currentLibraryPath: string;
};

export type ExecuteChangeLibraryPathResult = {
    changed: boolean;
    finalLibraryPath: string;
};

function createNonEmptyFolderError(): Error {
    return new Error(
        "The selected folder must be empty before it can be used as the library folder."
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

    const ensuredSelectedPath = await ensureDirectoryExists(normalizedSelectedPath);

    if (ensuredSelectedPath === normalizedCurrentLibraryPath) {
        return {
            changed: false,
            finalLibraryPath: normalizedCurrentLibraryPath,
        };
    }

    const destinationIsEmpty = await isDirectoryEmpty(ensuredSelectedPath);

    if (!destinationIsEmpty) {
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