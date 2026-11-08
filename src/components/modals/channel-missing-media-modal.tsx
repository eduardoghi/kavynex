import { useEffect, useMemo, useState } from "react";
import {
    Alert,
    Badge,
    Checkbox,
    Group,
    Loader,
    Modal,
    ScrollArea,
    SegmentedControl,
    Stack,
    Text,
    TextInput,
} from "@mantine/core";
import { Search } from "lucide-react";
import type { ChannelMediaOnYoutube } from "../../types/generated/ChannelMediaOnYoutube";
import type { ChannelMissingMediaController } from "../../hooks/channels/use-channel-missing-media";
import type {
    BatchImportController,
    BatchImportItem,
    BatchImportOptions,
} from "../../hooks/use-batch-import";
import { useBatchImportOptions } from "../../hooks/use-batch-import-options";
import { BatchImportSetupPanel } from "./batch-import-setup-panel";
import type { YtDlpTerminalStore } from "../../hooks/yt-dlp-terminal-store";
import { ChannelBatchImportPanel } from "./channel-batch-import-panel";
import { formatDuration } from "../../utils/media-utils";
import { formatNumber } from "../../utils/number-format";
import { normalizeSearchValue } from "../../utils/comment-tree";
import { AppButton } from "../ui/app-button";
import { MODAL_CLOSE_BUTTON_STYLE, MODAL_TITLE_STYLE } from "../ui/modal-chrome";

type KindFilter = "all" | "video" | "live";

// The media still offered for import, or the ones the user ignored.
type View = "missing" | "ignored";

// Rows drawn at a time. A channel can list thousands, and "Show more" adds the next page.
const PAGE_SIZE = 100;

type ChannelMissingMediaModalProps = {
    opened: boolean;
    onClose: () => void;
    channelId: number;
    channelName: string;
    missingMedia: ChannelMissingMediaController;
    // Opens the add-media form on this media. The modal closes first.
    onImport: (media: ChannelMediaOnYoutube) => void;
    // Why importing is not possible right now (no library folder, a media being added), or null.
    importDisabledReason: string | null;
    // Adds the selected media one after another. Shared with the add-media form, which a batch
    // shows its downloads through.
    batchImport: BatchImportController;
    terminal: YtDlpTerminalStore;
    isYtDlpRunning: boolean;
};


// The date the channel's tab shows for it, which yt-dlp reads from "3 weeks ago", so a day or a
// month off for older media.
function formatListedDate(publishedAt: number | null): string {
    if (publishedAt === null) {
        return "";
    }

    return new Date(publishedAt * 1000).toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
    });
}

