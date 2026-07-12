import { Alert, Group, Paper, Progress, Stack, Text, Title } from "@mantine/core";
import { Download, RefreshCcw } from "lucide-react";
import type { SettingsController } from "../../../hooks/use-settings-controller";
import { AppButton } from "../../ui/app-button";

type AppUpdateSectionProps = Pick<
    SettingsController,
    | "appUpdateStatus"
    | "updateInfo"
    | "appUpdateProgress"
    | "appUpdateErrorMessage"
    | "checkForUpdate"
    | "installUpdate"
>;

export function AppUpdateSection({
    appUpdateStatus,
    updateInfo,
    appUpdateProgress,
    appUpdateErrorMessage,
    checkForUpdate,
    installUpdate,
}: AppUpdateSectionProps): JSX.Element {
    return (
        <Stack gap="xs">
            <Group gap="sm">
                <RefreshCcw size={18} />
                <Title order={4}>Application update</Title>
            </Group>

            <Paper withBorder radius="md" p="sm">
                <Stack gap="sm">
                    <Group justify="space-between" align="flex-start">
                        <Stack gap={2}>
                            <Text fw={600}>Kavynex updates</Text>
                            <Text size="sm" c="dimmed">
                                Check GitHub Releases for a newer version of the app.
                            </Text>
                        </Stack>

                        <AppButton
                            appVariant="secondary"
                            size="xs"
                            leftSection={<RefreshCcw size={14} />}
                            onClick={() => {
                                void checkForUpdate();
                            }}
                            loading={appUpdateStatus === "checking"}
                            disabled={appUpdateStatus === "downloading"}
                        >
                            Check update
                        </AppButton>
                    </Group>

                    {appUpdateStatus === "not-available" && (
                        <Alert color="green" variant="light" role="status" aria-live="polite">
                            <Text size="sm">Kavynex is already up to date.</Text>
                        </Alert>
                    )}

                    {updateInfo && (
                        <Alert color="blue" variant="light" role="status" aria-live="polite">
                            <Stack gap="xs">
                                <Text fw={600}>Version {updateInfo.version} is available.</Text>

                                <Text size="sm">
                                    Current version: {updateInfo.currentVersion}
                                </Text>

                                {!!updateInfo.body && (
                                    <Text size="sm" c="dimmed">
                                        {updateInfo.body}
                                    </Text>
                                )}

                                {appUpdateStatus === "downloading" && (
                                    <Stack gap={4}>
                                        <Progress value={appUpdateProgress?.percent ?? 0} />
                                        <Text size="xs" c="dimmed">
                                            {appUpdateProgress?.percent ?? 0}% downloaded
                                        </Text>
                                    </Stack>
                                )}

                                <Group>
                                    <AppButton
                                        appVariant="primary"
                                        leftSection={<Download size={16} />}
                                        onClick={() => {
                                            void installUpdate();
                                        }}
                                        loading={appUpdateStatus === "downloading"}
                                        disabled={appUpdateStatus === "downloading"}
                                    >
                                        Download and install
                                    </AppButton>
                                </Group>
                            </Stack>
                        </Alert>
                    )}

                    {!!appUpdateErrorMessage && (
                        <Alert color="red" variant="light" role="alert" aria-live="assertive">
                            <Text size="sm">{appUpdateErrorMessage}</Text>
                        </Alert>
                    )}
                </Stack>
            </Paper>
        </Stack>
    );
}
