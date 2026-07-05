import { describe, expect, it } from "vitest";
import type { Channel, MediaRow } from "../types/media";
import {
    buildItemCountLabel,
    findSelectedChannel,
    hasSelectedChannel,
} from "./controller-helpers";

function createChannel(overrides: Partial<Channel> = {}): Channel {
    return {
        id: 1,
        name: "Canal A",
        youtube_handle: "@canala",
        avatar_path: null,
        created_at: "2026-03-31T10:00:00.000Z",
        ...overrides,
    };
}

function createMediaRow(overrides: Partial<MediaRow> = {}): MediaRow {
    return {
        id: 1,
        channel_id: 10,
        title: "Item 1",
        file_path: "video/item.mp4",
        thumbnail_path: null,
        media_type: "video",
        youtube_video_id: null,
        watched_at: null,
        published_at: null,
        duration_seconds: 0,
        progress_seconds: 0,
        has_comments: 0,
        comments_count: 0,
        is_live: 0,
        has_live_chat: 0,
        live_chat_file_path: null,
        created_at: "2026-03-31T10:00:00.000Z",
        ...overrides,
    };
}

describe("controller-helpers", () => {
    it("finds selected channel", () => {
        expect(findSelectedChannel([createChannel()], 1)?.name).toBe("Canal A");
    });

    it("finds the channel matching the selected id among many", () => {
        const channels = [
            createChannel({ id: 1, name: "Canal A" }),
            createChannel({ id: 2, name: "Canal B" }),
        ];

        expect(findSelectedChannel(channels, 2)?.name).toBe("Canal B");
    });

    it("returns null when channel is not selected", () => {
        expect(findSelectedChannel([], null)).toBeNull();
        expect(findSelectedChannel([createChannel()], null)).toBeNull();
    });

    it("returns null when no channel matches the selected id", () => {
        expect(findSelectedChannel([createChannel({ id: 1 })], 99)).toBeNull();
    });

    it("builds item count label", () => {
        expect(buildItemCountLabel([])).toBe("0 item(s)");
        expect(buildItemCountLabel([createMediaRow()])).toBe("1 item(s)");
    });

    it("checks selected channel existence", () => {
        expect(hasSelectedChannel(null)).toBe(false);
        expect(hasSelectedChannel(createChannel())).toBe(true);
    });
});