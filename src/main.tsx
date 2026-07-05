import React from "react";
import ReactDOM from "react-dom/client";
import "@mantine/core/styles.css";
import App from "./App";
import { AppErrorBoundary } from "./components/common/app-error-boundary";
import { installGlobalErrorHandlers } from "./utils/global-error-reporting";

installGlobalErrorHandlers();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </React.StrictMode>,
);
