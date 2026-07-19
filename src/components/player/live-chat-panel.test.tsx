import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LiveChatPanel, liveChatItemKey } from "./live-chat-panel";
import type { LiveChatMessageItem } from "../../services/live-chat-service";
import { RemoteImagesProvider } from "./remote-images-context";
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
    it("renders a super sticker whose purchase amount could not be parsed", () => {
        // A sticker carries no message_text and its image lives in sticker_image_url, which only
        // the super chat row renders. Dispatching on amount_text being present dropped a sticker
        // with an unparsed amount into the regular row, where it showed as a near-empty line with
        // the image gone.
        const sticker = makeChatMessage({
            kind: "sticker",
            amount_text: null,
            message_text: "",
            message_parts: [],
            sticker_image_url: "https://lh3.googleusercontent.com/sticker.png",
            author_name: "Buyer",
        });

        renderWithMantine(
            <RemoteImagesProvider value={true}>
                <LiveChatPanel
                    liveChatMessages={[sticker]}
                    visibleLiveChatMessages={[sticker]}
                    activePin={null}
                    isLoadingLiveChat={false}
                    shellBorder="rgba(255,255,255,0.1)"
                />
            </RemoteImagesProvider>
        );

        expect(screen.getByRole("img", { name: "Super Sticker" })).toBeInTheDocument();
    });

    it("announces additions in the live region during ordinary playback", () => {
        const message = makeChatMessage();

        renderWithMantine(
            <LiveChatPanel
                liveChatMessages={[message]}
                visibleLiveChatMessages={[message]}
                activePin={null}
                isLoadingLiveChat={false}
                shellBorder="rgba(255,255,255,0.1)"
            />
        );

        // Default (and steady-state playback): the log region politely announces each message as
        // it scrolls in.
        expect(screen.getByRole("log", { name: "Live chat messages" })).toHaveAttribute(
            "aria-live",
            "polite"
        );
    });

    it("suppresses live-region announcements while a seek is in progress", () => {
        const message = makeChatMessage();

        renderWithMantine(
            <LiveChatPanel
                liveChatMessages={[message]}
                visibleLiveChatMessages={[message]}
                activePin={null}
                isLoadingLiveChat={false}
                announceAdditions={false}
                shellBorder="rgba(255,255,255,0.1)"
            />
        );

        // During a seek the whole visible window is replaced at once; the region must go silent so
        // a screen reader is not flooded with up to 200 "new" messages that are really a jump.
        expect(screen.getByRole("log", { name: "Live chat messages" })).toHaveAttribute(
            "aria-live",
            "off"
        );
    });

    it("shows the load error instead of the empty state when a read fails", () => {
        renderWithMantine(
            <LiveChatPanel
                liveChatMessages={[]}
                visibleLiveChatMessages={[]}
                activePin={null}
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

    it("shows the active pin banner even when the pin is not in the visible window", () => {
        // The pin was set long ago and has scrolled out of the capped visible window, but the parent
        // still resolves it as the active pin from the full list. The banner must render regardless.
        const pin = makeChatMessage({
            kind: "pinned",
            message_id: "pinned-1",
            message_text: "Pinned announcement",
            message_parts: [{ type: "text", text: "Pinned announcement" }],
        });
        const recent = makeChatMessage({ message_id: "recent-1", message_text: "later message" });

        renderWithMantine(
            <LiveChatPanel
                liveChatMessages={[pin, recent]}
                visibleLiveChatMessages={[recent]}
                activePin={pin}
                isLoadingLiveChat={false}
                shellBorder="rgba(255,255,255,0.1)"
            />
        );

        expect(screen.getByText("Pinned announcement")).toBeInTheDocument();
    });

    it("shows the empty state when there is no error and no messages", () => {
        renderWithMantine(
            <LiveChatPanel
                liveChatMessages={[]}
                visibleLiveChatMessages={[]}
                activePin={null}
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
