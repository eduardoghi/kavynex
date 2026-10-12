// The composition of the Home page's slice controllers, and nothing else.
//
// Each slice type lives in the file of the hook that produces it, so a field added to a slice
// is one edit in one file instead of two in two. Holding all fifteen here would make this module
// the point every frontend change has to pass through while saying nothing about any domain.
//
// It would also let a slice be declared twice, as a local `Use*Return` shape in a hook and again
// here. The copies would agree by hand rather than by construction, and one can drift (a local
// add-media shape carrying a `resolvedYoutubeVideoId` the copy here did not would make
// `MediaLibraryController.addMediaForm` silently narrow it away). Each slice is one exported type.
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
