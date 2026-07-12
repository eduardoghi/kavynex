import { Badge, ThemeIcon } from "@mantine/core";
import { AlertTriangle, CheckCircle2 } from "lucide-react";
import type { ReactNode } from "react";
import type { DiagnosticsOverviewStatus } from "../../../types/diagnostics";

// Small presentational primitives shared by the diagnostics summary sections. Kept in their
// own module so the summary component reads as layout rather than a grab-bag of five inline
// components, and so the badge/icon styling can be reused (e.g. by the issues section) instead
// of being copied.

export function StatusBadge({
    color,
    label,
}: {
    color: "green" | "yellow" | "red" | "gray" | "blue";
    label: string;
}): JSX.Element {
    return (
        <Badge color={color} variant="light">
            {label}
        </Badge>
    );
}

export function OverviewBadge({
    status,
}: {
    status: DiagnosticsOverviewStatus;
}): JSX.Element {
    if (status === "error") {
        return <StatusBadge color="red" label="Needs action" />;
    }

    if (status === "warning") {
        return <StatusBadge color="yellow" label="Attention" />;
    }

    return <StatusBadge color="green" label="Healthy" />;
}

export function SectionIcon({
    children,
}: {
    children: ReactNode;
}): JSX.Element {
    return (
        <ThemeIcon
            size="lg"
            radius="xl"
            variant="light"
            style={{
                background:
                    "linear-gradient(135deg, rgba(124,92,255,0.24), rgba(37,99,235,0.10))",
                border: "1px solid rgba(139,92,246,0.30)",
                color: "rgba(237,233,254,0.96)",
                boxShadow: "0 10px 24px rgba(80,50,180,0.12)",
            }}
        >
            {children}
        </ThemeIcon>
    );
}

export function OverviewIcon({
    status,
}: {
    status: DiagnosticsOverviewStatus;
}): JSX.Element {
    const isHealthy = status === "healthy";
    const isWarning = status === "warning";

    return (
        <ThemeIcon
            size="lg"
            radius="xl"
            variant="light"
            style={{
                background: isHealthy
                    ? "rgba(34,197,94,0.16)"
                    : isWarning
                      ? "rgba(234,179,8,0.16)"
                      : "rgba(239,68,68,0.16)",
                border: isHealthy
                    ? "1px solid rgba(34,197,94,0.30)"
                    : isWarning
                      ? "1px solid rgba(234,179,8,0.30)"
                      : "1px solid rgba(239,68,68,0.30)",
                color: isHealthy
                    ? "rgb(134,239,172)"
                    : isWarning
                      ? "rgb(253,224,71)"
                      : "rgb(252,165,165)",
            }}
        >
            {isHealthy ? <CheckCircle2 size={16} /> : <AlertTriangle size={16} />}
        </ThemeIcon>
    );
}
