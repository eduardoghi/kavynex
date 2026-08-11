import { Alert, Divider, Group, Paper, Progress, Stack, Switch, Text, Title } from "@mantine/core";
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
> & {
    checkUpdatesOnStartup: boolean;
    onChangeCheckUpdatesOnStartup: (checkUpdatesOnStartup: boolean) => void;
};

export function AppUpdateSection({
    appUpdateStatus,
    updateInfo,
    appUpdateProgress,
    appUpdateErrorMessage,
    checkForUpdate,
    installUpdate,
    checkUpdatesOnStartup,
    onChangeCheckUpdatesOnStartup,
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
                            // Disabled while checking as well as while downloading, so a second
                            // click cannot start a redundant network call the user has no reason to
                            // make. This is UX rather than the correctness guarantee it used to be:
                            // `loading` alone relies on Mantine having re-rendered before the next
                            // click lands, which is a promise about timing rather than about state.
                            // What makes overlapping checks safe is `useRequestGuard` inside
                            // useAppUpdate - which also covers the overlap this button cannot see,
                            // between a user check and the opt-in startup one.
                            disabled={
                                appUpdateStatus === "checking" || appUpdateStatus === "downloading"
                            }
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
                                    // Clamped rather than free-flowing. This string is latest.json's
                                    // `notes`, which tauri-action copies verbatim from the release
                                    // workflow's `releaseBody`. That body is deliberately one line
                                    // pointing at the release page (docs/RELEASING.md), because a
                                    // release here can carry hundreds of commits - but the guarantee
                                    // lives entirely in a YAML file a human edits, and this side had
                                    // no bound at all if it ever slipped. A wall of text would grow
                                    // the alert past the modal instead of scrolling inside it.
                                    <Text size="sm" c="dimmed" lineClamp={4}>
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

                    <Divider />

                    <Group justify="space-between" align="flex-start" wrap="nowrap">
                        <Stack gap={2} style={{ minWidth: 0 }}>
                            <Text fw={600}>Check for updates on startup</Text>
                            <Text size="sm" c="dimmed">
                                When on, Kavynex checks GitHub Releases once each time it starts and
                                tells you if a newer version is available. Off by default, so the app
                                contacts the update endpoint only when you check manually.
                            </Text>
                        </Stack>

                        <Switch
                            checked={checkUpdatesOnStartup}
                            onChange={(event) =>
                                onChangeCheckUpdatesOnStartup(event.currentTarget.checked)
                            }
                            aria-label="Check for updates on startup"
                        />
                    </Group>
                </Stack>
            </Paper>
        </Stack>
    );
}
