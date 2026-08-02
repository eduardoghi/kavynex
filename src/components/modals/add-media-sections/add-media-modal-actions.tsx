import { Group } from "@mantine/core";
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

    return (
        <Group justify="flex-end" gap="sm">
            {cancellable && (
                <AppButton
                    type="button"
                    appVariant="danger"
                    onClick={() => void onCancelYtDlpDownload?.()}
                    loading={isCancellingYtDlp}
                    disabled={isCancellingYtDlp}
                >
                    {isUrlMode ? "Cancel download" : "Cancel import"}
                </AppButton>
            )}

            <AppButton
                type="button"
                appVariant="ghost"
                onClick={onClose}
                disabled={isModalLocked}
            >
                Cancel
            </AppButton>

            <AppButton
                type="submit"
                appVariant="primary"
                leftSection={<Video size={18} />}
                disabled={!canSubmit || isBusy || isYtDlpRunning}
                loading={loading}
            >
                Add media
            </AppButton>
        </Group>
    );
}