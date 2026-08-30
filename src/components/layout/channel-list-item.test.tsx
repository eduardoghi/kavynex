import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ChannelListItem } from "./channel-list-item";
import type { Channel } from "../../types/media";
import { renderWithMantine } from "../../test/test-utils";
import { describeViolations, findAccessibilityViolations } from "../../test/axe";

vi.mock("../../utils/media-utils", () => ({
    initials: vi.fn((value: string) => value.slice(0, 2).toUpperCase()),
    fileSrcFromStoredPath: vi.fn((path: string | null) => (path ? `asset://${path}` : "")),
}));

function createChannel(overrides: Partial<Channel> = {}): Channel {
    return {
        id: 7,
        name: "Canal A",
        youtube_handle: "@canala",
        avatar_path: null,
        created_at: "2026-03-31T10:00:00.000Z",
        ...overrides,
    };
}

type ItemProps = Parameters<typeof ChannelListItem>[0];

function renderItem(overrides: Partial<ItemProps> = {}) {
    const props: ItemProps = {
        channel: createChannel(),
        selected: false,
        isDeleting: false,
        isUpdatingAvatar: false,
        viewMode: "library",
        shellBorder: "rgba(255,255,255,0.1)",
        libraryPath: "/library",
        onSelectChannel: vi.fn(),
        onRequestEditChannel: vi.fn(),
        onRequestDeleteChannel: vi.fn(),
        onUpdateChannelAvatarFromFile: vi.fn(),
        onUpdateChannelAvatarFromYouTube: vi.fn(),
        onRemoveChannelAvatar: vi.fn(),
        onClosePlayer: vi.fn(),
        ...overrides,
    };

    const rendered = renderWithMantine(<ChannelListItem {...props} />);

    return { ...rendered, props };
}

const OPEN_BUTTON = "Open channel Canal A";
const MENU_BUTTON = "Actions for Canal A";

describe("ChannelListItem", () => {
    it("renders the channel and selects it through the stretched button", () => {
        const { props } = renderItem();

        expect(screen.getByText("Canal A")).toBeInTheDocument();
        expect(screen.getByText("@canala")).toBeInTheDocument();

        fireEvent.click(screen.getByRole("button", { name: OPEN_BUTTON }));

        expect(props.onSelectChannel).toHaveBeenCalledWith(7);
        expect(props.onClosePlayer).not.toHaveBeenCalled();
    });

    it("closes the player when a channel is picked while it is open", () => {
        // Switching channel from inside the player would otherwise leave a player showing media
        // of the channel that is no longer selected.
        const { props } = renderItem({ viewMode: "player" });

        fireEvent.click(screen.getByRole("button", { name: OPEN_BUTTON }));

        expect(props.onSelectChannel).toHaveBeenCalledWith(7);
        expect(props.onClosePlayer).toHaveBeenCalledTimes(1);
    });

    it("marks the selected row as current", () => {
        renderItem({ selected: true });

        expect(screen.getByRole("button", { name: OPEN_BUTTON })).toHaveAttribute(
            "aria-current",
            "true"
        );
    });

    it("shows a monogram without an avatar and a decorative image with one", () => {
        const { unmount } = renderItem();
        expect(screen.getByText("CA")).toBeInTheDocument();
        unmount();

        renderItem({ channel: createChannel({ avatar_path: "thumbnails/avatar.jpg" }) });
        // `alt=""` takes the image out of the accessibility tree (the name is the next thing in
        // the row), so it is queried as a plain element rather than by the img role.
        const image = document.querySelector("img");
        expect(image).toHaveAttribute("src", "asset://thumbnails/avatar.jpg");
        expect(image).toHaveAttribute("alt", "");
    });

    // One render per action: Mantine's Menu toggles on the trigger, so a second trigger click
    // inside the same render lands while the dropdown is still closing and does not reopen it.
    it.each([
        [/edit name \/ handle/i, "onRequestEditChannel"],
        [/choose avatar file/i, "onUpdateChannelAvatarFromFile"],
        [/load avatar from youtube/i, "onUpdateChannelAvatarFromYouTube"],
        [/remove avatar/i, "onRemoveChannelAvatar"],
        [/delete channel/i, "onRequestDeleteChannel"],
    ] as const)("routes the %s menu action to its handler with the channel", async (name, handler) => {
        const { props } = renderItem({
            channel: createChannel({ avatar_path: "thumbnails/avatar.jpg" }),
        });

        fireEvent.click(screen.getByRole("button", { name: MENU_BUTTON }));
        fireEvent.click(await screen.findByRole("menuitem", { name }));

        expect(props[handler]).toHaveBeenCalledWith(props.channel);
        // Choosing from the menu must not also select the channel. The menu sits above the
        // stretched button and stops the click from reaching it.
        expect(props.onSelectChannel).not.toHaveBeenCalled();
    });

    it("disables removing the avatar when there is none to remove", async () => {
        renderItem();

        fireEvent.click(screen.getByRole("button", { name: MENU_BUTTON }));

        expect(await screen.findByRole("menuitem", { name: /remove avatar/i })).toBeDisabled();
    });

    it("replaces the menu with a busy indicator while a delete or avatar update is in flight", () => {
        const { unmount } = renderItem({ isDeleting: true });

        expect(screen.queryByRole("button", { name: MENU_BUTTON })).not.toBeInTheDocument();
        // The busy flag sits on the card, so assistive tech is told the row is changing.
        expect(document.querySelector('[aria-busy="true"]')).not.toBeNull();
        expect(screen.getByRole("button", { name: OPEN_BUTTON })).toBeDisabled();
        unmount();

        renderItem({ isUpdatingAvatar: true });

        expect(screen.queryByRole("button", { name: MENU_BUTTON })).not.toBeInTheDocument();
        expect(document.querySelector('[aria-busy="true"]')).not.toBeNull();
    });

    it("has no accessibility violations, closed and with the menu open", async () => {
        const { container } = renderItem({
            channel: createChannel({ avatar_path: "thumbnails/avatar.jpg" }),
        });

        expect(describeViolations(await findAccessibilityViolations(container))).toBe("");

        fireEvent.click(screen.getByRole("button", { name: MENU_BUTTON }));
        await screen.findByRole("menuitem", { name: /delete channel/i });

        // The menu renders in a portal, outside `container`, so the check runs over the document.
        expect(describeViolations(await findAccessibilityViolations(document.body))).toBe("");
    });
});
