import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MediaCardActionsMenu } from "./media-card-actions-menu";
import { createMedia } from "../../test/factories/media";
import { renderWithMantine } from "../../test/test-utils";
import { describeViolations, findAccessibilityViolations } from "../../test/axe";

type MenuProps = Parameters<typeof MediaCardActionsMenu>[0];

function renderMenu(overrides: Partial<MenuProps> = {}) {
    const props: MenuProps = {
        media: createMedia({ id: 42, title: "Video A", youtube_video_id: "abc123" }),
        isWatched: false,
        isWatchedActionInFlight: false,
        onRequestDelete: vi.fn(),
        onOpenFileLocation: vi.fn(),
        onOpenSourceInYoutube: vi.fn(),
        onMarkWatched: vi.fn(),
        onMarkUnwatched: vi.fn(),
        onEditTitle: vi.fn(),
        ...overrides,
    };

    const rendered = renderWithMantine(<MediaCardActionsMenu {...props} />);

    return { ...rendered, props };
}

const MENU_BUTTON = "Actions for Video A";

function openMenu(): void {
    fireEvent.click(screen.getByRole("button", { name: MENU_BUTTON }));
}

describe("MediaCardActionsMenu", () => {
    // One render per action: Mantine's Menu toggles on the trigger, so a second trigger click
    // inside the same render lands while the dropdown is still closing and does not reopen it.
    it.each([
        [/open file location/i, "onOpenFileLocation"],
        [/open source on youtube/i, "onOpenSourceInYoutube"],
        [/edit title/i, "onEditTitle"],
        [/mark as watched/i, "onMarkWatched"],
        [/^delete$/i, "onRequestDelete"],
    ] as const)("routes the %s action to its handler with the media", async (name, handler) => {
        const { props } = renderMenu();

        openMenu();
        fireEvent.click(await screen.findByRole("menuitem", { name }));

        expect(props[handler]).toHaveBeenCalledWith(props.media);
    });

    it("offers unwatch instead of watch once the media is watched", async () => {
        const { props } = renderMenu({ isWatched: true });

        openMenu();
        const unwatch = await screen.findByRole("menuitem", { name: /mark as unwatched/i });
        expect(screen.queryByRole("menuitem", { name: /mark as watched/i })).not.toBeInTheDocument();

        fireEvent.click(unwatch);
        expect(props.onMarkUnwatched).toHaveBeenCalledWith(props.media);
    });

    it("disables the watched toggle while one is already in flight", async () => {
        renderMenu({ isWatchedActionInFlight: true });

        openMenu();

        expect(await screen.findByRole("menuitem", { name: /mark as watched/i })).toBeDisabled();
    });

    it("hides the YouTube action for media with no YouTube source", async () => {
        // A locally imported file has no youtube_video_id, so there is nothing to open. Hidden
        // rather than disabled. The contract is that an action that cannot apply is not listed.
        renderMenu({ media: createMedia({ title: "Video A", youtube_video_id: null }) });

        openMenu();
        await screen.findByRole("menuitem", { name: /open file location/i });

        expect(
            screen.queryByRole("menuitem", { name: /open source on youtube/i })
        ).not.toBeInTheDocument();
    });

    it("shows only delete when no optional handler is given", async () => {
        renderMenu({
            onOpenFileLocation: undefined,
            onOpenSourceInYoutube: undefined,
            onMarkWatched: undefined,
            onMarkUnwatched: undefined,
            onEditTitle: undefined,
        });

        openMenu();
        const items = await screen.findAllByRole("menuitem");

        expect(items).toHaveLength(1);
        expect(items[0]).toHaveTextContent(/delete/i);
    });

    it("keeps a menu item click from bubbling to the card underneath", async () => {
        // The card is a stretched button that opens the media on any click. Choosing a menu item
        // must not also open it, which is what the dropdown's stopPropagation is for.
        const onCardClick = vi.fn();
        const onRequestDelete = vi.fn();

        renderWithMantine(
            <div onClick={onCardClick}>
                <MediaCardActionsMenu
                    media={createMedia({ title: "Video A" })}
                    isWatched={false}
                    isWatchedActionInFlight={false}
                    onRequestDelete={onRequestDelete}
                />
            </div>
        );

        openMenu();
        // Opening the menu bubbles once (the trigger sits inside the wrapper).
        expect(onCardClick).toHaveBeenCalledTimes(1);

        fireEvent.click(await screen.findByRole("menuitem", { name: /^delete$/i }));

        expect(onRequestDelete).toHaveBeenCalled();
        // The item renders in a portal with propagation stopped, so it adds nothing.
        expect(onCardClick).toHaveBeenCalledTimes(1);
    });

    it("has no accessibility violations, closed and open", async () => {
        const { container } = renderMenu();

        expect(describeViolations(await findAccessibilityViolations(container))).toBe("");

        openMenu();
        await screen.findByRole("menuitem", { name: /^delete$/i });

        // The dropdown renders in a portal, outside `container`, so check the whole document.
        expect(describeViolations(await findAccessibilityViolations(document.body))).toBe("");
    });
});
