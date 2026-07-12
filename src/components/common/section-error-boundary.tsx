import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button, Card, Group, Stack, Text, Title } from "@mantine/core";
import { AlertTriangle } from "lucide-react";
import { reportFatalError } from "../../utils/global-error-reporting";

type SectionErrorBoundaryProps = {
    children: ReactNode;
    // Scope used when the crash is written to the log file, so a bug report can tell which
    // subtree failed (e.g. "media-player").
    scope: string;
    title: string;
    description: string;
    // When any value here changes, the boundary clears a previously caught error and retries
    // rendering its children - so, for example, switching to another media re-arms a player
    // that crashed on the previous one instead of staying stuck on the fallback.
    resetKeys?: ReadonlyArray<unknown>;
    // Optional extra action shown next to "Try again" (e.g. "Close player"). The label is only
    // rendered when a handler is provided.
    actionLabel?: string;
    onAction?: () => void;
    shellBorder?: string;
};

type SectionErrorBoundaryState = {
    error: Error | null;
};

function resetKeysChanged(
    previous: ReadonlyArray<unknown> | undefined,
    next: ReadonlyArray<unknown> | undefined
): boolean {
    if (previous === next) {
        return false;
    }

    if (!previous || !next || previous.length !== next.length) {
        return true;
    }

    return previous.some((value, index) => !Object.is(value, next[index]));
}

// Isolates a render crash to one subtree instead of unmounting the whole app to the root
// AppErrorBoundary. Unlike that boundary (which renders above MantineProvider and must use
// plain elements), this one lives inside the provider, so it degrades to an inline Mantine
// card and leaves the rest of the app - sidebar, library, modals - fully usable.
export class SectionErrorBoundary extends Component<
    SectionErrorBoundaryProps,
    SectionErrorBoundaryState
> {
    state: SectionErrorBoundaryState = { error: null };

    static getDerivedStateFromError(error: Error): SectionErrorBoundaryState {
        return { error };
    }

    componentDidUpdate(previousProps: SectionErrorBoundaryProps): void {
        if (
            this.state.error !== null &&
            resetKeysChanged(previousProps.resetKeys, this.props.resetKeys)
        ) {
            this.setState({ error: null });
        }
    }

    componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
        reportFatalError(
            this.props.scope,
            `A render error crashed the ${this.props.scope} section. Component stack:${errorInfo.componentStack ?? " <unavailable>"}`,
            error
        );
    }

    handleTryAgain = (): void => {
        this.setState({ error: null });
    };

    render(): ReactNode {
        if (this.state.error === null) {
            return this.props.children;
        }

        const { title, description, actionLabel, onAction, shellBorder } = this.props;

        return (
            <Card
                withBorder
                radius="xl"
                p="xl"
                role="alert"
                style={shellBorder ? { borderColor: shellBorder } : undefined}
            >
                <Stack gap="sm">
                    <Group gap="xs" align="center">
                        <AlertTriangle size={20} color="var(--mantine-color-red-5)" />
                        <Title order={4} fw={900}>
                            {title}
                        </Title>
                    </Group>

                    <Text c="dimmed">{description}</Text>

                    {this.state.error.message.trim() && (
                        <Text size="sm" c="dimmed" style={{ overflowWrap: "anywhere" }}>
                            Technical details: {this.state.error.message}
                        </Text>
                    )}

                    <Group gap="sm">
                        <Button variant="light" onClick={this.handleTryAgain}>
                            Try again
                        </Button>

                        {actionLabel && onAction && (
                            <Button variant="subtle" color="gray" onClick={onAction}>
                                {actionLabel}
                            </Button>
                        )}
                    </Group>
                </Stack>
            </Card>
        );
    }
}
