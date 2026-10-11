import { useCallback, useState } from "react";
import { useMemoObject } from "../use-memo-object";
import type { DiagnosticsMediaTarget } from "../../types/diagnostics";

type UseHomeDiagnosticsFocusOptions = {
    closeDiagnostics: () => void;
    setSelectedChannelId: (value: number | null) => void;
    // The player covers the library, and the grid only applies a focus while it is visible, so a
    // jump made with the player open did nothing until the user went back, and then jumped late.
    isPlayerOpen: boolean;
    closePlayer: () => void;
};

export type HomeDiagnosticsFocus = {
    // Set when the user clicks a "missing media" path in Diagnostics. The target channel is
    // selected and the grid, once that channel's media has loaded, scrolls to and highlights the
    // card, then clears this. A media whose file is missing still has its row, so it is listed in
    // the grid (just not playable).
    focusMediaId: number | null;
    handleOpenDiagnosticsMedia: (target: DiagnosticsMediaTarget) => void;
    handleFocusMediaHandled: () => void;
};

// Owns the "jump from a Diagnostics issue to the offending media" flow. Closing the Diagnostics
// modal, selecting the media's channel, and remembering which card the grid should focus once that
// channel's page has loaded. Lifted out of the Home page component so this orchestration lives in a
// hook (and is unit-testable) rather than inline in the page body.
export function useHomeDiagnosticsFocus({
    closeDiagnostics,
    setSelectedChannelId,
    isPlayerOpen,
    closePlayer,
}: UseHomeDiagnosticsFocusOptions): HomeDiagnosticsFocus {
    const [focusMediaId, setFocusMediaId] = useState<number | null>(null);

    const handleOpenDiagnosticsMedia = useCallback(
        (target: DiagnosticsMediaTarget): void => {
            closeDiagnostics();

            if (isPlayerOpen) {
                closePlayer();
            }

            setSelectedChannelId(target.channelId);
            setFocusMediaId(target.mediaId);
        },
        [closeDiagnostics, closePlayer, isPlayerOpen, setSelectedChannelId]
    );

    const handleFocusMediaHandled = useCallback((): void => {
        setFocusMediaId(null);
    }, []);

    // Reference-stable, per CONTRIBUTING.md's hook conventions (see use-home-media-title-editing).
    return useMemoObject({ focusMediaId, handleOpenDiagnosticsMedia, handleFocusMediaHandled });
}
