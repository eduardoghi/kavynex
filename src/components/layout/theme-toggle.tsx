import {
    ActionIcon,
    Tooltip,
    useComputedColorScheme,
    useMantineColorScheme,
} from "@mantine/core";
import { Moon, Sun } from "lucide-react";

// Switches between the light and dark color schemes. Mantine persists the choice (localStorage) and
// flips `color-scheme` on the root, which is what the app's `light-dark(...)` color values resolve
// against. `getInitialValueInEffect` avoids a hydration flash by reading the computed scheme after
// mount.
export function ThemeToggle(): JSX.Element {
    const { setColorScheme } = useMantineColorScheme();
    const computed = useComputedColorScheme("dark", { getInitialValueInEffect: true });
    const isDark = computed === "dark";
    const next = isDark ? "light" : "dark";

    return (
        <Tooltip label={isDark ? "Light theme" : "Dark theme"} withArrow>
            <ActionIcon
                variant="subtle"
                color="gray"
                size="lg"
                radius="md"
                aria-label={`Switch to ${next} theme`}
                onClick={() => setColorScheme(next)}
            >
                {isDark ? <Sun size={18} /> : <Moon size={18} />}
            </ActionIcon>
        </Tooltip>
    );
}
