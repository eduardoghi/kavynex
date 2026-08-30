import React from "react";
import ReactDOM from "react-dom/client";
import "@mantine/core/styles.css";
import "./index.css";
import App from "./App";
import { AppErrorBoundary } from "./components/common/app-error-boundary";
import { installGlobalErrorHandlers } from "./utils/global-error-reporting";
import { runWebviewCheckIfRequested } from "./lib/webview-check";

installGlobalErrorHandlers();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
        <AppErrorBoundary>
            <App />
        </AppErrorBoundary>
    </React.StrictMode>
);

// The startup self-check, on a `--webview-check` launch only (see src/lib/webview-check.ts). It
// runs after the render call rather than before it because reaching this line at all is part of
// what is being checked. A bundle the webview refuses, or a CSP that blocks the entry script,
// never gets here and is reported by the backend watchdog as a timeout. A normal launch resolves
// this to a single null-returning IPC call and nothing else. Deliberately not awaited. The app
// must boot exactly as it always has.
void runWebviewCheckIfRequested();
