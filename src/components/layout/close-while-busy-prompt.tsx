import { Text } from "@mantine/core";
import { X } from "lucide-react";
import { useCloseGuard } from "../../hooks/use-close-guard";
import type { WorkInProgress } from "../../types/generated/WorkInProgress";
import { ConfirmDeleteModal } from "../modals/confirm-delete-modal";

// What each kind of work is called in the question, in the order it is listed.
const WORK_LABELS: [keyof WorkInProgress, string][] = [
    ["downloading", "a download"],
    ["addingMedia", "a media being added"],
    ["verifyingLibrary", "the library verification"],
    ["movingLibrary", "the library move"],
];

export function describeWork(work: WorkInProgress): string {
    const running = WORK_LABELS.filter(([key]) => work[key]).map(([, label]) => label);

    if (running.length <= 1) {
        return running[0] ?? "the work in progress";
    }

    return `${running.slice(0, -1).join(", ")} and ${running[running.length - 1]}`;
}

/**
 * Asks before the window closes while a download, an import, the library verification or a library
 * move is running, since closing stops it and it does not resume. Owns its own state, so it can sit
 * at the root of the app, outside any page.
 */
export function CloseWhileBusyPrompt(): JSX.Element {
    const { pending, keepRunning, closeAnyway } = useCloseGuard();

    return (
        <ConfirmDeleteModal
            opened={pending !== null}
            onClose={keepRunning}
            onConfirm={() => void closeAnyway()}
            title={<Text fw={700}>Close Kavynex?</Text>}
            message={
                <>
                    Closing now stops {pending ? describeWork(pending) : "the work in progress"}.
                </>
            }
            description="It does not continue where it stopped. A download starts over the next time."
            confirmLabel="Close anyway"
            cancelLabel="Keep running"
            confirmIcon={<X size={18} />}
        />
    );
}
