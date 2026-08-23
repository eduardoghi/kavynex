import { useCallback } from "react";
import {
    AppShell,
    Box,
    Card,
    Container,
    Stack,
    Text,
    VisuallyHidden,
} from "@mantine/core";
// A 128px raster for a mark the sidebar draws at 32 CSS px, which covers a 4x display and is 71x
// smaller than what it replaced. The previous asset was a 962kB "SVG" carrying no vector geometry at
// all (two base64 PNGs, one masking the other, in 1.1kB of scaffolding), so it was the largest file
// in the bundle, larger than the whole JS entry, for an icon rendered at 32px. It also rendered
// distorted: its canvas was 1676x1156 and the <img> is a 32x32 box with no object-fit, so the tile
// was squashed into a square. This is the same artwork, from the icon set the app already ships.
//
// The padding around the mark is deliberate and belongs to the asset rather than to CSS, the way an
// icon normally carries its own safe area. The old SVG's tile filled only part of its oversized
// canvas, so it drew at about 23px inside the 32px box; dropping in the app icon unchanged would
// have drawn it at 29px, which reads as oversized next to a 20px wordmark. The artwork is inset to
// keep the lockup's original weight (23.5px against the old 23.4px) while losing the distortion, and
// centered, since the shipped icon sits 5px high in its own canvas.
import AppIcon from "../assets/app-icon.png";
import { EmptyStateCard } from "../components/common/empty-state-card";
import { MediaGridSkeleton } from "../components/library/media-grid-skeleton";
import { SectionErrorBoundary } from "../components/common/section-error-boundary";
import { SelectedChannelLibrarySection } from "../components/home/selected-channel-library-section";
import { HomeModals } from "../components/home/home-modals";
import { LibrarySetupCard } from "../components/home/library-setup-card";
import { EditMediaTitleModal } from "../components/modals/edit-media-title-modal";
import { ChannelSidebar } from "../components/layout/channel-sidebar";
import { MediaPlayerView } from "../components/player/media-player-view";
import { UI_TEXT } from "../constants/ui-text";
import { useHomeController } from "../hooks/home/use-home-controller";
import { useHomeDiagnosticsFocus } from "../hooks/home/use-home-diagnostics-focus";
import { useHomeMediaTitleEditing } from "../hooks/home/use-home-media-title-editing";
import type { MediaRow } from "../types/media";

