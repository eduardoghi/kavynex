import {
    Alert,
    Group,
    Modal,
    Paper,
    Radio,
    SimpleGrid,
    Stack,
    Text,
    TextInput,
    Title,
} from "@mantine/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { FolderOpen, HardDrive, RefreshCcw, Search, Settings2, Wrench } from "lucide-react";
import { getLibrarySummary, type LibrarySummaryInfo } from "../../services/library-service";
import type { ImportMode } from "../../types/settings";
import { parseAppError } from "../../utils/app-error";
import { logError } from "../../utils/app-logger";
import { AppButton } from "../ui/app-button";

function displayWindowsPath(path: string): string {
    const normalizedPath = path.trim();

    if (normalizedPath.startsWith("\\\\?\\UNC\\")) {
        return `\\\\${normalizedPath.slice(8)}`;
    }

    if (normalizedPath.startsWith("\\\\?\\")) {
        return normalizedPath.slice(4);
    }

    return normalizedPath;
}

const EMPTY_LIBRARY_SUMMARY: LibrarySummaryInfo = {
    total_bytes: 0,
    formatted_size: "0 B",
    video_files: 0,
    audio_files: 0,
    thumbnail_files: 0,
};

type SettingsModalProps = {
    opened: boolean;
    onClose: () => void;
    importMode: ImportMode;
    libraryPath: string;
    onChangeImportMode: (mode: ImportMode) => void;
    onChooseLibraryPath: () => void;
    onOpenLibraryPath: () => void;
    onOpenDiagnostics: () => void;
    disableLibraryPathChange: boolean;
    libraryPathChangeDisabledReason: string;
    isMigratingLibraryPath: boolean;
};

