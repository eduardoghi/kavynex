import { TAURI_COMMANDS } from "../constants/tauri-commands";
import { invokeCommand } from "../lib/tauri-client";
import type { KeptFilesSummary } from "../types/diagnostics";

// How many files the library trash and the recovered downloads folder hold. Diagnostics shows each
// as an issue with a button to open the folder, since both are folders a user would not find.
export async function getKeptFilesSummary(): Promise<KeptFilesSummary> {
    return invokeCommand(TAURI_COMMANDS.GET_KEPT_FILES_SUMMARY);
}
