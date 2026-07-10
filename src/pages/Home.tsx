import { useCallback, useState } from "react";
import {
    AppShell,
    Box,
    Container,
    Stack,
} from "@mantine/core";
import AppIcon from "../assets/app-icon.svg";
import { EmptyStateCard } from "../components/common/empty-state-card";
import { LoadingStateCard } from "../components/common/loading-state-card";
import { SelectedChannelLibrarySection } from "../components/home/selected-channel-library-section";
import { HomeModals } from "../components/home/home-modals";
import { EditMediaTitleModal } from "../components/modals/edit-media-title-modal";
import { AppHeader } from "../components/layout/app-header";
import { ChannelSidebar } from "../components/layout/channel-sidebar";
import { MediaPlayerView } from "../components/player/media-player-view";
import { UI_TEXT } from "../constants/ui-text";
import { useHomeController } from "../hooks/use-home-controller";
import type { MediaRow } from "../types/media";

export default function Home(): JSX.Element {
    const controller = useHomeController();
    const { channels, media, settings, viewState, playerActions } = controller;

    const showLoading = viewState.showLoading;
    const showEmpty = viewState.showEmpty;
    const showPlayer = viewState.showPlayer;
    const showLibrary = viewState.showLibrary;

    const showLibrarySection =
        controller.libraryPanelState.showSelectedChannelPanel &&
        !!channels.selectedChannel;

    // Stable handlers so the memoized MediaCard is not re-rendered by unrelated state
    // changes. Each depends only on the underlying controller action it calls.
    const { editMediaTitle, markAsWatched, markAsUnwatched } = controller.mediaActions;
    const { openMediaFileLocation, openMediaSourceInYoutube } = media;

    const [editTitleMedia, setEditTitleMedia] = useState<MediaRow | null>(null);
    const [isSavingTitle, setIsSavingTitle] = useState(false);

    const handleSaveMediaTitle = useCallback(
        async (item: MediaRow, title: string): Promise<void> => {
            setIsSavingTitle(true);

            try {
                await editMediaTitle(item, title);
                setEditTitleMedia(null);
            } finally {
                setIsSavingTitle(false);
            }
        },
        [editMediaTitle]
    );

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

    const handleEditTitle = useCallback((item: MediaRow) => {
        setEditTitleMedia(item);
    }, []);

    return (
        <Box
            style={{
                minHeight: "100vh",
                background: viewState.pageBackground,
            }}
        >
            <AppShell
                header={{ height: 74 }}
                navbar={{ width: 320, breakpoint: "sm" }}
                padding="md"
                styles={{
                    main: {
                        background: viewState.pageBackground,
                    },
                }}
            >
                <AppHeader
                    appIconSrc={AppIcon}
                    shellSurface={viewState.shellSurface}
                    shellBorder={viewState.shellBorder}
                    onOpenCreateChannel={() => channels.setCreateChannelOpen(true)}
                    onOpenSettings={settings.openSettings}
                />

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
                                <LoadingStateCard
                                    message={UI_TEXT.home.loadingApp}
                                    shellBorder={viewState.shellBorder}
                                />
                            )}

                            {showEmpty && (
                                <EmptyStateCard
                                    title={UI_TEXT.home.emptyTitle}
                                    description={UI_TEXT.home.emptyDescription}
                                    shellBorder={viewState.shellBorder}
                                    shellSurface={viewState.shellSurface}
                                    features={[
                                        UI_TEXT.home.emptyCards.channels,
                                        UI_TEXT.home.emptyCards.media,
                                        UI_TEXT.home.emptyCards.diagnostics,
                                    ]}
                                />
                            )}

                            {showPlayer && (
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
                                    onOpenInYoutube={playerActions.openInYoutube}
                                    onOpenFileLocation={playerActions.openFileLocation}
                                    onRefreshComments={playerActions.refreshComments}
                                    onMarkWatched={playerActions.markActiveAsWatched}
                                    onMarkUnwatched={playerActions.markActiveAsUnwatched}
                                    onSaveProgress={playerActions.saveProgress}
                                    onBack={playerActions.closePlayer}
                                />
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
                                        activeMediaId={media.mediaPlayer.activeMedia?.id ?? null}
                                        libraryPath={controller.libraryPath}
                                        shellBorder={viewState.shellBorder}
                                        shellSurface={viewState.shellSurface}
                                        onAddMedia={() => media.setAddMediaOpen(true)}
                                        onBack={() => channels.setSelectedChannelId(null)}
                                        onOpenMedia={media.mediaPlayer.openPlayer}
                                        onRequestDeleteMedia={media.requestDeleteMedia}
                                        onMarkWatched={handleMarkWatched}
                                        onMarkUnwatched={handleMarkUnwatched}
                                        onOpenFileLocation={handleOpenFileLocation}
                                        onOpenSourceInYoutube={handleOpenSourceInYoutube}
                                        onEditTitle={handleEditTitle}
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
                    />

                    <EditMediaTitleModal
                        media={editTitleMedia}
                        loading={isSavingTitle}
                        onClose={() => setEditTitleMedia(null)}
                        onSave={(item, title) => void handleSaveMediaTitle(item, title)}
                    />
                </AppShell.Main>
            </AppShell>
        </Box>
    );
}