export default function Home(): JSX.Element {
    const controller = useHomeController();
    const { channels, media, settings, viewState, playerActions } = controller;

    const showLoading = viewState.showLoading;
    const showEmpty = viewState.showEmpty;
    const showSelectChannelPrompt = viewState.showSelectChannelPrompt;
    const showPlayer = viewState.showPlayer;
    const showLibrary = viewState.showLibrary;

    const showLibrarySection =
        controller.libraryPanelState.showSelectedChannelPanel &&
        !!channels.selectedChannel;

    // Stable handlers so the memoized MediaCard is not re-rendered by unrelated state
    // changes. Each depends only on the underlying controller action it calls.
    const { markAsWatched, markAsUnwatched } = controller.mediaActions;
    const { openMediaFileLocation, openMediaSourceInYoutube } = media;

    // The two page-local flows that own state (the edit-title modal, the Diagnostics jump-to-media
    // focus) live in their own hooks rather than inline here, so this component stays presentation +
    // wiring. See use-home-media-title-editing / use-home-diagnostics-focus.
    const titleEditing = useHomeMediaTitleEditing({
        editMediaTitle: controller.mediaActions.editMediaTitle,
    });

    const diagnosticsFocus = useHomeDiagnosticsFocus({
        closeDiagnostics: controller.diagnostics.closeDiagnostics,
        setSelectedChannelId: channels.setSelectedChannelId,
    });

    const handleMarkWatched = useCallback(
        (item: MediaRow) => void markAsWatched(item.id),
        [markAsWatched]
    );

    const handleMarkUnwatched = useCallback(
        (item: MediaRow) => void markAsUnwatched(item.id),
        [markAsUnwatched]
    );

    const handleOpenFileLocation = useCallback(
        (item: MediaRow) => void openMediaFileLocation(item),
        [openMediaFileLocation]
    );

    const handleOpenSourceInYoutube = useCallback(
        (item: MediaRow) => void openMediaSourceInYoutube(item),
        [openMediaSourceInYoutube]
    );

    return (
        <Box
            style={{
                minHeight: "100vh",
                background: viewState.pageBackground,
            }}
        >
            <AppShell
                navbar={{ width: 320, breakpoint: "sm" }}
                padding="md"
                styles={{
                    main: {
                        background: viewState.pageBackground,
                    },
                }}
            >
                <ChannelSidebar
                    channels={channels.channels}
                    selectedChannelId={channels.selectedChannelId}
                    viewMode={media.mediaPlayer.viewMode}
                    shellBorder={viewState.shellBorder}
                    shellSurface={viewState.shellSurface}
                    loading={channels.isLoadingChannels}
                    deletingChannelId={channels.channelToDelete?.id ?? null}
                    updatingChannelAvatarId={channels.updatingChannelAvatarId}
                    libraryPath={controller.libraryPath}
                    appIconSrc={AppIcon}
                    onOpenCreateChannel={() => channels.setCreateChannelOpen(true)}
                    onOpenSettings={settings.openSettings}
                    onSelectChannel={channels.setSelectedChannelId}
                    onRequestEditChannel={channels.requestEditChannel}
                    onRequestDeleteChannel={channels.requestDeleteChannel}
                    onUpdateChannelAvatarFromFile={channels.updateChannelAvatarFromFile}
                    onUpdateChannelAvatarFromYouTube={channels.updateChannelAvatarFromYouTube}
                    onRemoveChannelAvatar={channels.removeChannelAvatar}
                    onClosePlayer={playerActions.closePlayer}
                />

                <AppShell.Main>
                    <Container size="xl">
                        <Stack gap="lg">
                            {showLoading && (
                                <Box role="status">
                                    <VisuallyHidden>{UI_TEXT.home.loadingApp}</VisuallyHidden>
                                    <MediaGridSkeleton shellBorder={viewState.shellBorder} />
                                </Box>
                            )}

                            {viewState.showLibrarySetup && (
                                <LibrarySetupCard
                                    loading={settings.isMigratingLibraryPath}
                                    onChooseLibraryPath={() => void settings.chooseLibraryPath()}
                                    shellBorder={viewState.shellBorder}
                                    shellSurface={viewState.shellSurface}
                                />
                            )}

                            {showEmpty && (
                                <EmptyStateCard
                                    title={UI_TEXT.home.emptyTitle}
                                    description={UI_TEXT.home.emptyDescription}
                                    actionLabel={UI_TEXT.home.emptyAction}
                                    onAction={() => channels.setCreateChannelOpen(true)}
                                    shellBorder={viewState.shellBorder}
                                    shellSurface={viewState.shellSurface}
                                />
                            )}

                            {showSelectChannelPrompt && (
                                <Card
                                    withBorder
                                    radius="xl"
                                    p="xl"
                                    role="status"
                                    style={{
                                        background: viewState.shellSurface,
                                        borderColor: viewState.shellBorder,
                                    }}
                                >
                                    <Text c="dimmed">{UI_TEXT.home.selectChannelPrompt}</Text>
                                </Card>
                            )}

                            {showPlayer && (
                                // Isolate the player subtree: it renders the most complex,
                                // least-controllable data (parsed comment trees, live-chat
                                // replay timing, arbitrary downloaded media), so a render crash
                                // here degrades to an inline card and closes the player instead
                                // of taking the whole app down to the root boundary. Re-arms when
                                // the active media changes.
                                <SectionErrorBoundary
                                    scope="media-player"
                                    title={UI_TEXT.player.errorBoundaryTitle}
                                    description={UI_TEXT.player.errorBoundaryDescription}
                                    resetKeys={[controller.playerPanelState.media?.id ?? null]}
                                    actionLabel={UI_TEXT.player.errorBoundaryClose}
                                    onAction={() => void playerActions.closePlayer()}
                                    shellBorder={viewState.shellBorder}
                                >
                                    <MediaPlayerView
                                        media={controller.playerPanelState.media}
                                        mediaSrc={controller.playerPanelState.mediaSrc}
                                        thumbnailSrc={controller.playerPanelState.thumbnailSrc}
                                        isAudio={controller.playerPanelState.isAudio}
                                        shellBorder={viewState.shellBorder}
                                        canOpenInYoutube={controller.playerPanelState.canOpenInYoutube}
                                        isWatched={controller.playerPanelState.isWatched}
                                        libraryPath={controller.libraryPath}
                                        isRefreshingComments={playerActions.isRefreshingComments}
                                        isUpdatingWatchedStatus={
                                            playerActions.isUpdatingWatchedStatus
                                        }
                                        loadRemoteImages={settings.settings.loadRemoteImages}
                                        onOpenInYoutube={playerActions.openInYoutube}
                                        onOpenFileLocation={playerActions.openFileLocation}
                                        onRefreshComments={playerActions.refreshComments}
                                        onCancelRefreshComments={playerActions.cancelRefreshComments}
                                        onMarkWatched={playerActions.markActiveAsWatched}
                                        onMarkUnwatched={playerActions.markActiveAsUnwatched}
                                        onSaveProgress={playerActions.saveProgress}
                                        onBack={playerActions.closePlayer}
                                    />
                                </SectionErrorBoundary>
                            )}

                            {showLibrarySection && channels.selectedChannel && (
                                <Box
                                    style={{
                                        position: showLibrary ? "relative" : "absolute",
                                        visibility: showLibrary ? "visible" : "hidden",
                                        pointerEvents: showLibrary ? "auto" : "none",
                                        inset: showLibrary ? undefined : 0,
                                        width: "100%",
                                        height: showLibrary ? "auto" : 0,
                                        overflow: "hidden",
                                    }}
                                >
                                    <SelectedChannelLibrarySection
                                        // Remount per channel so the section's local
                                        // search/filter/sort state (and the grid scroll) reset
                                        // when switching channels, instead of leaking one
                                        // channel's filters onto the next.
                                        key={channels.selectedChannel.id}
                                        selectedChannel={channels.selectedChannel}
                                        itemCountLabel={controller.libraryPanelState.itemCountLabel}
                                        disableAddMedia={controller.libraryPanelState.disableAddMedia}
                                        isLoadingMedia={media.isLoadingMedia}
                                        isVisible={showLibrary}
                                        mediaItems={media.mediaItems}
                                        total={media.mediaTotal}
                                        channelTotal={media.channelMediaTotal}
                                        hasMore={media.hasMoreMedia}
                                        isLoadingMore={media.isLoadingMoreMedia}
                                        onApplyQuery={media.applyMediaQuery}
                                        onLoadMore={media.loadMoreMedia}
                                        activeMediaId={media.mediaPlayer.activeMedia?.id ?? null}
                                        focusMediaId={diagnosticsFocus.focusMediaId}
                                        onFocusMediaHandled={diagnosticsFocus.handleFocusMediaHandled}
                                        libraryPath={controller.libraryPath}
                                        shellBorder={viewState.shellBorder}
                                        shellSurface={viewState.shellSurface}
                                        onAddMedia={() => media.setAddMediaOpen(true)}
                                        onBack={() => channels.setSelectedChannelId(null)}
                                        cardActions={{
                                            onOpenMedia: media.mediaPlayer.openPlayer,
                                            onRequestDeleteMedia: media.requestDeleteMedia,
                                            onMarkWatched: handleMarkWatched,
                                            onMarkUnwatched: handleMarkUnwatched,
                                            watchedActionInFlight:
                                                controller.mediaActions.watchedActionInFlight,
                                            onOpenFileLocation: handleOpenFileLocation,
                                            onOpenSourceInYoutube: handleOpenSourceInYoutube,
                                            onEditTitle: titleEditing.handleEditTitle,
                                        }}
                                    />
                                </Box>
                            )}
                        </Stack>
                    </Container>

                    <HomeModals
                        channels={controller.channels}
                        media={controller.media}
                        mediaActions={controller.mediaActions}
                        settings={controller.settings}
                        diagnostics={controller.diagnostics}
                        error={controller.error}
                        databaseRecovery={controller.databaseRecovery}
                        uiGuards={controller.uiGuards}
                        onOpenDiagnosticsMedia={diagnosticsFocus.handleOpenDiagnosticsMedia}
                    />

                    <EditMediaTitleModal
                        media={titleEditing.editTitleMedia}
                        loading={titleEditing.isSavingTitle}
                        onClose={titleEditing.closeEditTitle}
                        onSave={(item, title) => void titleEditing.handleSaveMediaTitle(item, title)}
                    />
                </AppShell.Main>
            </AppShell>
        </Box>
    );
}
