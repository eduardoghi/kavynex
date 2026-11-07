import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LiveChatReplay } from "./live-chat-replay";
import type { LiveChatMessageItem } from "../../services/live-chat-service";
import { renderWithMantine } from "../../test/test-utils";

// jsdom has no layout, so the real virtualizer would mount no rows. Same mock as the panel's tests.
vi.mock("@tanstack/react-virtual", () => ({
    useVirtualizer: vi.fn(({ count }: { count: number }) => ({
        getTotalSize: () => count * 72,
        getVirtualItems: () =>
            Array.from({ length: count }, (_, index) => ({
                index,
                key: index,
                start: index * 72,
            })),
        measureElement: vi.fn(),
        measure: vi.fn(),
    })),
}));

function message(offsetMs: number, text: string): LiveChatMessageItem {
    return {
        kind: "message",
        message_id: text,
        message_offset_ms: offsetMs,
        author_name: "Author",
        author_channel_id: null,
        author_thumbnail: null,
        author_badges: [],
        message_text: text,
        message_parts: [{ type: "text", text }],
        timestamp_text: null,
        amount_text: null,
        superchat_body_color: null,
        superchat_text_color: null,
        sticker_image_url: null,
        pinned_header: null,
    };
}

function playerAt(seconds: number): HTMLMediaElement {
    const element = document.createElement("video");
    Object.defineProperty(element, "currentTime", { value: seconds, configurable: true });

    return element;
}

// What the read has delivered so far, ten minutes of a longer replay.
const READ_SO_FAR = [message(5_000, "early"), message(600_000, "minute ten")];

describe("LiveChatReplay", () => {
    it("keeps the loading state while the read has not reached the playhead", () => {
        // At an hour in, the tail of minute ten is not the chat of the moment, and showing it as if
        // it were was the defect.
        renderWithMantine(
            <LiveChatReplay
                liveChatMessages={READ_SO_FAR}
                playerElement={playerAt(3_600)}
                isLoadingLiveChat
                shellBorder="#000"
            />
        );

        expect(screen.getByText("Loading live chat replay...")).toBeInTheDocument();
        expect(screen.queryByText("minute ten")).not.toBeInTheDocument();
    });

    it("shows what was read once it passes the playhead, while the rest is still read", () => {
        renderWithMantine(
            <LiveChatReplay
                liveChatMessages={READ_SO_FAR}
                playerElement={playerAt(60)}
                isLoadingLiveChat
                shellBorder="#000"
            />
        );

        expect(screen.getByText("early")).toBeInTheDocument();
        expect(screen.queryByText("Loading live chat replay...")).not.toBeInTheDocument();
    });

    it("shows the window as usual once the read has finished", () => {
        renderWithMantine(
            <LiveChatReplay
                liveChatMessages={READ_SO_FAR}
                playerElement={playerAt(3_600)}
                isLoadingLiveChat={false}
                shellBorder="#000"
            />
        );

        expect(screen.getByText("minute ten")).toBeInTheDocument();
    });
});
