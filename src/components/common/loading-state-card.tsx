import { Card, Group, Loader, Stack, Text } from "@mantine/core";

type LoadingStateCardProps = {
    message: string;
    shellBorder: string;
    shellSurface: string;
};

export function LoadingStateCard({
    message,
    shellBorder
}: LoadingStateCardProps): JSX.Element {
    return (
        <Card
            withBorder
            radius="xl"
            p="xl"
            role="status"
            style={{
                background:
                    "linear-gradient(180deg, rgba(255,255,255,0.03), rgba(255,255,255,0.015))",
                borderColor: shellBorder,
            }}
        >
            <Stack align="center" gap="sm">
                <Group gap="sm" align="center">
                    <Loader size="sm" />
                    <Text c="dimmed">{message}</Text>
                </Group>
            </Stack>
        </Card>
    );
}