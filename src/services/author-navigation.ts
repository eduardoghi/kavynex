import { openExternalUrl } from "./library-service";
import { logError } from "../utils/app-logger";

/**
 * Best-effort: opens a YouTube channel by its external channel id (UC...) in the system
 * browser. Used by the comment and live chat panels to make authors clickable. Failures
 * are logged, not thrown, since this is a fire-and-forget UI action.
 */
export async function openAuthorYoutubeChannel(channelId: string): Promise<void> {
    const normalized = channelId.trim();

    if (!normalized) {
        return;
    }

    try {
        await openExternalUrl(`https://www.youtube.com/channel/${encodeURIComponent(normalized)}`);
    } catch (error) {
        logError("author-channel", "Failed to open author channel on YouTube.", error, {
            channelId: normalized,
        });
    }
}
