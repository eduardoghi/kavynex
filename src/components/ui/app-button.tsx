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
            border: "1px solid rgba(124,92,255,0.45)",
            background: "#7C5CFF",
            color: "#ffffff",
            // A soft, muted shadow rather than a bright glow: a saturated semi-transparent violet
            // over a near-black OLED background reads as a burned purple halo, so keep the color
            // dark and the alpha low so it registers as depth, not light.
            boxShadow: "0 8px 22px rgba(60,40,120,0.22)",
        },
    },
    secondary: {
        variant: "subtle",
        color: "gray",
        style: {
            border: "1px solid light-dark(rgba(0,0,0,0.12), rgba(255,255,255,0.10))",
            background: "light-dark(rgba(0,0,0,0.035), rgba(255,255,255,0.035))",
            color: "light-dark(rgba(0,0,0,0.80), rgba(255,255,255,0.86))",
        },
    },
    ghost: {
        variant: "subtle",
        color: "gray",
        style: {
            color: "light-dark(rgba(0,0,0,0.72), rgba(255,255,255,0.78))",
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

// A variant's background/border/shadow are inline styles, which override Mantine's `:disabled`
// dimming - so a disabled button would otherwise look identical to an active one. Replace them with
// one muted, shadowless look so "not clickable" reads at a glance, whatever the variant.
const DISABLED_STYLE: CSSProperties = {
    background: "light-dark(rgba(0,0,0,0.05), rgba(255,255,255,0.05))",
    border: "1px solid light-dark(rgba(0,0,0,0.10), rgba(255,255,255,0.09))",
    color: "light-dark(rgba(0,0,0,0.35), rgba(255,255,255,0.35))",
    boxShadow: "none",
};

export function AppButton({
    appVariant = "secondary",
    style,
    children,
    ...props
}: AppButtonProps): JSX.Element {
    const buttonStyle = BUTTON_STYLES[appVariant];
    // Loading keeps the active look (the spinner already signals progress); only a truly disabled
    // button gets the muted treatment.
    const isDisabled = props.disabled === true && props.loading !== true;

    return (
        <Button
            radius="xl"
            variant={buttonStyle.variant}
            color={buttonStyle.color}
            {...props}
            style={{
                ...buttonStyle.style,
                ...(isDisabled ? DISABLED_STYLE : {}),
                ...style,
            }}
        >
            {children}
        </Button>
    );
}