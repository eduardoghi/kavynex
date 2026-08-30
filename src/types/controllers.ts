// The composition of the Home page's slice controllers, and nothing else.
//
// Each slice type now lives in the file of the hook that produces it, so a field added to a slice
// is one edit in one file instead of two in two. This module used to hold all fifteen, which made
// it the point every frontend change had to pass through while saying nothing about any domain.
//
// It also let four of them be declared twice. `use-add-media-form`, `use-channels` and
// `use-app-settings` each carried a local `Use*Return` shape, and `use-home-library-panel` carried
// its own `HomeLibraryPanelState`, all four duplicating the version here. They agreed by hand
// rather than by construction, and one had already drifted (the local add-media shape carried a
// `resolvedYoutubeVideoId` the copy here did not, so `MediaLibraryController.addMediaForm`
// silently narrowed it away). Each pair is now one exported type.
import type { ChannelsController } from "../hooks/channels/use-channels";
import type { HomeLibraryPanelState } from "../hooks/home/use-home-library-panel";
import type { HomeMediaActionsController } from "../hooks/home/use-home-media-actions";
import type { HomePlayerActionsController } from "../hooks/home/use-home-player-actions";
import type { HomePlayerPanelState } from "../hooks/home/use-home-player-panel";
import type { HomeUiGuardsController } from "../hooks/home/use-home-ui-guards";
import type { HomeViewState } from "../hooks/home/use-home-view-state";
import type { MediaLibraryController } from "../hooks/media/use-media-library";
import type { AppSettingsController } from "../hooks/settings/use-app-settings";
import type { DatabaseRecoveryController } from "../hooks/use-app-bootstrap";
import type { DiagnosticsController } from "../hooks/use-diagnostics";
import type { ErrorModalController } from "../hooks/use-error-modal";

// Composed from the per-domain slice controllers instead of flattening every field. Consumers
// reach state and actions through the domain they belong to (e.g. `controller.channels.createChannel`,
// `controller.mediaActions.addMedia`), so the shape scales by adding a slice rather than widening
// one giant interface.
export type HomeController = {
    channels: ChannelsController;
    media: MediaLibraryController;
    settings: AppSettingsController;
    diagnostics: DiagnosticsController;
    error: ErrorModalController;
    databaseRecovery: DatabaseRecoveryController;
    uiGuards: HomeUiGuardsController;
    // Home-level orchestrated media actions (wrap the raw ones in `media` with extra steps
    // like reloading diagnostics), kept separate from the raw media library slice.
    mediaActions: HomeMediaActionsController;
    playerActions: HomePlayerActionsController;
    playerPanelState: HomePlayerPanelState;
    viewState: HomeViewState;
    libraryPanelState: HomeLibraryPanelState;
    // Cross-cutting infrastructure value read across several domains.
    libraryPath: string;
};
