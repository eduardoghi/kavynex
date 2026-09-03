import { fireEvent, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MediaRow } from "../types/media";
import type { HomeController } from "../types/controllers";
import { createMedia } from "../test/factories/media";
import { renderWithMantine } from "../test/test-utils";
import { UI_TEXT } from "../constants/ui-text";

// Home is presentation plus wiring. Every hook it composes and every section it renders has a
// test of its own. What nothing else pins is the page itself, which is why the children are
// replaced with stubs that record the props they were handed. A stub that rendered the real
// component would re-test the component; a stub that records the props tests the page.
vi.mock("../hooks/home/use-home-controller", () => ({
    useHomeController: vi.fn(),
}));

vi.mock("../hooks/home/use-home-media-title-editing", () => ({
    useHomeMediaTitleEditing: () => ({
        editTitleMedia: null,
        isSavingTitle: false,
        handleEditTitle: vi.fn(),
        closeEditTitle: vi.fn(),
        handleSaveMediaTitle: vi.fn(),
    }),
}));

vi.mock("../hooks/home/use-home-diagnostics-focus", () => ({
    useHomeDiagnosticsFocus: () => ({
        focusMediaId: null,
        handleFocusMediaHandled: vi.fn(),
        handleOpenDiagnosticsMedia: vi.fn(),
    }),
}));

vi.mock("../utils/global-error-reporting", () => ({
    reportFatalError: vi.fn(),
}));

vi.mock("../components/layout/channel-sidebar", () => ({
    ChannelSidebar: () => <div data-testid="channel-sidebar" />,
}));

vi.mock("../components/home/home-modals", () => ({
    HomeModals: () => <div data-testid="home-modals" />,
}));

vi.mock("../components/modals/edit-media-title-modal", () => ({
    EditMediaTitleModal: () => null,
}));

// The player stub can be told to throw, which is how the boundary around it is exercised
// without a real crash inside the real component.
let playerShouldThrow = false;

vi.mock("../components/player/media-player-view", () => ({
    MediaPlayerView: ({ media }: { media: MediaRow | null }) => {
        if (playerShouldThrow) {
            throw new Error("player render crashed");
        }

        return <div data-testid="media-player">{media?.title}</div>;
    },
}));

// The library stub exposes one card action as a button, so the page's own handler (the one
// it builds with useCallback and hands down) is what gets exercised, not the grid's.
type LibrarySectionStubProps = {
    mediaItems: MediaRow[];
    cardActions: {
        onMarkWatched: (item: MediaRow) => void;
        onOpenSourceInYoutube: (item: MediaRow) => void;
    };
    onBack: () => void;
};

vi.mock("../components/home/selected-channel-library-section", () => ({
    SelectedChannelLibrarySection: ({ mediaItems, cardActions, onBack }: LibrarySectionStubProps) => (
        <div data-testid="library-section">
            {mediaItems.map((item) => (
                <button
                    key={item.id}
                    type="button"
                    onClick={() => cardActions.onMarkWatched(item)}
                >
                    {`mark ${item.id}`}
                </button>
            ))}
            <button type="button" onClick={() => cardActions.onOpenSourceInYoutube(mediaItems[0]!)}>
                open source
            </button>
            <button type="button" onClick={onBack}>
                back
            </button>
        </div>
    ),
}));

import Home from "./Home";
import { useHomeController } from "../hooks/home/use-home-controller";

type ViewStateOverrides = Partial<HomeController["viewState"]>;

const channel = { id: 7, name: "Channel", youtube_handle: "@channel", avatar_path: null };
const item = createMedia({ id: 42, channel_id: 7, title: "Clip" });

