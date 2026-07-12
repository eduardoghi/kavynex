import { Box, Group, Text } from "@mantine/core";
import { CheckCircle2, XCircle } from "lucide-react";
import { useState } from "react";
import { checkDatabaseIntegrity } from "../../../services/database-service";
import { logError } from "../../../utils/app-logger";
import { resolveErrorMessage } from "../../../utils/error-message";
import { AppButton } from "../../ui/app-button";

type IntegrityResult =
    | { status: "ok" }
    | { status: "problem" }
    | { status: "error"; message: string };

export function DiagnosticsDatabaseIntegrityCheck(): JSX.Element {
    const [loading, setLoading] = useState(false);
    const [result, setResult] = useState<IntegrityResult | null>(null);

    async function runCheck(): Promise<void> {
        setLoading(true);
        setResult(null);

        try {
            const ok = await checkDatabaseIntegrity();
            setResult(ok ? { status: "ok" } : { status: "problem" });
        } catch (error) {
            logError("diagnostics", "Failed to run the database integrity check.", error);
            setResult({
                status: "error",
                message: resolveErrorMessage(error, "Failed to run the integrity check."),
            });
        } finally {
            setLoading(false);
        }
    }

    return (
        <Group justify="space-between" align="center" wrap="wrap" gap="sm">
            <AppButton
                type="button"
                appVariant="secondary"
                onClick={() => void runCheck()}
                loading={loading}
            >
                Run full integrity check
            </AppButton>

            {/* Persistent live region so the check's outcome is announced to screen readers
                when it lands, instead of only being a visual color/icon change. */}
            <Box role="status" aria-live="polite">
                {result?.status === "ok" && (
                    <Group gap={6} c="green">
                        <CheckCircle2 size={16} />
                        <Text size="sm">No problems found</Text>
                    </Group>
                )}

                {result?.status === "problem" && (
                    <Group gap={6} c="red">
                        <XCircle size={16} />
                        <Text size="sm">Integrity check reported a problem</Text>
                    </Group>
                )}

                {result?.status === "error" && (
                    <Group gap={6} c="red">
                        <XCircle size={16} />
                        <Text size="sm">{result.message}</Text>
                    </Group>
                )}
            </Box>
        </Group>
    );
}
