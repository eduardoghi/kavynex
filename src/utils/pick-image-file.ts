import { openFileDialog } from "../lib/tauri-platform";
import { IMAGE_FILE_EXTENSIONS } from "./media-utils";

// Opens the OS file picker filtered to the image types Kavynex accepts as a thumbnail or channel
// avatar (IMAGE_FILE_EXTENSIONS) and returns the chosen path trimmed, or null when the user
// cancels or the selection is empty. It deliberately does not catch a dialog failure - the caller
// surfaces a context-specific error message (e.g. "Failed to select avatar file.").
export async function pickImageFilePath(): Promise<string | null> {
    const selection = await openFileDialog({
        multiple: false,
        directory: false,
        filters: [
            {
                name: "Images",
                extensions: [...IMAGE_FILE_EXTENSIONS],
            },
        ],
    });

    if (typeof selection !== "string") {
        return null;
    }

    const normalizedPath = selection.trim();

    return normalizedPath ? normalizedPath : null;
}
