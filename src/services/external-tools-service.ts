import type { ExternalToolsStatus } from "../types/diagnostics";
import { getExternalToolsStatus } from "./diagnostics-external-tools";

export async function loadExternalToolsStatus(): Promise<ExternalToolsStatus> {
    return getExternalToolsStatus();
}