import { useEffect, useMemo, useRef, useState } from "react";
import { getExternalToolsStatus } from "../services/diagnostics-external-tools";
import type { ExternalToolsStatus } from "../types/diagnostics";
import type { MediaSourceMode } from "../types/media";
import { logError } from "../utils/app-logger";
import { useMemoObject } from "./use-memo-object";

export type ExternalToolName = "yt-dlp" | "ffmpeg";

// One frozen instance for "nothing missing", so the common case keeps a stable identity instead of
// handing every consumer a new empty array on each render.
const NO_MISSING_TOOLS: readonly ExternalToolName[] = Object.freeze([]);

// Which missing tools actually block what the user is about to do.
//
// The two modes do not need the same things. A URL import runs yt-dlp and then hands the result to
// ffmpeg, while a local import never calls yt-dlp but still runs ffmpeg to generate the thumbnail
// preview. Warning about yt-dlp on the local path would be noise, and staying silent about ffmpeg
// there would leave the thumbnail failing for a reason the form never mentioned.
export function missingToolsForMode(
    status: ExternalToolsStatus,
    sourceMode: MediaSourceMode
): ExternalToolName[] {
    const missing: ExternalToolName[] = [];

    if (sourceMode === "yt-dlp" && !status.yt_dlp.healthy) {
        missing.push("yt-dlp");
    }

    if (!status.ffmpeg.healthy) {
        missing.push("ffmpeg");
    }

    return missing;
}

type UseExternalToolsAvailabilityReturn = {
    missingTools: readonly ExternalToolName[];
};

// Checks yt-dlp and ffmpeg while `enabled` is true (the import modal being open), so the form can
// say up front that a tool it needs is missing.
//
// Before this, the check only ran when someone opened Diagnostics on their own, so the usual way to
// find out was to fill the whole form, paste a URL and have the format load fail with
// YT_DLP_NOT_FOUND.
//
// A failure to check is deliberately silent. The status is an extra warning, not a precondition,
// and turning "we could not probe the tools" into a message in the import form would be alarming
// about the wrong thing. The import itself still reports a missing binary with its own error.
export function useExternalToolsAvailability(
    enabled: boolean,
    sourceMode: MediaSourceMode
): UseExternalToolsAvailabilityReturn {
    const [status, setStatus] = useState<ExternalToolsStatus | null>(null);

    // Discards the answer to a check that was superseded while it was in flight. Reopening the
    // modal starts a new one, and probing spawns two processes, so the responses can land out of
    // order and an older one must not overwrite a newer.
    const checkIdRef = useRef(0);

    useEffect(() => {
        if (!enabled) {
            // Cleared so a reopen re-checks rather than showing what was true last time. The
            // usual reason to close this modal after seeing the warning is to go install the tool.
            setStatus(null);
            return;
        }

        const checkId = checkIdRef.current + 1;
        checkIdRef.current = checkId;

        void (async () => {
            try {
                const nextStatus = await getExternalToolsStatus();

                if (checkIdRef.current === checkId) {
                    setStatus(nextStatus);
                }
            } catch (error) {
                logError("add-media", "Failed to check the external tools.", error);
            }
        })();
    }, [enabled]);

    // The source mode is applied here rather than inside the effect above, which is what keeps
    // switching modes from spawning another probe. The probe's answer is the same either way, and
    // only which half of it matters changes.

    const missingTools = useMemo(
        () => (status ? missingToolsForMode(status, sourceMode) : NO_MISSING_TOOLS),
        [status, sourceMode]
    );

    return useMemoObject({ missingTools });
}
