import { Anchor, Box, Divider, Group, Paper, Stack, Text, ThemeIcon, Title, Badge } from "@mantine/core";
import { AlertTriangle, FolderOpen, Info, Trash2 } from "lucide-react";
import type {
    DiagnosticsIssue,
    DiagnosticsMediaTarget,
    KeptFolder,
    OrphanRemovalPlan,
    OrphanRemovalRefusal,
} from "../../../types/diagnostics";
import { AppButton } from "../../ui/app-button";
import { ORPHAN_GRACE_PERIOD_DAYS } from "../../../constants/library-retention";

// Where the removal action is drawn, under the first of these issues present. Which files the
// removal takes, and whether it may run, is the backend's call (`orphanRemoval`).
const ORPHAN_ISSUE_CODES: ReadonlySet<string> = new Set([
    "ORPHAN_MEDIA_FILES",
    "ORPHAN_THUMBNAIL_FILES",
]);

const ORPHAN_REMOVAL_REFUSAL_TEXT: Record<OrphanRemovalRefusal, string> = {
    recentDatabaseSwap:
        `Removing these files is not offered for ${ORPHAN_GRACE_PERIOD_DAYS} days after a database import or restore, since they may belong to the database it replaced.`,
    mostFilesUnreferenced:
        "Removing these files is not offered while most of the library's files are unreferenced. That usually means the database is older than the folder or belongs to another library.",
};

// The issues that name a folder the app keeps files in, and which folder each one opens.
const KEPT_FOLDER_BY_ISSUE_CODE: Readonly<Record<string, KeptFolder>> = {
    RECOVERED_DOWNLOADS_PRESENT: "recoveredDownloads",
    LIBRARY_TRASH_HOLDS_FILES: "libraryTrash",
    SET_ASIDE_BACKUPS_PRESENT: "setAsideBackups",
};

type DiagnosticsIssuesSectionProps = {
    issues: DiagnosticsIssue[];
    // When given, example paths that map to an existing media row become clickable and jump to
    // that media in the library (used for "missing media". The file is gone but the row remains).
    onOpenMedia?: (target: DiagnosticsMediaTarget) => void;
    // When given, example paths of an issue whose files are on disk (`examplesAreOnDisk`) become
    // clickable and reveal the file in the OS file manager, for a corrupt file (which nothing here
    // removes) or an orphan the user wants to look at first. A content-addressed name is not one to
    // retype.
    onRevealPath?: (path: string) => void;
    // When given, the first orphan media or thumbnail issue offers to remove those files. One
    // button for both, since one removal covers both.
    onRemoveOrphans?: () => void;
    removingOrphans?: boolean;
    // What the removal would take and whether the backend allows it. The action is offered only
    // when there is something to take and no refusal.
    orphanRemoval?: OrphanRemovalPlan | null;
    // When given, the issues that name a kept folder (the recovered downloads, the library trash)
    // offer to open it.
    onOpenKeptFolder?: (folder: KeptFolder) => void;
};

// One example path rendered as a link. Extracted because the two link branches below differ only in
// what they do and what the tooltip says, and spelling the same seven presentation props twice is
// how they start to drift.
function ExamplePathLink({
    path,
    title,
    onActivate,
}: {
    path: string;
    title: string;
    onActivate: () => void;
}): JSX.Element {
    return (
        <Anchor
            component="button"
            type="button"
            size="xs"
            ff="monospace"
            ta="left"
            style={{ overflowWrap: "anywhere" }}
            title={title}
            onClick={onActivate}
        >
            {path}
        </Anchor>
    );
}

function IssueSeverityBadge({
    severity,
}: {
    severity: DiagnosticsIssue["severity"];
}): JSX.Element {
    if (severity === "error") {
        return (
            <Badge color="red" variant="light">
                Error
            </Badge>
        );
    }

    if (severity === "warning") {
        return (
            <Badge color="yellow" variant="light">
                Warning
            </Badge>
        );
    }

    return (
        <Badge color="blue" variant="light">
            Info
        </Badge>
    );
}

function IssueSeverityIcon({
    severity,
}: {
    severity: DiagnosticsIssue["severity"];
}): JSX.Element {
    if (severity === "error") {
        return (
            <ThemeIcon color="red" variant="light" radius="xl">
                <AlertTriangle size={16} />
            </ThemeIcon>
        );
    }

    if (severity === "warning") {
        return (
            <ThemeIcon color="yellow" variant="light" radius="xl">
                <AlertTriangle size={16} />
            </ThemeIcon>
        );
    }

    return (
        <ThemeIcon color="blue" variant="light" radius="xl">
            <Info size={16} />
        </ThemeIcon>
    );
}