export function ChannelMissingMediaModal({
    opened,
    onClose,
    channelId,
    channelName,
    missingMedia,
    onImport,
    importDisabledReason,
    batchImport,
    terminal,
    isYtDlpRunning,
}: ChannelMissingMediaModalProps): JSX.Element {
    const { result, isLoading, error, openedIds, ignoreError, check, cancel, setIgnored } =
        missingMedia;
    const [view, setView] = useState<View>("missing");
    const [filter, setFilter] = useState<KindFilter>("all");
    const [search, setSearch] = useState("");
    const [shown, setShown] = useState(PAGE_SIZE);
    // The media picked for a batch, and whether its options are being chosen.
    const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set());
    const [choosingBatch, setChoosingBatch] = useState(false);
    const batchOptions = useBatchImportOptions();

    // A batch is shown on the page of the channel it adds to. One for another channel only keeps
    // this one from starting.
    const batchIsHere = batchImport.channelId === channelId && batchImport.items.length > 0;
    const batchElsewhere = batchImport.isRunning && batchImport.channelId !== channelId;
    // What this channel's batch added, which leaves the list as an import from the form would on
    // the next listing.
    const addedIds = useMemo(
        () =>
            new Set(
                batchImport.channelId === channelId
                    ? batchImport.items
                          .filter((item) => item.status === "done")
                          .map((item) => item.youtubeVideoId)
                    : []
            ),
        [batchImport.channelId, batchImport.items, channelId]
    );
    // Whether this channel page has asked YouTube yet. A stopped listing leaves no result, and the
    // modal must not start it over on its own.
    const [asked, setAsked] = useState(false);

    // Listed the first time the modal opens. Reopened later, it shows that listing until "Check
    // again", since asking YouTube takes a few seconds and the answer rarely changes in between.
    useEffect(() => {
        if (opened && !asked) {
            setAsked(true);
            void check();
        }
    }, [opened, asked, check]);

    // Matched against the title the way the comment search is, without regard to case or accents.
    const viewed = useMemo(
        () =>
            ((view === "missing" ? result?.missing : result?.ignored) ?? []).filter(
                (media) => !addedIds.has(media.youtube_video_id)
            ),
        [result, view, addedIds]
    );

    const searched = useMemo(() => {
        const query = normalizeSearchValue(search);

        return query
            ? viewed.filter((media) => normalizeSearchValue(media.title).includes(query))
            : viewed;
    }, [viewed, search]);

    const counts = useMemo(() => {
        const missing = searched;

        return {
            all: missing.length,
            video: missing.filter((media) => media.kind === "video").length,
            live: missing.filter((media) => media.kind === "live").length,
        };
    }, [searched]);

    const filtered = useMemo(
        () => searched.filter((media) => filter === "all" || media.kind === filter),
        [searched, filter]
    );

    // The picked media still offered for import, in the list's order.
    const selected = useMemo(
        () =>
            (result?.missing ?? []).filter(
                (media) =>
                    selectedIds.has(media.youtube_video_id) &&
                    !addedIds.has(media.youtube_video_id)
            ),
        [result, selectedIds, addedIds]
    );
    const allFilteredSelected =
        filtered.length > 0 && filtered.every((media) => selectedIds.has(media.youtube_video_id));

    const toggleSelected = (youtubeVideoId: string): void => {
        setSelectedIds((current) => {
            const next = new Set(current);

            if (!next.delete(youtubeVideoId)) {
                next.add(youtubeVideoId);
            }

            return next;
        });
    };

    const toggleAllFiltered = (): void => {
        setSelectedIds((current) => {
            const next = new Set(current);

            for (const media of filtered) {
                if (allFilteredSelected) {
                    next.delete(media.youtube_video_id);
                } else {
                    next.add(media.youtube_video_id);
                }
            }

            return next;
        });
    };

    const startBatch = (items: BatchImportItem[], options: BatchImportOptions): void => {
        setChoosingBatch(false);
        setSelectedIds(new Set());
        void batchImport.start(channelId, items, options);
    };

    const close = (): void => {
        if (isLoading) {
            cancel();
        }

        onClose();
    };

    return (
        <Modal
            opened={opened}
            onClose={close}
            title="On YouTube, not in the library"
            size="lg"
            centered
            radius="lg"
            overlayProps={{ blur: 6 }}
            styles={{ title: MODAL_TITLE_STYLE }}
            closeButtonProps={{
                "aria-label": "Close the list of media not in the library",
                style: MODAL_CLOSE_BUTTON_STYLE,
            }}
        >
            <Stack gap="md">
                {isLoading && (
                    <Group gap="sm" role="status">
                        <Loader size="sm" />
                        <Text size="sm">
                            Listing the videos and lives of {channelName} on YouTube...
                        </Text>
                        <AppButton appVariant="ghost" size="xs" onClick={cancel}>
                            Stop
                        </AppButton>
                    </Group>
                )}

                {!isLoading && asked && result === null && error === null && (
                    <Group gap="sm">
                        <Text size="sm">The listing was stopped.</Text>
                        <AppButton size="xs" onClick={() => void check()}>
                            List the channel
                        </AppButton>
                    </Group>
                )}

                {!isLoading && error !== null && (
                    <Alert color="red" title="The channel could not be listed">
                        <Stack gap="xs">
                            <Text size="sm">{error}</Text>
                            <Group>
                                <AppButton size="xs" onClick={() => void check()}>
                                    Try again
                                </AppButton>
                            </Group>
                        </Stack>
                    </Alert>
                )}

                {batchIsHere && (
                    <ChannelBatchImportPanel
                        batchImport={batchImport}
                        terminal={terminal}
                        isYtDlpRunning={isYtDlpRunning}
                    />
                )}

                {!batchIsHere && !isLoading && result !== null && error === null && (
                    <>
                        <Group justify="space-between" align="center">
                            <Text size="sm" c="dimmed">
                                {result.missing.length === 0 && result.ignored.length === 0
                                    ? `All ${formatNumber(result.listed)} videos and lives the channel lists are in the library.`
                                    : `${formatNumber(result.missing.length + result.ignored.length)} of ${formatNumber(result.listed)} are not in the library.`}
                            </Text>
                            <AppButton
                                appVariant="ghost"
                                size="xs"
                                onClick={() => {
                                    setShown(PAGE_SIZE);
                                    void check();
                                }}
                            >
                                Check again
                            </AppButton>
                        </Group>

                        {(result.missing.length > 0 || result.ignored.length > 0) && (
                            <SegmentedControl
                                aria-label="Which media to show"
                                value={view}
                                onChange={(value) => {
                                    setView(value as View);
                                    setShown(PAGE_SIZE);
                                }}
                                data={[
                                    {
                                        value: "missing",
                                        label: `To import (${formatNumber(result.missing.length)})`,
                                    },
                                    {
                                        value: "ignored",
                                        label: `Ignored (${formatNumber(result.ignored.length)})`,
                                    },
                                ]}
                            />
                        )}

                        {ignoreError && (
                            <Alert color="red" title="Not saved">
                                {ignoreError}
                            </Alert>
                        )}

                        {viewed.length > 0 && (
                            <TextInput
                                aria-label="Search the titles not in the library"
                                placeholder="Search titles"
                                leftSection={<Search size={16} />}
                                value={search}
                                onChange={(event) => {
                                    setSearch(event.currentTarget.value);
                                    setShown(PAGE_SIZE);
                                }}
                            />
                        )}

                        {viewed.length > 0 && (
                            <SegmentedControl
                                aria-label="Videos or lives"
                                value={filter}
                                onChange={(value) => {
                                    setFilter(value as KindFilter);
                                    setShown(PAGE_SIZE);
                                }}
                                data={[
                                    { value: "all", label: `All (${formatNumber(counts.all)})` },
                                    {
                                        value: "video",
                                        label: `Videos (${formatNumber(counts.video)})`,
                                    },
                                    {
                                        value: "live",
                                        label: `Lives (${formatNumber(counts.live)})`,
                                    },
                                ]}
                            />
                        )}

                        {view === "missing" && viewed.length > 0 && (
                            <Group justify="space-between" align="center">
                                <Checkbox
                                    label={`Select all shown (${formatNumber(filtered.length)})`}
                                    checked={allFilteredSelected}
                                    indeterminate={
                                        !allFilteredSelected &&
                                        filtered.some((media) =>
                                            selectedIds.has(media.youtube_video_id)
                                        )
                                    }
                                    onChange={toggleAllFiltered}
                                />
                                <AppButton
                                    size="xs"
                                    disabled={
                                        selected.length === 0 ||
                                        importDisabledReason !== null ||
                                        batchElsewhere
                                    }
                                    onClick={() => setChoosingBatch(true)}
                                >
                                    Import selected ({formatNumber(selected.length)})
                                </AppButton>
                            </Group>
                        )}

                        {batchElsewhere && (
                            <Text size="xs" c="dimmed">
                                A batch import for another channel is running.
                            </Text>
                        )}

                        {choosingBatch && (
                            <BatchImportSetupPanel
                                media={selected}
                                options={batchOptions}
                                onBack={() => setChoosingBatch(false)}
                                onStart={startBatch}
                            />
                        )}

                        {importDisabledReason && view === "missing" && viewed.length > 0 && (
                            <Text size="xs" c="dimmed">
                                {importDisabledReason}
                            </Text>
                        )}

                        {!choosingBatch && filtered.length > 0 && (
                            <ScrollArea.Autosize mah="55vh" offsetScrollbars>
                                <Stack
                                    gap="xs"
                                    component="ul"
                                    style={{ listStyle: "none", padding: 0, margin: 0 }}
                                >
                                    {filtered.slice(0, shown).map((media) => {
                                        const wasOpened = openedIds.has(media.youtube_video_id);
                                        const details = [
                                            media.kind === "live" ? "Live" : "Video",
                                            formatDuration(media.duration_seconds),
                                            formatListedDate(media.published_at),
                                        ].filter(Boolean);

                                        return (
                                            <Group
                                                key={media.youtube_video_id}
                                                component="li"
                                                justify="space-between"
                                                wrap="nowrap"
                                                gap="sm"
                                            >
                                                {view === "missing" && (
                                                    <Checkbox
                                                        aria-label={`Select ${media.title}`}
                                                        checked={selectedIds.has(
                                                            media.youtube_video_id
                                                        )}
                                                        onChange={() =>
                                                            toggleSelected(media.youtube_video_id)
                                                        }
                                                    />
                                                )}

                                                <Stack gap={2} style={{ minWidth: 0, flex: 1 }}>
                                                    <Text size="sm" fw={600} lineClamp={2}>
                                                        {media.title}
                                                    </Text>
                                                    <Text size="xs" c="dimmed">
                                                        {details.join(" · ")}
                                                    </Text>
                                                </Stack>

                                                {wasOpened && (
                                                    <Badge variant="light" color="gray">
                                                        Opened
                                                    </Badge>
                                                )}

                                                {view === "missing" ? (
                                                    <>
                                                        <AppButton
                                                            size="xs"
                                                            appVariant="ghost"
                                                            aria-label={`Ignore ${media.title}`}
                                                            onClick={() =>
                                                                void setIgnored(media, true)
                                                            }
                                                        >
                                                            Ignore
                                                        </AppButton>
                                                        <AppButton
                                                            size="xs"
                                                            appVariant={
                                                                wasOpened ? "ghost" : "primary"
                                                            }
                                                            disabled={importDisabledReason !== null}
                                                            aria-label={`Import ${media.title}`}
                                                            onClick={() => onImport(media)}
                                                        >
                                                            Import
                                                        </AppButton>
                                                    </>
                                                ) : (
                                                    <AppButton
                                                        size="xs"
                                                        aria-label={`Show ${media.title} again`}
                                                        onClick={() =>
                                                            void setIgnored(media, false)
                                                        }
                                                    >
                                                        Show again
                                                    </AppButton>
                                                )}
                                            </Group>
                                        );
                                    })}
                                </Stack>
                            </ScrollArea.Autosize>
                        )}

                        {viewed.length > 0 && filtered.length === 0 && (
                            <Text size="sm" c="dimmed">
                                Nothing here matches the search.
                            </Text>
                        )}

                        {viewed.length === 0 &&
                            (result.missing.length > 0 || result.ignored.length > 0) && (
                                <Text size="sm" c="dimmed">
                                    {view === "missing"
                                        ? "Everything else is ignored."
                                        : "Nothing is ignored."}
                                </Text>
                            )}

                        {!choosingBatch && filtered.length > shown && (
                            <Group justify="center">
                                <AppButton
                                    appVariant="ghost"
                                    size="xs"
                                    onClick={() => setShown((current) => current + PAGE_SIZE)}
                                >
                                    Show more ({formatNumber(filtered.length - shown)} left)
                                </AppButton>
                            </Group>
                        )}
                    </>
                )}
            </Stack>
        </Modal>
    );
}
