import { Button, type ButtonProps } from "@mantine/core";
import type { ComponentPropsWithoutRef, CSSProperties, ReactNode, Ref } from "react";

type AppButtonVariant = "primary" | "secondary" | "danger" | "ghost";

type NativeButtonProps = Omit<
    ComponentPropsWithoutRef<"button">,
    keyof ButtonProps | "color" | "style"
>;

type AppButtonProps = Omit<ButtonProps, "variant" | "color" | "style"> &
    NativeButtonProps & {
        appVariant?: AppButtonVariant;
        children: ReactNode;
        // A plain prop in React 19, handed to the Mantine button with the rest.
        ref?: Ref<HTMLButtonElement>;
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
            border: "1px solid transparent",
            background: "var(--kx-accent)",
            color: "#ffffff",
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
            border: "1px solid transparent",
            // White text clears 5.6:1 on it.
            background: "#C92A2A",
            color: "#ffffff",
        },
    },
};

// A variant's background/border/shadow are inline styles, which override Mantine's `:disabled`
// dimming, so a disabled button would otherwise look identical to an active one. Replace them with
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
    // Loading keeps the active look (the spinner already signals progress). Only a truly disabled
    // button gets the muted treatment.
    const isDisabled = props.disabled === true && props.loading !== true;

    return (
        <Button
            radius="sm"
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