import { Button, Group } from "@mantine/core";
import { Video } from "lucide-react";

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
        <Group justify="flex-end">
            {isYtDlpRunning && isUrlMode && (
                <Button
                    type="button"
                    color="red"
                    variant="light"
                    onClick={() => void onCancelYtDlpDownload?.()}
                    loading={isCancellingYtDlp}
                    disabled={isCancellingYtDlp}
                >
                    Cancel download
                </Button>
            )}

            <Button type="button" variant="subtle" onClick={onClose} disabled={isModalLocked}>
                Cancel
            </Button>

            <Button
                type="submit"
                variant="gradient"
                gradient={{ from: "violet", to: "cyan" }}
                leftSection={<Video size={18} />}
                disabled={!canSubmit || isBusy || isYtDlpRunning}
                loading={loading}
            >
                Add media
            </Button>
        </Group>
    );
}