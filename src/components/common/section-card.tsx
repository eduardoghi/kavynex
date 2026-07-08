import { Card, Group, Stack, Text } from "@mantine/core";
import type { ReactNode } from "react";

type SectionCardProps = {
    title: ReactNode;
    description?: ReactNode;
    shellBorder?: string;
    children: ReactNode;
};

export function SectionCard({
    title,
    description,
    shellBorder = "rgba(255,255,255,0.1)",
    children,
}: SectionCardProps): JSX.Element {
    return (
        <Card
            withBorder
            radius="xl"
            p="lg"
            style={{
                borderColor: shellBorder,
                background:
                    "linear-gradient(180deg, rgba(255,255,255,0.028), rgba(255,255,255,0.014))",
            }}
        >
            <Stack gap="md">
                <Stack gap={4}>
                    <Group gap="xs" align="center">
                        <Text fw={900}>{title}</Text>
                    </Group>

                    {description && (
                        <Text size="sm" c="dimmed">
                            {description}
                        </Text>
                    )}
                </Stack>

                {children}
            </Stack>
        </Card>
    );
}