import { Button, type ButtonProps } from "@mantine/core";
import type { ComponentPropsWithoutRef, CSSProperties, ReactNode } from "react";

type AppButtonVariant = "primary" | "secondary" | "danger" | "ghost";

type NativeButtonProps = Omit<
    ComponentPropsWithoutRef<"button">,
    keyof ButtonProps | "color" | "style"
>;

type AppButtonProps = Omit<ButtonProps, "variant" | "color" | "style"> &
    NativeButtonProps & {
        appVariant?: AppButtonVariant;
        children: ReactNode;
        style?: CSSProperties;
    };

type AppButtonStyleConfig = {
    variant: ButtonProps["variant"];
    color?: ButtonProps["color"];
    style: CSSProperties;
};

const BUTTON_STYLES: Record<AppButtonVariant, AppButtonStyleConfig> = {
    primary: {
        variant: "filled",
        style: {
            border: "1px solid rgba(139,92,246,0.34)",
            background:
                "linear-gradient(135deg, rgba(124,92,255,0.90), rgba(14,165,233,0.78))",
            color: "#ffffff",
            boxShadow: "0 12px 28px rgba(80,50,180,0.22)",
        },
    },
    secondary: {
        variant: "subtle",
        color: "gray",
        style: {
            border: "1px solid rgba(255,255,255,0.10)",
            background: "rgba(255,255,255,0.035)",
            color: "rgba(255,255,255,0.86)",
        },
    },
    ghost: {
        variant: "subtle",
        color: "gray",
        style: {
            color: "rgba(255,255,255,0.78)",
        },
    },
    danger: {
        variant: "filled",
        color: "red",
        style: {
            border: "1px solid rgba(239,68,68,0.34)",
            background:
                "linear-gradient(135deg, rgba(239,68,68,0.88), rgba(185,28,28,0.76))",
            color: "#ffffff",
            boxShadow: "0 12px 28px rgba(127,29,29,0.20)",
        },
    },
};

export function AppButton({
    appVariant = "secondary",
    style,
    children,
    ...props
}: AppButtonProps): JSX.Element {
    const buttonStyle = BUTTON_STYLES[appVariant];

    return (
        <Button
            radius="xl"
            variant={buttonStyle.variant}
            color={buttonStyle.color}
            {...props}
            style={{
                ...buttonStyle.style,
                ...style,
            }}
        >
            {children}
        </Button>
    );
}