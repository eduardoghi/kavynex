import { Box, Card, Group, SimpleGrid, Text, ThemeIcon, Title } from "@mantine/core";
import { FolderKanban, Library, Wrench } from "lucide-react";

type EmptyStateFeature = {
    title: string;
    description: string;
};

type EmptyStateCardProps = {
    title: string;
    description: string;
    shellBorder: string;
    shellSurface: string;
    features: EmptyStateFeature[];
};

function resolveFeatureIcon(index: number): JSX.Element {
    if (index === 0) {
        return <FolderKanban size={18} />;
    }

    if (index === 1) {
        return <Library size={18} />;
    }

    return <Wrench size={18} />;
}

export function EmptyStateCard({
    title,
    description,
    shellBorder,
    shellSurface,
    features,
}: EmptyStateCardProps): JSX.Element {
    return (
        <Card
            withBorder
            radius="xl"
            p="xl"
            role="region"
            aria-label={typeof title === "string" ? title : "empty state"}
            style={{
                background:
                    "radial-gradient(500px 220px at top left, rgba(168,85,247,0.08), transparent 55%)," +
                    shellSurface,
                borderColor: shellBorder,
            }}
        >
            <Box maw={860}>
                <Title order={1} fw={950}>
                    {title}
                </Title>

                <Text c="dimmed" mt="xs" maw={780}>
                    {description}
                </Text>
            </Box>

            <Box mt="lg">
                <SimpleGrid cols={{ base: 1, sm: 3 }} spacing="md">
                    {features.map((feature, index) => (
                        <Card
                            key={`${feature.title}-${index}`}
                            withBorder
                            radius="lg"
                            p="md"
                            style={{
                                borderColor: shellBorder,
                                background: "rgba(255,255,255,0.02)",
                            }}
                        >
                            <Group gap="sm" align="center" mb="sm">
                                <ThemeIcon variant="light" radius="xl">
                                    {resolveFeatureIcon(index)}
                                </ThemeIcon>

                                <Text fw={900}>{feature.title}</Text>
                            </Group>

                            <Text size="sm" c="dimmed">
                                {feature.description}
                            </Text>
                        </Card>
                    ))}
                </SimpleGrid>
            </Box>
        </Card>
    );
}