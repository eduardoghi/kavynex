import {
    MantineProvider,
    createTheme,
    type CSSVariablesResolver,
} from "@mantine/core";
import "@fontsource-variable/bricolage-grotesque";
import Home from "./pages/Home";
import { DISPLAY_FONT_FAMILY } from "./constants/fonts";

const theme = createTheme({
    primaryColor: "violet",
    defaultRadius: "xl",
    fontFamily: "Inter, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif",
    headings: {
        fontFamily: DISPLAY_FONT_FAMILY,
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

// The light scheme's own values, in one place, so the two schemes can be tuned apart
// without a `light-dark()` per component.
//
// theme.shadows above are one set shared by both schemes, and they were built for the dark
// one, where a shadow has to be deep to register at all. On a white surface the same
// numbers read as a smudge under every card, which is why the cards were separating
// themselves by shadow rather than by edge. Light gets softer shadows and, together with
// the firmer shellBorder in use-home-view-state, an edge to separate by.
//
// The dark scheme is deliberately absent here. Nothing about it needed changing.
const cssVariablesResolver: CSSVariablesResolver = () => ({
    variables: {},
    light: {
        // Mantine's light dimmed is gray-6, which lands near 3:1 on white. Every date,
        // handle, helper line and piece of metadata in the app uses it, and at that
        // contrast they read as disabled rather than secondary.
        "--mantine-color-dimmed": "#6B7280",

        // Inputs, dividers and every `withBorder` surface. A little firmer, so an area
        // has an edge without the line being dark.
        "--mantine-color-default-border": "rgba(26,24,37,0.16)",

        // Authors and the reply toggle in the comments. Semantic rather than a palette
        // shade, because blue.4 is a fine link colour on a dark panel and roughly 2.4:1
        // on white.
        "--kx-color-link": "#1971C2",

        "--mantine-shadow-xs": "0 4px 12px rgba(26,24,37,0.06)",
        "--mantine-shadow-sm": "0 6px 18px rgba(26,24,37,0.07)",
        "--mantine-shadow-md": "0 12px 32px rgba(26,24,37,0.09)",
        "--mantine-shadow-lg": "0 18px 46px rgba(26,24,37,0.11)",
        "--mantine-shadow-xl": "0 26px 64px rgba(26,24,37,0.13)",
    },
    dark: {
        "--kx-color-link": "var(--mantine-color-blue-4)",
    },
});

export default function App(): JSX.Element {
    return (
        <MantineProvider
            theme={theme}
            cssVariablesResolver={cssVariablesResolver}
            defaultColorScheme="dark"
        >
            <Home />
        </MantineProvider>
    );
}