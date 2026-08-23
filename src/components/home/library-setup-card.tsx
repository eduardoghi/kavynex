import { Card, Group, Stack, Text, ThemeIcon, Title } from "@mantine/core";
import { FolderOpen } from "lucide-react";
import { UI_TEXT } from "../../constants/ui-text";
import { AppButton } from "../ui/app-button";

type LibrarySetupCardProps = {
    loading: boolean;
    onChooseLibraryPath: () => void;
    shellBorder: string;
    shellSurface: string;
};

// Shown at the top of the Home page while no library folder is configured, which is the state
// every fresh install starts in. Without it the only signs were a disabled "Add media" button with
// no reason attached and an error modal when an avatar was picked: the first thing the app needed
// from the user was the last thing it told them. The button opens the same folder dialog as
// Settings > Library folder, so this is a shortcut to an existing flow, not a second one.
export function LibrarySetupCard({
    loading,
    onChooseLibraryPath,
    shellBorder,
    shellSurface,
}: LibrarySetupCardProps): JSX.Element {
    return (
        <Card
            withBorder
            radius="xl"
            p="xl"
            role="region"
            aria-label={UI_TEXT.home.librarySetupTitle}
            style={{
                background: shellSurface,
                borderColor: shellBorder,
            }}
        >
            <Group align="flex-start" gap="lg" wrap="nowrap">
                <ThemeIcon variant="light" color="yellow" size={48} radius="xl">
                    <FolderOpen size={24} />
                </ThemeIcon>

                <Stack gap="sm" style={{ flex: 1 }}>
                    <Stack gap={4}>
                        <Title order={3} fw={800}>
                            {UI_TEXT.home.librarySetupTitle}
                        </Title>

                        <Text c="dimmed" size="sm" maw={620}>
                            {UI_TEXT.home.librarySetupDescription}
                        </Text>
                    </Stack>

                    <Group>
                        <AppButton
                            type="button"
                            appVariant="primary"
                            leftSection={<FolderOpen size={18} />}
                            loading={loading}
                            onClick={onChooseLibraryPath}
                        >
                            {loading
                                ? UI_TEXT.home.librarySetupInProgress
                                : UI_TEXT.home.librarySetupAction}
                        </AppButton>
                    </Group>
                </Stack>
            </Group>
        </Card>
    );
}
