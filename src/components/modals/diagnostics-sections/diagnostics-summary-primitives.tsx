import { Badge } from "@mantine/core";

// The one presentational primitive the diagnostics sections share. Kept in its own module so
// the summary component reads as layout, and so the issues section styles its badges the same
// way instead of copying it.
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
