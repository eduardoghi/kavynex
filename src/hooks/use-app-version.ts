import { useEffect, useState } from "react";
import { getVersion } from "../lib/tauri-platform";
import { logError } from "../utils/app-logger";

// Loads the running app version once, for display next to the wordmark. Returns null until it
// resolves and stays null if the lookup fails, so a broken read renders nothing rather than a
// half-formed "v..." string.
export function useAppVersion(): string | null {
    const [version, setVersion] = useState<string | null>(null);

    useEffect(() => {
        getVersion()
            .then(setVersion)
            .catch((error) => {
                logError("app-version", "Failed to read the app version.", error);
            });
    }, []);

    return version;
}
