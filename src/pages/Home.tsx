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
import { AppHeader } from "../components/layout/app-header";
import { ChannelSidebar } from "../components/layout/channel-sidebar";
import { MediaPlayerView } from "../components/player/media-player-view";
import { UI_TEXT } from "../constants/ui-text";
import { useHomeController } from "../hooks/use-home-controller";
import type { MediaRow } from "../types/media";

export default function Home(): JSX.Element {
    const controller = useHomeController();

    const showLoading = controller.viewState.showLoading;
    const showEmpty = controller.viewState.showEmpty;
    const showPlayer = controller.viewState.showPlayer;
    const showLibrary = controller.viewState.showLibrary;

    const showLibrarySection =
        controller.libraryPanelState.showSelectedChannelPanel &&
        !!controller.selectedChannel;

    const handleEditMediaTitle = async (media: MediaRow): Promise<void> => {
        const nextTitle = window.prompt("Edit media title", media.title);

        if (nextTitle === null) {
            return;
        }

        await controller.editMediaTitle(media, nextTitle);
    };

    return (
        <Box
            style={{
                minHeight: "100vh",
                background: controller.viewState.pageBackground,
            }}
        >
            <AppShell
                header={{ height: 74 }}
                navbar={{ width: 320, breakpoint: "sm" }}
                padding="md"
                styles={{
                    main: {
                        background: controller.viewState.pageBackground,
                    },
                }}
            >
                <AppHeader
                    appIconSrc={AppIcon}
                    shellSurface={controller.viewState.shellSurface}
                    shellBorder={controller.viewState.shellBorder}
                    onOpenCreateChannel={() => controller.setCreateChannelOpen(true)}
                    onOpenSettings={controller.openSettings}
                />

                <ChannelSidebar
                    channels={controller.channels}
                    selectedChannelId={controller.selectedChannelId}
                    viewMode={controller.mediaPlayer.viewMode}
                    shellBorder={controller.viewState.shellBorder}
                    shellSurface={controller.viewState.shellSurface}
                    loading={controller.isLoadingChannels}
                    deletingChannelId={controller.channelToDelete?.id ?? null}
                    updatingChannelAvatarId={controller.updatingChannelAvatarId}
                    libraryPath={controller.libraryPath}
                    onSelectChannel={controller.setSelectedChannelId}
                    onRequestEditChannel={controller.requestEditChannel}
                    onRequestDeleteChannel={controller.requestDeleteChannel}
                    onUpdateChannelAvatarFromFile={controller.updateChannelAvatarFromFile}
                    onUpdateChannelAvatarFromYouTube={controller.updateChannelAvatarFromYouTube}
                    onRemoveChannelAvatar={controller.removeChannelAvatar}
                    onClosePlayer={controller.playerActions.closePlayer}
                />

                <AppShell.Main>
                    <Container size="xl">
                        <Stack gap="lg">
                            {showLoading && (
                                <LoadingStateCard
                                    message={UI_TEXT.home.loadingApp}
                                    shellBorder={controller.viewState.shellBorder}
                                    shellSurface={controller.viewState.shellSurface}
                                />
                            )}

                            {showEmpty && (
                                <EmptyStateCard
                                    title={UI_TEXT.home.emptyTitle}
                                    description={UI_TEXT.home.emptyDescription}
                                    shellBorder={controller.viewState.shellBorder}
                                    shellSurface={controller.viewState.shellSurface}
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
                                    shellBorder={controller.viewState.shellBorder}
                                    canOpenInYoutube={controller.playerPanelState.canOpenInYoutube}
                                    isWatched={controller.playerPanelState.isWatched}
                                    libraryPath={controller.libraryPath}
                                    isRefreshingComments={controller.playerActions.isRefreshingComments}
                                    onOpenInYoutube={controller.playerActions.openInYoutube}
                                    onOpenFileLocation={controller.playerActions.openFileLocation}
                                    onRefreshComments={controller.playerActions.refreshComments}
                                    onMarkWatched={controller.playerActions.markActiveAsWatched}
                                    onMarkUnwatched={controller.playerActions.markActiveAsUnwatched}
                                    onBack={controller.playerActions.closePlayer}
                                />
                            )}

                            {showLibrarySection && controller.selectedChannel && (
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
                                        selectedChannel={controller.selectedChannel}
                                        itemCountLabel={controller.libraryPanelState.itemCountLabel}
                                        disableAddMedia={controller.libraryPanelState.disableAddMedia}
                                        isLoadingMedia={controller.isLoadingMedia}
                                        isVisible={showLibrary}
                                        mediaItems={controller.mediaItems}
                                        activeMediaId={controller.mediaPlayer.activeMedia?.id ?? null}
                                        libraryPath={controller.libraryPath}
                                        shellBorder={controller.viewState.shellBorder}
                                        shellSurface={controller.viewState.shellSurface}
                                        onAddMedia={() => controller.setAddMediaOpen(true)}
                                        onBack={() => controller.setSelectedChannelId(null)}
                                        onOpenMedia={controller.mediaPlayer.openPlayer}
                                        onRequestDeleteMedia={controller.requestDeleteMedia}
                                        onMarkWatched={(media) => void controller.markAsWatched(media.id)}
                                        onMarkUnwatched={(media) =>
                                            void controller.markAsUnwatched(media.id)
                                        }
                                        onOpenFileLocation={(media) =>
                                            void controller.openMediaFileLocation(media)
                                        }
                                        onOpenSourceInYoutube={(media) =>
                                            void controller.openMediaSourceInYoutube(media)
                                        }
                                        onEditTitle={(media) => {
                                            void handleEditMediaTitle(media);
                                        }}
                                    />
                                </Box>
                            )}
                        </Stack>
                    </Container>

                    <HomeModals controller={controller} />
                </AppShell.Main>
            </AppShell>
        </Box>
    );
}