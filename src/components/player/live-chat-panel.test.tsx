import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LiveChatPanel, liveChatItemKey } from "./live-chat-panel";
import type { LiveChatMessageItem } from "../../services/live-chat-service";
import { renderWithMantine } from "../../test/test-utils";

function makeChatMessage(overrides: Partial<LiveChatMessageItem> = {}): LiveChatMessageItem {
    return {
        kind: "message",
        message_id: null,
        message_offset_ms: 1000,
        author_name: "Author",
        author_channel_id: null,
        author_thumbnail: null,
        author_badges: [],
        message_text: "hello",
        message_parts: [{ type: "text", text: "hello" }],
        timestamp_text: null,
        amount_text: null,
        superchat_body_color: null,
        superchat_text_color: null,
        sticker_image_url: null,
        pinned_header: null,
        ...overrides,
    };
}

describe("liveChatItemKey", () => {
    it("uses the message id when there is one", () => {
        const message = makeChatMessage({ message_id: "abc123" });

        expect(liveChatItemKey(message)).toBe("abc123");
    });

    it("keeps the same key for a message with no id across the sliding window", () => {
        // The point of the key: the visible window is a slice, so a message's index shifts as
        // playback advances even though it is the same object. A key derived from that index
        // changes underneath React, which tears the row down and rebuilds it instead of skipping
        // it - discarding exactly the memoization LiveChatItem exists for.
        const message = makeChatMessage();

        const first = liveChatItemKey(message);
        const afterWindowAdvanced = liveChatItemKey(message);

        expect(afterWindowAdvanced).toBe(first);
    });

    it("gives two identical messages distinct keys", () => {
        // Same author, same offset, same text: indistinguishable by content, so a content-derived
        // key would collide and React would treat them as one row.
        const first = makeChatMessage();
        const second = makeChatMessage();

        expect(liveChatItemKey(first)).not.toBe(liveChatItemKey(second));
    });
});

describe("LiveChatPanel", () => {
    it("shows the load error instead of the empty state when a read fails", () => {
        renderWithMantine(
            <LiveChatPanel
                liveChatMessages={[]}
                visibleLiveChatMessages={[]}
                isLoadingLiveChat={false}
                error="Could not load the live chat replay for this media."
                shellBorder="rgba(255,255,255,0.1)"
            />
        );

        // A failed read must surface the error, not read as "there were no messages".
        expect(
            screen.getByText("Could not load the live chat replay for this media.")
        ).toBeInTheDocument();
        expect(
            screen.queryByText("No live chat messages were loaded.")
        ).not.toBeInTheDocument();
    });

    it("shows the empty state when there is no error and no messages", () => {
        renderWithMantine(
            <LiveChatPanel
                liveChatMessages={[]}
                visibleLiveChatMessages={[]}
                isLoadingLiveChat={false}
                error={null}
                shellBorder="rgba(255,255,255,0.1)"
            />
        );

        expect(
            screen.getByText("No live chat messages were loaded.")
        ).toBeInTheDocument();
    });
});
