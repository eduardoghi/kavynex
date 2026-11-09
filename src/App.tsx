import {
    MantineProvider,
    createTheme,
    type CSSVariablesResolver,
} from "@mantine/core";
import "@fontsource-variable/bricolage-grotesque";
import Home from "./pages/Home";
import { DISPLAY_FONT_FAMILY } from "./constants/fonts";
import { MotionPreferenceProvider } from "./hooks/use-motion-preference";
import { CloseWhileBusyPrompt } from "./components/layout/close-while-busy-prompt";

// The look is sober on purpose. One flat accent taken from the logo's violet, neutral gray
// surfaces, small corners, short shadows, and no gradients, glows or frosted glass, so the media
// carries the color.
const theme = createTheme({
    colors: {
        // The logo's violet, shade 6 being the accent. White text clears 5.3:1 on it.
        kavynex: [
            "#F3F0FF",
            "#E4DEFC",
            "#C9BDF7",
            "#AD9BF1",
            "#9480EA",
            "#8068E2",
            "#6E56CF",
            "#5F48B8",
            "#523DA0",
            "#433285",
        ],
        // Neutral grays rather than Mantine's, so a dark surface carries no tint.
        dark: [
            "#ECEDEE",
            "#B4B6BB",
            "#9A9DA3",
            "#6B6E75",
            "#3A3C42",
            "#2E3036",
            "#26282D",
            "#1C1D21",
            "#17181B",
            "#111214",
        ],
    },
    primaryColor: "kavynex",
    primaryShade: { light: 6, dark: 6 },
    defaultRadius: "sm",
    radius: {
        xs: "2px",
        sm: "4px",
        md: "6px",
        lg: "8px",
        xl: "10px",
    },
    fontFamily: "Inter, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif",
    headings: {
        fontFamily: DISPLAY_FONT_FAMILY,
        fontWeight: "700",
    },
    shadows: {
        xs: "0 1px 2px rgba(0,0,0,0.20)",
        sm: "0 2px 6px rgba(0,0,0,0.22)",
        md: "0 6px 16px rgba(0,0,0,0.26)",
        lg: "0 10px 28px rgba(0,0,0,0.30)",
        xl: "0 16px 40px rgba(0,0,0,0.34)",
    },
    components: {
        Card: {
            defaultProps: {
                radius: "md",
            },
        },
        Modal: {
            defaultProps: {
                radius: "md",
                centered: true,
                overlayProps: {
                    opacity: 0.6,
                },
            },
        },
    },
});

// Each scheme's own values, in one place, so the two can be tuned apart without a `light-dark()`
// per component.
//
// theme.shadows above are one set shared by both schemes, made for the dark one. On a white
// surface they read heavier, so light gets softer ones and, together with the firmer shellBorder
// in use-home-view-state, an edge to separate by.
const cssVariablesResolver: CSSVariablesResolver = () => ({
    variables: {
        // The accent for what Mantine's primary color does not reach (a selected row or card, the
        // primary button), as a fill and as a line.
        "--kx-accent": "#6E56CF",
        "--kx-accent-soft": "rgba(110,86,207,0.14)",
        "--kx-accent-line": "rgba(110,86,207,0.55)",
    },
    light: {
        // Mantine's light dimmed is gray-6, which lands near 3:1 on white. Every date,
        // handle, helper line and piece of metadata in the app uses it, and at that
        // contrast they read as disabled rather than secondary. This clears 5:1 on the page
        // as well as on white.
        "--mantine-color-dimmed": "#5E6168",

        // Inputs, dividers and every `withBorder` surface. A little firmer, so an area
        // has an edge without the line being dark.
        "--mantine-color-default-border": "rgba(20,20,24,0.16)",

        // Authors and the reply toggle in the comments. Semantic rather than a palette
        // shade, because blue.4 is a fine link colour on a dark panel and roughly 2.4:1
        // on white.
        "--kx-color-link": "#1971C2",

        // Warning, error and success text, for the same reason. The palette shades these used
        // (yellow, red.4, teal.4) are made for the dark panel and land between 1.7:1 and 3:1 on
        // white. These clear 4.5:1.
        "--kx-color-warning-text": "#9A6700",
        "--kx-color-error-text": "#C92A2A",
        "--kx-color-success-text": "#087F5B",

        "--mantine-shadow-xs": "0 1px 2px rgba(20,20,24,0.06)",
        "--mantine-shadow-sm": "0 2px 6px rgba(20,20,24,0.07)",
        "--mantine-shadow-md": "0 6px 16px rgba(20,20,24,0.09)",
        "--mantine-shadow-lg": "0 10px 28px rgba(20,20,24,0.11)",
        "--mantine-shadow-xl": "0 16px 40px rgba(20,20,24,0.13)",
    },
    dark: {
        // The palette's dark-2. Mantine dims with a darker gray, which lands near 4:1 on the modal
        // and card surfaces. This clears 4.8:1 on every dark surface.
        "--mantine-color-dimmed": "#9A9DA3",

        "--kx-color-link": "var(--mantine-color-blue-4)",
        "--kx-color-warning-text": "var(--mantine-color-yellow-4)",
        "--kx-color-error-text": "var(--mantine-color-red-4)",
        "--kx-color-success-text": "var(--mantine-color-teal-4)",
    },
});

export default function App(): JSX.Element {
    return (
        <MantineProvider
            theme={theme}
            cssVariablesResolver={cssVariablesResolver}
            defaultColorScheme="dark"
        >
            {/* Resolves the motion preference (Settings > Motion, or the OS setting) and stamps it
                on <html> for src/index.css. Inside MantineProvider only for the sake of the tree
                order; it reads nothing from it. */}
            <MotionPreferenceProvider>
                <Home />
                <CloseWhileBusyPrompt />
            </MotionPreferenceProvider>
        </MantineProvider>
    );
}