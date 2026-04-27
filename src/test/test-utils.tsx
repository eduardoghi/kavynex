import { AppShell, MantineProvider } from "@mantine/core";
import { render, type RenderOptions, type RenderResult } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";

type RenderWithMantineOptions = Omit<RenderOptions, "wrapper"> & {
    withAppShell?: boolean;
};

function Providers({ children }: { children: ReactNode }): JSX.Element {
    return (
        <MantineProvider>
            {children}
        </MantineProvider>
    );
}

function AppShellProviders({ children }: { children: ReactNode }): JSX.Element {
    return (
        <MantineProvider>
            <AppShell header={{ height: 60 }} navbar={{ width: 300, breakpoint: "sm" }}>
                {children}
            </AppShell>
        </MantineProvider>
    );
}

export function renderWithMantine(
    ui: ReactElement,
    options?: RenderWithMantineOptions
): RenderResult {
    const { withAppShell = false, ...rest } = options ?? {};

    return render(ui, {
        wrapper: withAppShell ? AppShellProviders : Providers,
        ...rest,
    });
}