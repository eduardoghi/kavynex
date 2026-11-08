import { countLiveChatFiles } from "./live-chat-service";
import type { LiveChatStorageInfo } from "../types/diagnostics";

export async function getLiveChatStorageSummary(): Promise<LiveChatStorageInfo> {
    return {
        live_chat_files: await countLiveChatFiles(),
    };
}
