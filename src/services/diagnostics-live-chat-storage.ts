import { listLiveChatFiles } from "./live-chat-service";
import type { LiveChatStorageInfo } from "../types/diagnostics";

export async function getLiveChatStorageSummary(): Promise<LiveChatStorageInfo> {
    const files = await listLiveChatFiles();

    return {
        live_chat_files: files.length,
    };
}
