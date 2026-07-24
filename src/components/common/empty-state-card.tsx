import { Card, Stack, Text, ThemeIcon, Title } from "@mantine/core";
import { Library, Plus } from "lucide-react";
import { AppButton } from "../ui/app-button";

type EmptyStateCardProps = {
    title: string;
    description: string;
    actionLabel: string;
    onAction: () => void;
    shellBorder: string;
    shellSurface: string;
};

// A quiet, focused first-run empty state: one icon, a short line, and a single primary action -
// deliberately not a grid of numbered feature cards, which reads as marketing rather than an app.
export function EmptyStateCard({
    title,
    description,
    actionLabel,
    onAction,
    shellBorder,
    shellSurface,
}: EmptyStateCardProps): JSX.Element {
    return (
        <Card
            withBorder
            radius="xl"
            p="xl"
            role="region"
            aria-label={title}
            style={{
                background: shellSurface,
                borderColor: shellBorder,
            }}
        >
            <Stack gap="lg" align="center" maw={440} mx="auto" py="xl" ta="center">
                <ThemeIcon variant="light" size={64} radius="xl">
                    <Library size={30} />
                </ThemeIcon>

                <Stack gap={6} align="center">
                    <Title order={2} fw={900}>
                        {title}
                    </Title>

                    <Text c="dimmed" maw={380}>
                        {description}
                    </Text>
                </Stack>

                <AppButton
                    type="button"
                    appVariant="primary"
                    leftSection={<Plus size={18} />}
                    onClick={onAction}
                >
                    {actionLabel}
                </AppButton>
            </Stack>
        </Card>
    );
}
