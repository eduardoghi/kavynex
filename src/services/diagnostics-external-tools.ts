import { TAURI_COMMANDS } from "../constants/tauri-commands";
import { invokeCommand } from "../lib/tauri-client";
import type { ExternalToolsStatus } from "../types/diagnostics";

export async function getExternalToolsStatus(): Promise<ExternalToolsStatus> {
    return invokeCommand(TAURI_COMMANDS.CHECK_EXTERNAL_TOOLS);
}