export function DiagnosticsIssuesSection({
    issues,
    onOpenMedia,
    onRevealPath,
    onRemoveOrphans,
    removingOrphans = false,
    orphanRemoval = null,
    onOpenKeptFolder,
}: DiagnosticsIssuesSectionProps): JSX.Element | null {
    const removeOrphansIssueCode =
        orphanRemoval && orphanRemoval.files > 0
            ? issues.find((issue) => ORPHAN_ISSUE_CODES.has(issue.code))?.code
            : undefined;
    const orphanRefusal = orphanRemoval?.refusal ?? null;

    // Nothing to list, nothing to show. The heading plus a card saying the environment
    // looks healthy repeated the green status at the top of the dialog, and it did it in
    // the largest block on the screen.
    if (issues.length === 0) {
        return null;
    }

    return (
        <Paper
            withBorder
            radius="xl"
            p="md"
            style={{
                background:
                    "light-dark(linear-gradient(180deg, rgba(0,0,0,0.028), rgba(0,0,0,0.015)), linear-gradient(180deg, rgba(255,255,255,0.03), rgba(255,255,255,0.015)))",
            }}
        >
            <Stack gap="sm">
                <Title order={3} size="h4">Issues</Title>


                {issues.map((issue, index) => (
                    <Box key={issue.code}>
                        <Group justify="space-between" align="start" wrap="nowrap" gap="md">
                            <Group gap="sm" align="start" wrap="nowrap" style={{ minWidth: 0, flex: 1 }}>
                                <IssueSeverityIcon severity={issue.severity} />

                                <Box style={{ minWidth: 0 }}>
                                    <Text fw={700}>{issue.title}</Text>
                                    <Text size="sm" c="dimmed">
                                        {issue.description}
                                    </Text>

                                    {issue.examples && issue.examples.length > 0 && (
                                        <Stack gap={2} mt={6}>
                                            {issue.examples.map((example) => {
                                                const target = example.media;

                                                if (target && onOpenMedia) {
                                                    return (
                                                        <ExamplePathLink
                                                            key={example.path}
                                                            path={example.path}
                                                            title="Open this media in the library"
                                                            onActivate={() => onOpenMedia(target)}
                                                        />
                                                    );
                                                }

                                                // Gated on the issue rather than on this example
                                                // lacking a media target. A missing thumbnail also
                                                // has no target, and revealing a file that is not
                                                // there would fail every time. See
                                                // `examplesAreOnDisk`.
                                                if (issue.examplesAreOnDisk && onRevealPath) {
                                                    return (
                                                        <ExamplePathLink
                                                            key={example.path}
                                                            path={example.path}
                                                            title="Show this file in your file manager"
                                                            onActivate={() =>
                                                                onRevealPath(example.path)
                                                            }
                                                        />
                                                    );
                                                }

                                                return (
                                                    <Text
                                                        key={example.path}
                                                        size="xs"
                                                        c="dimmed"
                                                        ff="monospace"
                                                        style={{ overflowWrap: "anywhere" }}
                                                    >
                                                        {example.path}
                                                    </Text>
                                                );
                                            })}
                                        </Stack>
                                    )}

                                    {issue.code === removeOrphansIssueCode && orphanRefusal && (
                                        <Text size="xs" c="dimmed" mt="sm">
                                            {ORPHAN_REMOVAL_REFUSAL_TEXT[orphanRefusal]}
                                        </Text>
                                    )}

                                    {onRemoveOrphans &&
                                        issue.code === removeOrphansIssueCode &&
                                        !orphanRefusal && (
                                        <AppButton
                                            type="button"
                                            appVariant="secondary"
                                            size="xs"
                                            mt="sm"
                                            leftSection={<Trash2 size={14} />}
                                            onClick={onRemoveOrphans}
                                            loading={removingOrphans}
                                            disabled={removingOrphans}
                                        >
                                            Remove orphan files
                                        </AppButton>
                                    )}

                                    {onOpenKeptFolder && KEPT_FOLDER_BY_ISSUE_CODE[issue.code] && (
                                        <AppButton
                                            type="button"
                                            appVariant="secondary"
                                            size="xs"
                                            mt="sm"
                                            leftSection={<FolderOpen size={14} />}
                                            onClick={() => {
                                                const folder = KEPT_FOLDER_BY_ISSUE_CODE[issue.code];

                                                if (folder) {
                                                    onOpenKeptFolder(folder);
                                                }
                                            }}
                                        >
                                            Open folder
                                        </AppButton>
                                    )}
                                </Box>
                            </Group>

                            <IssueSeverityBadge severity={issue.severity} />
                        </Group>

                        {index < issues.length - 1 && <Divider mt="md" />}
                    </Box>
                ))}
            </Stack>
        </Paper>
    );
}