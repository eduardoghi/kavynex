import { Component, type CSSProperties, type ErrorInfo, type ReactNode } from "react";
import { relaunch } from "../../lib/tauri-platform";
import { reportFatalError } from "../../utils/global-error-reporting";

type AppErrorBoundaryProps = {
    children: ReactNode;
};

type AppErrorBoundaryState = {
    error: Error | null;
};

// The fallback renders above MantineProvider (the boundary wraps the whole app so a
// provider crash is also caught), so it can only use plain elements and inline styles.
const containerStyle: CSSProperties = {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: "12px",
    height: "100vh",
    padding: "32px",
    backgroundColor: "#1a1b1e",
    color: "#f1f3f5",
    fontFamily: "Inter, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif",
    textAlign: "center",
};

const detailStyle: CSSProperties = {
    maxWidth: "640px",
    color: "#adb5bd",
    fontSize: "14px",
    overflowWrap: "anywhere",
};

const buttonStyle: CSSProperties = {
    padding: "10px 24px",
    borderRadius: "9999px",
    border: "none",
    fontSize: "14px",
    cursor: "pointer",
};

export class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
    state: AppErrorBoundaryState = { error: null };

    static getDerivedStateFromError(error: Error): AppErrorBoundaryState {
        return { error };
    }

    componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
        reportFatalError(
            "error-boundary",
            `A render error crashed the app. Component stack:${errorInfo.componentStack ?? " <unavailable>"}`,
            error
        );
    }

    handleTryAgain = (): void => {
        this.setState({ error: null });
    };

    handleRestart = (): void => {
        void relaunch().catch(() => {
            // Relaunch needs the Tauri process plugin; if it fails, reloading the webview
            // is the closest recovery available.
            window.location.reload();
        });
    };

    render(): ReactNode {
        if (this.state.error === null) {
            return this.props.children;
        }

        return (
            <div role="alert" style={containerStyle}>
                <h1 style={{ fontSize: "22px", margin: 0 }}>Something went wrong</h1>
                <p style={detailStyle}>
                    The app hit an unexpected error and could not continue. The details were
                    saved to the application log.
                </p>
                {this.state.error.message.trim() && (
                    // A caught render error is a raw JS Error (TypeError, etc.), not a
                    // catalogued AppError, so there is no friendly copy to resolve it to.
                    // Label it as a technical detail - mirroring the app's "Details:"
                    // convention - so it reads as diagnostic text rather than an instruction.
                    <p style={detailStyle}>
                        Technical details: {this.state.error.message}
                    </p>
                )}
                <div style={{ display: "flex", gap: "12px" }}>
                    <button
                        type="button"
                        style={{
                            ...buttonStyle,
                            backgroundColor: "#7048e8",
                            color: "#ffffff",
                        }}
                        onClick={this.handleRestart}
                    >
                        Restart app
                    </button>
                    <button
                        type="button"
                        style={{
                            ...buttonStyle,
                            backgroundColor: "#343a40",
                            color: "#f1f3f5",
                        }}
                        onClick={this.handleTryAgain}
                    >
                        Try again
                    </button>
                </div>
            </div>
        );
    }
}