// Only the fields Home reads are given real values; everything else is the minimum that keeps
// the stubbed children satisfied. The cast is deliberate. Building every nested controller in
// full would be a page of mocks for fields the page never touches, and the children that would
// read them are stubs.
function controller(overrides: {
    viewState?: ViewStateOverrides;
    selectedChannel?: typeof channel | null;
    showSelectedChannelPanel?: boolean;
    playerMedia?: MediaRow | null;
}): HomeController {
    const markAsWatched = vi.fn().mockResolvedValue(undefined);
    const markAsUnwatched = vi.fn().mockResolvedValue(undefined);
    const openMediaSourceInYoutube = vi.fn().mockResolvedValue(undefined);
    const setSelectedChannelId = vi.fn();
    const setCreateChannelOpen = vi.fn();
    const closePlayer = vi.fn().mockResolvedValue(undefined);

    const selectedChannel =
        overrides.selectedChannel === undefined ? channel : overrides.selectedChannel;

    const partial = {
        channels: {
            channels: selectedChannel ? [selectedChannel] : [],
            selectedChannelId: selectedChannel?.id ?? null,
            selectedChannel,
            isLoadingChannels: false,
            channelToDelete: null,
            channelToDeleteMediaCount: null,
            updatingChannelAvatarId: null,
            setCreateChannelOpen,
            setSelectedChannelId,
            requestEditChannel: vi.fn(),
            requestDeleteChannel: vi.fn(),
            updateChannelAvatarFromFile: vi.fn(),
            updateChannelAvatarFromYouTube: vi.fn(),
            removeChannelAvatar: vi.fn(),
        },
        media: {
            mediaPlayer: {
                viewMode: overrides.playerMedia ? "player" : "library",
                activeMedia: overrides.playerMedia ?? null,
                openPlayer: vi.fn(),
            },
            openMediaFileLocation: vi.fn(),
            openMediaSourceInYoutube,
            isLoadingMedia: false,
            mediaItems: [item],
            mediaTotal: 1,
            channelMediaTotal: 1,
            hasMoreMedia: false,
            isLoadingMoreMedia: false,
            applyMediaQuery: vi.fn(),
            loadMoreMedia: vi.fn(),
            setAddMediaOpen: vi.fn(),
            requestDeleteMedia: vi.fn(),
        },
        settings: {
            openSettings: vi.fn(),
            chooseLibraryPath: vi.fn().mockResolvedValue(undefined),
            isMigratingLibraryPath: false,
            settings: { loadRemoteImages: false },
        },
        diagnostics: { closeDiagnostics: vi.fn() },
        error: {},
        databaseRecovery: {},
        uiGuards: {},
        mediaActions: {
            markAsWatched,
            markAsUnwatched,
            editMediaTitle: vi.fn(),
            watchedActionInFlight: () => false,
        },
        playerActions: {
            closePlayer,
            isRefreshingComments: false,
            isUpdatingWatchedStatus: false,
            openInYoutube: vi.fn(),
            openFileLocation: vi.fn(),
            refreshComments: vi.fn(),
            cancelRefreshComments: vi.fn(),
            markActiveAsWatched: vi.fn(),
            markActiveAsUnwatched: vi.fn(),
            saveProgress: vi.fn(),
        },
        playerPanelState: {
            media: overrides.playerMedia ?? null,
            mediaSrc: "",
            thumbnailSrc: "",
            isAudio: false,
            canOpenInYoutube: false,
            isWatched: false,
        },
        viewState: {
            shellSurface: "#fff",
            shellBorder: "#000",
            pageBackground: "#eee",
            showLoading: false,
            showEmpty: false,
            showSelectChannelPrompt: false,
            showLibrarySetup: false,
            showLibrary: true,
            showPlayer: false,
            ...overrides.viewState,
        },
        libraryPanelState: {
            showSelectedChannelPanel: overrides.showSelectedChannelPanel ?? true,
            itemCountLabel: "1 item",
            disableAddMedia: false,
        },
        libraryPath: "/library",
    };

    return partial as unknown as HomeController;
}

