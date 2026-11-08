import type { FileDialogFilter } from "../services/file-dialog-service";

// What the cookies file dialog offers, for the add-media form and a batch import alike.
export const COOKIES_FILE_FILTERS: FileDialogFilter[] = [
    { name: "Cookies file", extensions: ["txt"] },
];

// A cookies file is a Netscape cookies.txt. The backend checks its header before yt-dlp reads it.
export function isCookiesTextFile(path: string): boolean {
    const normalized = path.trim().toLowerCase();

    if (!normalized) {
        return false;
    }

    return normalized.endsWith(".txt");
}
