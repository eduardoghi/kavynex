import type { RuntimeDiagnosticsInfo } from "../types/diagnostics";

type NavigatorWithUserAgentData = Navigator & {
    userAgentData?: {
        platform?: string;
    };
};

function getNavigatorPlatform(): string | null {
    if (typeof navigator === "undefined") {
        return null;
    }

    const navigatorWithUserAgentData = navigator as NavigatorWithUserAgentData;
    const value = navigatorWithUserAgentData.userAgentData?.platform ?? navigator.platform;

    if (!value || !value.trim()) {
        return null;
    }

    return value.trim();
}

function getArchitectureGuess(): string | null {
    if (typeof navigator === "undefined") {
        return null;
    }

    const userAgent = navigator.userAgent?.toLowerCase() ?? "";

    if (userAgent.includes("arm64") || userAgent.includes("aarch64")) {
        return "arm64";
    }

    if (
        userAgent.includes("x86_64") ||
        userAgent.includes("win64") ||
        userAgent.includes("x64") ||
        userAgent.includes("amd64")
    ) {
        return "x64";
    }

    if (userAgent.includes("i686") || userAgent.includes("i386") || userAgent.includes("x86")) {
        return "x86";
    }

    return null;
}

export async function getRuntimeDiagnosticsInfo(): Promise<RuntimeDiagnosticsInfo> {
    return {
        platform: getNavigatorPlatform() ?? "unknown",
        arch: getArchitectureGuess() ?? "unknown",
    };
}