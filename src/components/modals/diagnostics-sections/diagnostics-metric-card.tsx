import { Paper, Text } from "@mantine/core";

type DiagnosticsMetricCardProps = {
    label: string;
    value: string | number;
};

export function DiagnosticsMetricCard({
    label,
    value,
}: DiagnosticsMetricCardProps): JSX.Element {
    return (
        <Paper
            withBorder
            radius="lg"
            p="sm"
            style={{
                background: "rgba(255,255,255,0.02)",
            }}
        >
            <Text size="sm" c="dimmed">
                {label}
            </Text>

            <Text fw={800} mt={2}>
                {value}
            </Text>
        </Paper>
    );
}