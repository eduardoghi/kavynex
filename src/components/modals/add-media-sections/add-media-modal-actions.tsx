import { Group } from "@mantine/core";
import { Video } from "lucide-react";
import { AppButton } from "../../ui/app-button";

type AddMediaModalActionsProps = {
    isYtDlpRunning: boolean;
    isUrlMode: boolean;
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
    isCancellingYtDlp,
    isModalLocked,
    canSubmit,
    isBusy,
    loading,
    onCancelYtDlpDownload,
    onClose,
}: AddMediaModalActionsProps): JSX.Element {
    return (
        <Group justify="flex-end" gap="sm">
            {isYtDlpRunning && isUrlMode && (
                <AppButton
                    type="button"
                    appVariant="danger"
                    onClick={() => void onCancelYtDlpDownload?.()}
                    loading={isCancellingYtDlp}
                    disabled={isCancellingYtDlp}
                >
                    Cancel download
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