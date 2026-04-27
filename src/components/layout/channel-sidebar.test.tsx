import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ChannelSidebar } from "./channel-sidebar";
import { renderWithMantine } from "../../test/test-utils";

vi.mock("../../utils/media-utils", () => ({
    initials: vi.fn((value: string) => value.slice(0, 2).toUpperCase()),
    fileSrcFromStoredPath: vi.fn(() => ""),
}));

describe("ChannelSidebar", () => {
    it("shows loading state", () => {
        renderWithMantine(
            <ChannelSidebar
                channels={[]}
                selectedChannelId={null}
                viewMode="library"
                shellBorder="rgba(255,255,255,0.1)"
                shellSurface="rgba(255,255,255,0.03)"
                loading
                deletingChannelId={null}
                updatingChannelAvatarId={null}
                libraryPath="/library"
                onSelectChannel={vi.fn()}
                onRequestEditChannel={vi.fn()}
                onRequestDeleteChannel={vi.fn()}
                onUpdateChannelAvatarFromFile={vi.fn()}
                onUpdateChannelAvatarFromYouTube={vi.fn()}
                onRemoveChannelAvatar={vi.fn()}
                onClosePlayer={vi.fn()}
            />,
            { withAppShell: true }
        );

        expect(screen.getByText("Loading channels...")).toBeInTheDocument();
        expect(screen.getByText("...")).toBeInTheDocument();
    });

    it("shows empty state", () => {
        renderWithMantine(
            <ChannelSidebar
                channels={[]}
                selectedChannelId={null}
                viewMode="library"
                shellBorder="rgba(255,255,255,0.1)"
                shellSurface="rgba(255,255,255,0.03)"
                loading={false}
                deletingChannelId={null}
                updatingChannelAvatarId={null}
                libraryPath="/library"
                onSelectChannel={vi.fn()}
                onRequestEditChannel={vi.fn()}
                onRequestDeleteChannel={vi.fn()}
                onUpdateChannelAvatarFromFile={vi.fn()}
                onUpdateChannelAvatarFromYouTube={vi.fn()}
                onRemoveChannelAvatar={vi.fn()}
                onClosePlayer={vi.fn()}
            />,
            { withAppShell: true }
        );

        expect(screen.getByText("No channels yet")).toBeInTheDocument();

        const description = screen.getByText((_, element) => {
            return (
                element?.tagName.toLowerCase() === "p" &&
                element.textContent?.includes("Use") === true &&
                element.textContent?.includes("New channel") === true &&
                element.textContent?.includes("in the top bar to create your first one.") === true
            );
        });

        expect(description).toBeInTheDocument();
        expect(description).toHaveTextContent(
            "Use New channel in the top bar to create your first one."
        );
    });

    it("renders channel list and badge count", () => {
        renderWithMantine(
            <ChannelSidebar
                channels={[
                    {
                        id: 10,
                        name: "Canal A",
                        youtube_handle: "@canala",
                        avatar_path: null,
                        created_at: "2026-03-31T10:00:00.000Z",
                    },
                    {
                        id: 20,
                        name: "Canal B",
                        youtube_handle: "@canalb",
                        avatar_path: null,
                        created_at: "2026-03-31T10:00:00.000Z",
                    },
                ]}
                selectedChannelId={10}
                viewMode="library"
                shellBorder="rgba(255,255,255,0.1)"
                shellSurface="rgba(255,255,255,0.03)"
                loading={false}
                deletingChannelId={null}
                updatingChannelAvatarId={null}
                libraryPath="/library"
                onSelectChannel={vi.fn()}
                onRequestEditChannel={vi.fn()}
                onRequestDeleteChannel={vi.fn()}
                onUpdateChannelAvatarFromFile={vi.fn()}
                onUpdateChannelAvatarFromYouTube={vi.fn()}
                onRemoveChannelAvatar={vi.fn()}
                onClosePlayer={vi.fn()}
            />,
            { withAppShell: true }
        );

        expect(screen.getByText("Canal A")).toBeInTheDocument();
        expect(screen.getByText("Canal B")).toBeInTheDocument();
        expect(screen.getByText("@canala")).toBeInTheDocument();
        expect(screen.getByText("@canalb")).toBeInTheDocument();
        expect(screen.getByText("2")).toBeInTheDocument();
    });

    it("selects channel on click", () => {
        const onSelectChannel = vi.fn();

        renderWithMantine(
            <ChannelSidebar
                channels={[
                    {
                        id: 10,
                        name: "Canal A",
                        youtube_handle: "@canala",
                        avatar_path: null,
                        created_at: "2026-03-31T10:00:00.000Z",
                    },
                ]}
                selectedChannelId={null}
                viewMode="library"
                shellBorder="rgba(255,255,255,0.1)"
                shellSurface="rgba(255,255,255,0.03)"
                loading={false}
                deletingChannelId={null}
                updatingChannelAvatarId={null}
                libraryPath="/library"
                onSelectChannel={onSelectChannel}
                onRequestEditChannel={vi.fn()}
                onRequestDeleteChannel={vi.fn()}
                onUpdateChannelAvatarFromFile={vi.fn()}
                onUpdateChannelAvatarFromYouTube={vi.fn()}
                onRemoveChannelAvatar={vi.fn()}
                onClosePlayer={vi.fn()}
            />,
            { withAppShell: true }
        );

        fireEvent.click(screen.getByText("Canal A"));
        expect(onSelectChannel).toHaveBeenCalledWith(10);
    });

    it("closes player when selecting a channel while player view is active", () => {
        const onSelectChannel = vi.fn();
        const onClosePlayer = vi.fn();

        renderWithMantine(
            <ChannelSidebar
                channels={[
                    {
                        id: 10,
                        name: "Canal A",
                        youtube_handle: "@canala",
                        avatar_path: null,
                        created_at: "2026-03-31T10:00:00.000Z",
                    },
                ]}
                selectedChannelId={null}
                viewMode="player"
                shellBorder="rgba(255,255,255,0.1)"
                shellSurface="rgba(255,255,255,0.03)"
                loading={false}
                deletingChannelId={null}
                updatingChannelAvatarId={null}
                libraryPath="/library"
                onSelectChannel={onSelectChannel}
                onRequestEditChannel={vi.fn()}
                onRequestDeleteChannel={vi.fn()}
                onUpdateChannelAvatarFromFile={vi.fn()}
                onUpdateChannelAvatarFromYouTube={vi.fn()}
                onRemoveChannelAvatar={vi.fn()}
                onClosePlayer={onClosePlayer}
            />,
            { withAppShell: true }
        );

        fireEvent.click(screen.getByText("Canal A"));

        expect(onSelectChannel).toHaveBeenCalledWith(10);
        expect(onClosePlayer).toHaveBeenCalled();
    });

    it("shows loader for deleting channel", () => {
        renderWithMantine(
            <ChannelSidebar
                channels={[
                    {
                        id: 10,
                        name: "Canal A",
                        youtube_handle: "@canala",
                        avatar_path: null,
                        created_at: "2026-03-31T10:00:00.000Z",
                    },
                ]}
                selectedChannelId={10}
                viewMode="library"
                shellBorder="rgba(255,255,255,0.1)"
                shellSurface="rgba(255,255,255,0.03)"
                loading={false}
                deletingChannelId={10}
                updatingChannelAvatarId={null}
                libraryPath="/library"
                onSelectChannel={vi.fn()}
                onRequestEditChannel={vi.fn()}
                onRequestDeleteChannel={vi.fn()}
                onUpdateChannelAvatarFromFile={vi.fn()}
                onUpdateChannelAvatarFromYouTube={vi.fn()}
                onRemoveChannelAvatar={vi.fn()}
                onClosePlayer={vi.fn()}
            />,
            { withAppShell: true }
        );

        expect(screen.queryByLabelText(/actions for canal a/i)).not.toBeInTheDocument();
    });

    it("requests edit from channel menu", async () => {
        const channel = {
            id: 10,
            name: "Canal A",
            youtube_handle: "@canala",
            avatar_path: null,
            created_at: "2026-03-31T10:00:00.000Z",
        };

        const onRequestEditChannel = vi.fn();

        renderWithMantine(
            <ChannelSidebar
                channels={[channel]}
                selectedChannelId={10}
                viewMode="library"
                shellBorder="rgba(255,255,255,0.1)"
                shellSurface="rgba(255,255,255,0.03)"
                loading={false}
                deletingChannelId={null}
                updatingChannelAvatarId={null}
                libraryPath="/library"
                onSelectChannel={vi.fn()}
                onRequestEditChannel={onRequestEditChannel}
                onRequestDeleteChannel={vi.fn()}
                onUpdateChannelAvatarFromFile={vi.fn()}
                onUpdateChannelAvatarFromYouTube={vi.fn()}
                onRemoveChannelAvatar={vi.fn()}
                onClosePlayer={vi.fn()}
            />,
            { withAppShell: true }
        );

        fireEvent.click(screen.getByLabelText(/actions for canal a/i));
        fireEvent.click(await screen.findByRole("menuitem", { name: /edit name \/ handle/i }));

        expect(onRequestEditChannel).toHaveBeenCalledWith(channel);
    });

    it("requests delete from channel menu", async () => {
        const channel = {
            id: 10,
            name: "Canal A",
            youtube_handle: "@canala",
            avatar_path: null,
            created_at: "2026-03-31T10:00:00.000Z",
        };

        const onRequestDeleteChannel = vi.fn();

        renderWithMantine(
            <ChannelSidebar
                channels={[channel]}
                selectedChannelId={10}
                viewMode="library"
                shellBorder="rgba(255,255,255,0.1)"
                shellSurface="rgba(255,255,255,0.03)"
                loading={false}
                deletingChannelId={null}
                updatingChannelAvatarId={null}
                libraryPath="/library"
                onSelectChannel={vi.fn()}
                onRequestEditChannel={vi.fn()}
                onRequestDeleteChannel={onRequestDeleteChannel}
                onUpdateChannelAvatarFromFile={vi.fn()}
                onUpdateChannelAvatarFromYouTube={vi.fn()}
                onRemoveChannelAvatar={vi.fn()}
                onClosePlayer={vi.fn()}
            />,
            { withAppShell: true }
        );

        fireEvent.click(screen.getByLabelText(/actions for canal a/i));
        fireEvent.click(await screen.findByRole("menuitem", { name: /delete channel/i }));

        expect(onRequestDeleteChannel).toHaveBeenCalledWith(channel);
    });
});