export function SettingsModal({
    opened,
    onClose,
    importMode,
    libraryPath,
    onChangeImportMode,
    onChooseLibraryPath,
    onOpenLibraryPath,
    onOpenDiagnostics,
    disableLibraryPathChange,
    libraryPathChangeDisabledReason,
    isMigratingLibraryPath,
}: SettingsModalProps): JSX.Element {
    const [librarySummary, setLibrarySummary] = useState<LibrarySummaryInfo>(EMPTY_LIBRARY_SUMMARY);
    const [isLoadingLibrarySummary, setIsLoadingLibrarySummary] = useState(false);
    const [librarySummaryError, setLibrarySummaryError] = useState("");

    const summaryRequestIdRef = useRef(0);
    const lastLoadedLibraryPathRef = useRef("");

    const loadLibrarySummary = useCallback(
        async (targetLibraryPath: string): Promise<void> => {
            const normalizedLibraryPath = targetLibraryPath.trim();
            const requestId = ++summaryRequestIdRef.current;

            if (!normalizedLibraryPath) {
                lastLoadedLibraryPathRef.current = "";
                setLibrarySummary(EMPTY_LIBRARY_SUMMARY);
                setLibrarySummaryError("");
                setIsLoadingLibrarySummary(false);
                return;
            }

            if (lastLoadedLibraryPathRef.current !== normalizedLibraryPath) {
                setLibrarySummary(EMPTY_LIBRARY_SUMMARY);
            }

            setIsLoadingLibrarySummary(true);
            setLibrarySummaryError("");

            try {
                const summary = await getLibrarySummary(normalizedLibraryPath);

                if (requestId !== summaryRequestIdRef.current) {
                    return;
                }

                lastLoadedLibraryPathRef.current = normalizedLibraryPath;
                setLibrarySummary(summary);
            } catch (error) {
                if (requestId !== summaryRequestIdRef.current) {
                    return;
                }

                lastLoadedLibraryPathRef.current = "";
                logError("settings-modal", "Failed to load library summary.", error, {
                    libraryPath: normalizedLibraryPath,
                    parsed: parseAppError(error),
                });
                setLibrarySummary(EMPTY_LIBRARY_SUMMARY);
                setLibrarySummaryError("Could not load library summary.");
            } finally {
                if (requestId === summaryRequestIdRef.current) {
                    setIsLoadingLibrarySummary(false);
                }
            }
        },
        []
    );

    useEffect(() => {
        if (!opened) {
            summaryRequestIdRef.current += 1;
            lastLoadedLibraryPathRef.current = "";
            setLibrarySummary(EMPTY_LIBRARY_SUMMARY);
            setLibrarySummaryError("");
            setIsLoadingLibrarySummary(false);
            return;
        }

        void loadLibrarySummary(libraryPath);
    }, [opened, libraryPath, loadLibrarySummary]);

    return (
        <Modal
            opened={opened}
            onClose={onClose}
            title="Settings"
            size="lg"
            centered
        >
            <Stack gap="lg">
                <Stack gap="xs">
                    <Group gap="sm">
                        <Settings2 size={18} />
                        <Title order={4}>Import behavior</Title>
                    </Group>

                    <Radio.Group
                        value={importMode}
                        onChange={(value) => onChangeImportMode(value as ImportMode)}
                    >
                        <Stack gap="xs">
                            <Radio
                                value="copy"
                                label="Copy files into the library folder"
                                disabled={isMigratingLibraryPath}
                            />

                            <Radio
                                value="move"
                                label="Move files into the library folder"
                                disabled={isMigratingLibraryPath}
                            />
                        </Stack>
                    </Radio.Group>
                </Stack>

                <Stack gap="xs">
                    <Group gap="sm">
                        <HardDrive size={18} />
                        <Title order={4}>Library folder</Title>
                    </Group>

                    <TextInput
                        value={displayWindowsPath(libraryPath)}
                        readOnly
                        placeholder="No library folder selected"
                    />

                    {!libraryPath.trim() && (
                        <Alert color="blue" variant="light">
                            <Text size="sm">
                                Configure a library folder to enable disk usage, file counters and
                                diagnostics based on the physical library.
                            </Text>
                        </Alert>
                    )}

                    <Group justify="space-between" align="center">
                        <Text size="sm" c="dimmed">
                            Library summary
                        </Text>

                        <AppButton
                            appVariant="ghost"
                            size="xs"
                            leftSection={<RefreshCcw size={14} />}
                            onClick={() => {
                                void loadLibrarySummary(libraryPath);
                            }}
                            disabled={!libraryPath.trim()}
                            loading={isLoadingLibrarySummary}
                        >
                            Refresh
                        </AppButton>
                    </Group>

                    <SimpleGrid cols={{ base: 2, sm: 4 }} spacing="sm">
                        <Paper withBorder radius="md" p="sm">
                            <Stack gap={2}>
                                <Text size="xs" c="dimmed">
                                    Disk usage
                                </Text>
                                <Text fw={700}>
                                    {isLoadingLibrarySummary
                                        ? "Calculating..."
                                        : librarySummary.formatted_size}
                                </Text>
                            </Stack>
                        </Paper>

                        <Paper withBorder radius="md" p="sm">
                            <Stack gap={2}>
                                <Text size="xs" c="dimmed">
                                    Video files
                                </Text>
                                <Text fw={700}>
                                    {isLoadingLibrarySummary
                                        ? "—"
                                        : librarySummary.video_files.toLocaleString()}
                                </Text>
                            </Stack>
                        </Paper>

                        <Paper withBorder radius="md" p="sm">
                            <Stack gap={2}>
                                <Text size="xs" c="dimmed">
                                    Audio files
                                </Text>
                                <Text fw={700}>
                                    {isLoadingLibrarySummary
                                        ? "—"
                                        : librarySummary.audio_files.toLocaleString()}
                                </Text>
                            </Stack>
                        </Paper>

                        <Paper withBorder radius="md" p="sm">
                            <Stack gap={2}>
                                <Text size="xs" c="dimmed">
                                    Thumbnails
                                </Text>
                                <Text fw={700}>
                                    {isLoadingLibrarySummary
                                        ? "—"
                                        : librarySummary.thumbnail_files.toLocaleString()}
                                </Text>
                            </Stack>
                        </Paper>
                    </SimpleGrid>

                    {!!librarySummaryError && (
                        <Alert color="yellow" variant="light">
                            <Text size="sm">{librarySummaryError}</Text>
                        </Alert>
                    )}

                    <Group gap="sm">
                        <AppButton
                            appVariant="primary"
                            leftSection={<Search size={16} />}
                            onClick={onChooseLibraryPath}
                            disabled={disableLibraryPathChange}
                            loading={isMigratingLibraryPath}
                        >
                            Choose folder
                        </AppButton>

                        <AppButton
                            appVariant="secondary"
                            leftSection={<FolderOpen size={16} />}
                            onClick={onOpenLibraryPath}
                            disabled={!libraryPath.trim()}
                        >
                            Open folder
                        </AppButton>

                        <AppButton
                            appVariant="secondary"
                            leftSection={<Wrench size={16} />}
                            onClick={onOpenDiagnostics}
                        >
                            Diagnostics
                        </AppButton>
                    </Group>

                    {disableLibraryPathChange && libraryPathChangeDisabledReason && (
                        <Alert color="yellow" variant="light">
                            <Text size="sm">{libraryPathChangeDisabledReason}</Text>
                        </Alert>
                    )}
                </Stack>
            </Stack>
        </Modal>
    );
}