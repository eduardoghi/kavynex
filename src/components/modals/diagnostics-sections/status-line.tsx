import { Group, Text } from "@mantine/core";
import { AlertTriangle, CheckCircle2, XCircle } from "lucide-react";
import type { ReactNode } from "react";

export type StatusTone = "success" | "warning" | "error";

const TONES = {
    success: { color: "green", Icon: CheckCircle2 },
    warning: { color: "dimmed", Icon: AlertTriangle },
    error: { color: "red", Icon: XCircle },
} as const;

/** The one-line outcome a Diagnostics check shows, an icon and a sentence in the tone's color. */
export function StatusLine({
    tone,
    children,
}: {
    tone: StatusTone;
    children: ReactNode;
}): JSX.Element {
    const { color, Icon } = TONES[tone];

    return (
        <Group gap={6} c={color}>
            <Icon size={16} />
            <Text size="sm">{children}</Text>
        </Group>
    );
}
