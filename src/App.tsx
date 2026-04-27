import { MantineProvider, createTheme } from "@mantine/core";
import Home from "./pages/Home";

const theme = createTheme({
    primaryColor: "violet",
    defaultRadius: "xl",
    fontFamily: "Inter, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif",
    headings: {
        fontFamily: "Inter, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif",
    },
    shadows: {
        xs: "0 8px 20px rgba(0,0,0,0.16)",
        sm: "0 10px 30px rgba(0,0,0,0.20)",
        md: "0 18px 50px rgba(0,0,0,0.24)",
        lg: "0 24px 70px rgba(0,0,0,0.30)",
        xl: "0 32px 90px rgba(0,0,0,0.35)",
    },
    components: {
        Button: {
            defaultProps: {
                radius: "xl",
            },
        },
        Card: {
            defaultProps: {
                radius: "xl",
                shadow: "sm",
            },
        },
        Modal: {
            defaultProps: {
                radius: "xl",
                centered: true,
                overlayProps: {
                    blur: 10,
                    opacity: 0.55,
                },
            },
        },
        TextInput: {
            defaultProps: {
                radius: "lg",
            },
        },
        ActionIcon: {
            defaultProps: {
                radius: "xl",
            },
        },
    },
});

export default function App(): JSX.Element {
    return (
        <MantineProvider theme={theme} defaultColorScheme="dark">
            <Home />
        </MantineProvider>
    );
}