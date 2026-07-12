import type { CSSProperties, KeyboardEvent, ReactNode } from "react";
import { Paper, UnstyledButton, type PaperProps } from "@mantine/core";

type StretchedButtonCardProps = {
    ariaLabel: string;
    ariaCurrent?: boolean;
    ariaBusy?: boolean;
    disabled?: boolean;
    onClick: () => void;
    radius?: PaperProps["radius"];
    p?: PaperProps["p"];
    style: CSSProperties;
    children: ReactNode;
};

// Shared "stretched button overlay" card idiom: a relatively-positioned Paper whose whole
// surface activates one primary action through a single focusable, native control - no
// interactive role on the card itself, so a menu button rendered above it is not a control
// nested inside another control. The overlay sits above the visual content but below the
// menu button (z-index 2, owned by the caller), which stays clickable. Selection state (if
// any) is conveyed with aria-current, not aria-pressed, since the button opens/selects rather
// than toggles.
export function StretchedButtonCard({
    ariaLabel,
    ariaCurrent = false,
    ariaBusy = false,
    disabled = false,
    onClick,
    radius,
    p,
    style,
    children,
}: StretchedButtonCardProps): JSX.Element {
    const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
        if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onClick();
        }
    };

    return (
        <Paper
            withBorder
            radius={radius}
            p={p}
            aria-busy={ariaBusy ? true : undefined}
            style={{
                position: "relative",
                ...style,
            }}
        >
            <UnstyledButton
                aria-label={ariaLabel}
                aria-current={ariaCurrent ? "true" : undefined}
                disabled={disabled}
                onClick={onClick}
                onKeyDown={handleKeyDown}
                style={{
                    position: "absolute",
                    inset: 0,
                    zIndex: 1,
                    borderRadius: "inherit",
                    cursor: disabled ? "default" : "pointer",
                }}
            />

            {children}
        </Paper>
    );
}
