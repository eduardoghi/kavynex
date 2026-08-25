import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ChannelSidebar } from "./channel-sidebar";
import { renderWithMantine } from "../../test/test-utils";
import { describeViolations, findAccessibilityViolations } from "../../test/axe";

vi.mock("../../utils/media-utils", () => ({
    initials: vi.fn((value: string) => value.slice(0, 2).toUpperCase()),
    fileSrcFromStoredPath: vi.fn(() => ""),
}));

// jsdom gives the scroll viewport a height of 0, so the real virtualizer would render no rows.
// Mock it to yield every row (like media-grid.test.tsx) so the list assertions below still hold.
vi.mock("@tanstack/react-virtual", () => ({
    useVirtualizer: vi.fn(({ count }: { count: number }) => ({
        getTotalSize: () => count * 80,
        getVirtualItems: () =>
            Array.from({ length: count }, (_, index) => ({
                index,
                key: index,
                start: index * 80,
            })),
        measureElement: vi.fn(),
        measure: vi.fn(),
    })),
}));

describe("ChannelSidebar", () => {
    it("shows loading state", () => {
        renderWithMantine(
            <ChannelSidebar
                channels={[]}
                selectedChannelId={null}
                viewMode="library"
                shellBorder="rgba(255,255,255,0.1)"
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

        // The skeleton rows are decorative; the status region carries the visually-hidden
        // "Loading channels" text so a screen reader still announces the load.
        expect(screen.getByRole("status")).toBeInTheDocument();
        expect(screen.getByText("Loading channels")).toBeInTheDocument();
        expect(screen.getByText("...")).toBeInTheDocument();
    });

    it("states an empty list with the count alone, and carries no empty card", () => {
        renderWithMantine(
            <ChannelSidebar
                channels={[]}
                selectedChannelId={null}
                viewMode="library"
                shellBorder="rgba(255,255,255,0.1)"
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

        // The count beside the heading is the whole empty state here. The words and the button
        // for that step belong to the page, and a card repeating them made one screen say the
        // same sentence twice.
        expect(screen.getByText("CHANNELS")).toBeInTheDocument();
        expect(screen.getByText("0")).toBeInTheDocument();
        expect(screen.queryByText("No channels yet")).not.toBeInTheDocument();
    });

    it("renders the branding and app actions the sidebar now hosts", () => {
        const onOpenCreateChannel = vi.fn();
        const onOpenSettings = vi.fn();

        renderWithMantine(
            <ChannelSidebar
                channels={[]}
                selectedChannelId={null}
                viewMode="library"
                shellBorder="rgba(255,255,255,0.1)"
                loading={false}
                deletingChannelId={null}
                updatingChannelAvatarId={null}
                libraryPath="/library"
                appIconSrc="/icon.svg"
                onOpenCreateChannel={onOpenCreateChannel}
                onOpenSettings={onOpenSettings}
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

        expect(screen.getByText("Kavynex")).toBeInTheDocument();
        expect(screen.getByAltText("Kavynex")).toBeInTheDocument();

        fireEvent.click(screen.getByRole("button", { name: /new channel/i }));
        expect(onOpenCreateChannel).toHaveBeenCalledTimes(1);

        fireEvent.click(screen.getByRole("button", { name: /settings/i }));
        expect(onOpenSettings).toHaveBeenCalledTimes(1);
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

        fireEvent.click(screen.getByRole("button", { name: /open channel canal a/i }));
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

        fireEvent.click(screen.getByRole("button", { name: /open channel canal a/i }));

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

    it("exposes each channel as a positioned item of a list", () => {
        // Virtualization keeps only the rows near the viewport in the DOM, so a screen reader
        // cannot count the channels by walking it; the roles and set/position hints carry that.
        renderWithMantine(
            <ChannelSidebar
                channels={[
                    {
                        id: 1,
                        name: "Canal A",
                        youtube_handle: "@a",
                        avatar_path: null,
                        created_at: "2026-01-01T00:00:00.000Z",
                    },
                    {
                        id: 2,
                        name: "Canal B",
                        youtube_handle: "@b",
                        avatar_path: null,
                        created_at: "2026-01-02T00:00:00.000Z",
                    },
                ]}
                selectedChannelId={null}
                viewMode="library"
                shellBorder="rgba(255,255,255,0.1)"
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

        const items = screen.getAllByRole("listitem");
        expect(items).toHaveLength(2);
        expect(items.map((item) => item.getAttribute("aria-posinset"))).toEqual(["1", "2"]);
        expect(items.map((item) => item.getAttribute("aria-setsize"))).toEqual(["2", "2"]);
    });

    it("has no detectable accessibility violations with channels rendered", async () => {
        // Structural smoke check. The assertions above pin the list semantics this component has to
        // restore by hand, because virtualization means assistive technology cannot count the rows
        // by walking the DOM. This catches the rest of the tree those attributes sit in, which
        // nothing else asserts. See src/test/axe.ts for what jsdom cannot answer here.
        const { container } = renderWithMantine(
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
                loading={false}
                deletingChannelId={null}
                updatingChannelAvatarId={null}
                libraryPath="/library"
                appIconSrc="/icon.svg"
                onOpenCreateChannel={vi.fn()}
                onOpenSettings={vi.fn()}
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

        const violations = await findAccessibilityViolations(container);

        expect(describeViolations(violations)).toBe("");
    });
});