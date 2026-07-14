import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LiveChatPanel } from "./live-chat-panel";
import { renderWithMantine } from "../../test/test-utils";

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
