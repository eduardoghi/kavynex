import { Group, Loader, Text } from "@mantine/core";
import { Video } from "lucide-react";
import { AppButton } from "../../ui/app-button";

type AddMediaModalActionsProps = {
    isYtDlpRunning: boolean;
    isUrlMode: boolean;
    // A local import in flight. The copy is now interruptible on the backend, so this is what puts
    // a way out in front of the user: an import of a large file from a slow drive holds the modal
    // locked for as long as it runs, and until it was cancellable the only exit was killing the app.
    isImportingLocalFile: boolean;
    isCancellingYtDlp: boolean;
    isModalLocked: boolean;
    canSubmit: boolean;
    isBusy: boolean;
    loading: boolean;
    onCancelYtDlpDownload?: () => void | Promise<void>;
    onClose: () => void;
};

export function AddMediaModalActions({
    isYtDlpRunning,
    isUrlMode,
    isImportingLocalFile,
    isCancellingYtDlp,
    isModalLocked,
    canSubmit,
    isBusy,
    loading,
    onCancelYtDlpDownload,
    onClose,
}: AddMediaModalActionsProps): JSX.Element {
    // One button for both, because it is one backend mechanism: a download and an import register
    // the same kind of run and are stopped by the same command. Only the wording differs, since
    // "Cancel download" in front of a file copy would describe the wrong thing.
    const cancellable = isUrlMode ? isYtDlpRunning : isImportingLocalFile;

    // The whole import, not just the yt-dlp process. `loading` stays true through
    // registering the media and fetching comments and live chat, which is exactly the
    // window where the footer must not be offering to start another one.
    const isImporting = loading || isYtDlpRunning;

    if (isImporting) {
        return (
            <Group justify="space-between" gap="sm" wrap="nowrap">
                {/* Progress, not a control. Add media used to sit here as a filled violet
                    rectangle holding a spinner and nothing else, next to a disabled
                    Cancel and a Cancel import, three controls for one state. */}
                <Group gap="xs" wrap="nowrap" role="status" aria-live="polite">
                    <Loader size="xs" />

                    <Text size="sm" c="dimmed">
                        {isYtDlpRunning ? "Downloading..." : "Importing..."}
                    </Text>
                </Group>

                {cancellable && (
                    <AppButton
                        type="button"
                        appVariant="danger"
                        onClick={() => void onCancelYtDlpDownload?.()}
                        disabled={isCancellingYtDlp}
                    >
                        {isCancellingYtDlp
                            ? "Cancelling..."
                            : isUrlMode
                              ? "Cancel download"
                              : "Cancel import"}
                    </AppButton>
                )}
            </Group>
        );
    }

    return (
        <Group justify="flex-end" gap="sm">
            {/* Bordered rather than ghost, matching the other modals. Beside a filled Add
                media it was reading as loose text instead of the other half of the
                decision. */}
            <AppButton
                type="button"
                appVariant="secondary"
                onClick={onClose}
                disabled={isModalLocked}
            >
                Cancel
            </AppButton>

            <AppButton
                type="submit"
                appVariant="primary"
                leftSection={<Video size={18} />}
                disabled={!canSubmit || isBusy}
            >
                Add media
            </AppButton>
        </Group>
    );
}