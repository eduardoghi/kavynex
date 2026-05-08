import { ActionIcon, AppShell, Badge, Box, Group, Text } from "@mantine/core";
import { Plus, Settings } from "lucide-react";
import { AppButton } from "../ui/app-button";

type AppHeaderProps = {
    appIconSrc: string;
    shellSurface: string;
    shellBorder: string;
    onOpenCreateChannel: () => void;
    onOpenSettings: () => void;
};

export function AppHeader({
    appIconSrc,
    shellSurface,
    shellBorder,
    onOpenCreateChannel,
    onOpenSettings,
}: AppHeaderProps): JSX.Element {
    return (
        <AppShell.Header
            style={{
                background: "rgba(8, 11, 20, 0.72)",
                borderBottom: `1px solid ${shellBorder}`,
                backdropFilter: "blur(18px)",
            }}
        >
            <Group h="100%" px="md" justify="space-between">
                <Group gap="sm">
                    <Box
                        style={{
                            width: 46,
                            height: 46,
                            borderRadius: 14,
                            display: "grid",
                            placeItems: "center",
                            border: `1px solid ${shellBorder}`,
                            background:
                                "linear-gradient(180deg, rgba(255,255,255,0.045), rgba(255,255,255,0.02))",
                        }}
                    >
                        <img src={appIconSrc} width={28} height={28} alt="Kavynex" />
                    </Box>

                    <Box>
                        <Group gap="xs" align="center">
                            <Text fw={950} size="lg" lh={1}>
                                Kavynex
                            </Text>

                            <Badge variant="light" color="violet" size="sm">
                                Desktop
                            </Badge>
                        </Group>

                        <Text c="dimmed" size="xs" lh={1.2}>
                            Curated media library
                        </Text>
                    </Box>
                </Group>

                <Group gap="xs">
                    <ActionIcon
                        variant="default"
                        size="lg"
                        aria-label="Open settings"
                        onClick={onOpenSettings}
                        style={{
                            background: shellSurface,
                            border: `1px solid ${shellBorder}`,
                        }}
                    >
                        <Settings size={18} />
                    </ActionIcon>

                    <AppButton
                        type="button"
                        appVariant="primary"
                        leftSection={<Plus size={18} />}
                        onClick={onOpenCreateChannel}
                    >
                        New channel
                    </AppButton>
                </Group>
            </Group>
        </AppShell.Header>
    );
}