describe("Home", () => {
    beforeEach(() => {
        playerShouldThrow = false;
    });

    it("shows the loading skeleton, the empty state and the select prompt for their view states", () => {
        vi.mocked(useHomeController).mockReturnValue(
            controller({
                viewState: { showLoading: true, showLibrary: false },
                selectedChannel: null,
            })
        );
        const loading = renderWithMantine(<Home />);
        expect(screen.getByText(UI_TEXT.home.loadingApp)).toBeInTheDocument();
        expect(screen.queryByTestId("library-section")).not.toBeInTheDocument();
        loading.unmount();

        const empty = controller({
            viewState: { showEmpty: true, showLibrary: false },
            selectedChannel: null,
        });
        vi.mocked(useHomeController).mockReturnValue(empty);
        const emptyRender = renderWithMantine(<Home />);
        fireEvent.click(screen.getByRole("button", { name: UI_TEXT.home.emptyAction }));
        expect(empty.channels.setCreateChannelOpen).toHaveBeenCalledWith(true);
        emptyRender.unmount();

        vi.mocked(useHomeController).mockReturnValue(
            controller({
                viewState: { showSelectChannelPrompt: true, showLibrary: false },
                selectedChannel: null,
            })
        );
        renderWithMantine(<Home />);
        expect(screen.getByText(UI_TEXT.home.selectChannelPrompt)).toBeInTheDocument();
    });

    it("offers both first-run steps in one empty state, with the folder first", () => {
        // A fresh install needs a folder and a channel, and they are one errand rather than two
        // screens. The folder line states what the app is missing, and its button reaches the
        // Home-level chooseLibraryPath (the one carrying the UI guards), not the raw settings
        // action. New channel stays live beside it because creating a channel needs no folder,
        // only importing an avatar does, so it is second rather than blocked.
        const ctrl = controller({
            viewState: { showLibrarySetup: true, showEmpty: true, showLibrary: false },
            selectedChannel: null,
        });
        vi.mocked(useHomeController).mockReturnValue(ctrl);
        renderWithMantine(<Home />);

        expect(screen.getByText(UI_TEXT.home.emptyTitle)).toBeInTheDocument();
        expect(
            screen.getByText(UI_TEXT.home.emptyDescriptionNeedsLibrary)
        ).toBeInTheDocument();
        expect(screen.getByText(UI_TEXT.home.librarySetupTitle)).toBeInTheDocument();

        const newChannel = screen.getByRole("button", { name: UI_TEXT.home.emptyAction });
        expect(newChannel).toBeEnabled();

        fireEvent.click(screen.getByRole("button", { name: UI_TEXT.home.librarySetupAction }));
        expect(ctrl.settings.chooseLibraryPath).toHaveBeenCalledTimes(1);

        fireEvent.click(newChannel);
        expect(ctrl.channels.setCreateChannelOpen).toHaveBeenCalledWith(true);
    });

    it("drops the folder half of the empty state once one is configured", () => {
        // The folder belongs to Settings from here on, so neither the state line nor its action
        // has anything left to say, and the description loses the step that is done.
        vi.mocked(useHomeController).mockReturnValue(
            controller({
                viewState: { showLibrarySetup: false, showEmpty: true, showLibrary: false },
                selectedChannel: null,
            })
        );
        renderWithMantine(<Home />);

        expect(screen.getByText(UI_TEXT.home.emptyDescription)).toBeInTheDocument();
        expect(screen.queryByText(UI_TEXT.home.librarySetupTitle)).not.toBeInTheDocument();
        expect(
            screen.queryByRole("button", { name: UI_TEXT.home.librarySetupAction })
        ).not.toBeInTheDocument();
        expect(
            screen.getByRole("button", { name: UI_TEXT.home.emptyAction })
        ).toBeInTheDocument();
    });

    it("renders the library section only when a channel is selected and the panel is on", () => {
        vi.mocked(useHomeController).mockReturnValue(controller({}));
        const withChannel = renderWithMantine(<Home />);
        expect(screen.getByTestId("library-section")).toBeInTheDocument();
        withChannel.unmount();

        // The panel flag alone is not enough. The section is keyed by the selected channel, so a
        // panel asked to show with no channel behind it renders nothing rather than crashing on
        // `selectedChannel.id`.
        vi.mocked(useHomeController).mockReturnValue(
            controller({ selectedChannel: null, showSelectedChannelPanel: true })
        );
        renderWithMantine(<Home />);
        expect(screen.queryByTestId("library-section")).not.toBeInTheDocument();
    });

    it("hands the card actions through to the controller with the item's id", () => {
        // The page builds these handlers itself (useCallback over the controller's actions), so
        // the thing to prove is that clicking a card reaches the controller with the right id, not
        // the grid's own behavior.
        const ctrl = controller({});
        vi.mocked(useHomeController).mockReturnValue(ctrl);
        renderWithMantine(<Home />);

        fireEvent.click(screen.getByRole("button", { name: "mark 42" }));
        expect(ctrl.mediaActions.markAsWatched).toHaveBeenCalledWith(42);

        fireEvent.click(screen.getByRole("button", { name: "open source" }));
        expect(ctrl.media.openMediaSourceInYoutube).toHaveBeenCalledWith(item);

        fireEvent.click(screen.getByRole("button", { name: "back" }));
        expect(ctrl.channels.setSelectedChannelId).toHaveBeenCalledWith(null);
    });

    it("renders the player when the view says so and keeps the library mounted but hidden", () => {
        vi.mocked(useHomeController).mockReturnValue(
            controller({
                viewState: { showPlayer: true, showLibrary: false },
                playerMedia: item,
            })
        );
        renderWithMantine(<Home />);

        expect(screen.getByTestId("media-player")).toHaveTextContent("Clip");

        // The section stays mounted while the player is open (its search/filter state and the
        // grid scroll survive the round trip), hidden rather than removed. A wrapper that was
        // unmounted instead would reset the grid on every return from the player.
        const section = screen.getByTestId("library-section");
        expect(section).toBeInTheDocument();
        expect(section.parentElement).toHaveStyle({ visibility: "hidden" });
    });

    it("keeps the rest of the page when the player subtree crashes", () => {
        // The reason the player sits inside its own boundary. It renders the least controllable
        // data in the app. A crash there has to degrade to the boundary's card, with the sidebar
        // and the library still mounted, and offer the close action rather than taking the app
        // down to the root boundary.
        playerShouldThrow = true;
        const ctrl = controller({ viewState: { showPlayer: true }, playerMedia: item });
        vi.mocked(useHomeController).mockReturnValue(ctrl);
        renderWithMantine(<Home />);

        expect(screen.queryByTestId("media-player")).not.toBeInTheDocument();
        expect(screen.getByText(UI_TEXT.player.errorBoundaryTitle)).toBeInTheDocument();
        expect(screen.getByTestId("channel-sidebar")).toBeInTheDocument();
        expect(screen.getByTestId("library-section")).toBeInTheDocument();

        fireEvent.click(screen.getByRole("button", { name: UI_TEXT.player.errorBoundaryClose }));
        expect(ctrl.playerActions.closePlayer).toHaveBeenCalled();
    });
});
