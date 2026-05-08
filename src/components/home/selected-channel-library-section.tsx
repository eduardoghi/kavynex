import { useMemo, useState } from "react";
import {
    ActionIcon,
    Avatar,
    Box,
    Group,
    Select,
    Stack,
    Text,
    TextInput,
    Title,
    Tooltip,
} from "@mantine/core";
import { ArrowDownAZ, ArrowLeft, ArrowUpAZ, Search, Video } from "lucide-react";
import { UI_TEXT } from "../../constants/ui-text";
import { MediaGrid } from "../library/media-grid";
import { fileSrcFromStoredPath, initials } from "../../utils/media-utils";
import type { Channel, MediaRow } from "../../types/media";
import { AppButton } from "../ui/app-button";

type MediaTypeFilter = "all" | "video" | "audio";
type WatchedFilter = "all" | "watched" | "unwatched";
type SortCategory = "video_date" | "added_date" | "title" | "duration" | "comments";
type SortDirection = "desc" | "asc";

type SelectedChannelLibrarySectionProps = {
    selectedChannel: Channel;
    itemCountLabel: string;
    disableAddMedia: boolean;
    isLoadingMedia: boolean;
    isVisible?: boolean;
    mediaItems: MediaRow[];
    activeMediaId?: number | null;
    libraryPath: string;
    shellBorder: string;
    shellSurface: string;
    onAddMedia: () => void;
    onBack: () => void;
    onOpenMedia: (media: MediaRow) => void;
    onRequestDeleteMedia: (media: MediaRow) => void;
    onMarkWatched?: (media: MediaRow) => void;
    onMarkUnwatched?: (media: MediaRow) => void;
    onOpenFileLocation?: (media: MediaRow) => void;
    onOpenSourceInYoutube?: (media: MediaRow) => void;
    onEditTitle?: (media: MediaRow) => void;
};

type MediaRowWithOptionalDates = MediaRow & {
    uploaded_at?: string | null;
    upload_date?: string | null;
    published_at?: string | null;
    source_uploaded_at?: string | null;
};

function normalizeText(value: string): string {
    return value
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .toLocaleLowerCase("pt-BR");
}

function parseDateValue(value: string | null | undefined): number {
    const normalized = value?.trim() ?? "";

    if (!normalized) {
        return 0;
    }

    const parsed = Date.parse(normalized.replace(" ", "T"));
    return Number.isFinite(parsed) ? parsed : 0;
}

function getCommentsCount(media: MediaRow): number {
    return Math.max(0, media.comments_count ?? 0);
}

function getDuration(media: MediaRow): number {
    return Math.max(0, media.duration_seconds ?? 0);
}

function getAddedDateValue(media: MediaRow): number {
    return parseDateValue(media.created_at);
}

function getVideoDateValue(media: MediaRow): number {
    const mediaWithOptionalDates = media as MediaRowWithOptionalDates;

    const videoDate = parseDateValue(
        mediaWithOptionalDates.uploaded_at ??
            mediaWithOptionalDates.upload_date ??
            mediaWithOptionalDates.published_at ??
            mediaWithOptionalDates.source_uploaded_at
    );

    if (videoDate > 0) {
        return videoDate;
    }

    return getAddedDateValue(media);
}

function compareText(left: string, right: string): number {
    return left.localeCompare(right, undefined, {
        sensitivity: "base",
        numeric: true,
    });
}

export function SelectedChannelLibrarySection({
    selectedChannel,
    itemCountLabel,
    disableAddMedia,
    isLoadingMedia,
    isVisible = true,
    mediaItems,
    activeMediaId = null,
    libraryPath,
    shellBorder,
    shellSurface,
    onAddMedia,
    onBack,
    onOpenMedia,
    onRequestDeleteMedia,
    onMarkWatched,
    onMarkUnwatched,
    onOpenFileLocation,
    onOpenSourceInYoutube,
    onEditTitle,
}: SelectedChannelLibrarySectionProps): JSX.Element {
    const avatarSrc = fileSrcFromStoredPath(selectedChannel.avatar_path, libraryPath);

    const [searchValue, setSearchValue] = useState("");
    const [mediaTypeFilter, setMediaTypeFilter] = useState<MediaTypeFilter>("all");
    const [watchedFilter, setWatchedFilter] = useState<WatchedFilter>("all");
    const [sortCategory, setSortCategory] = useState<SortCategory>("video_date");
    const [sortDirection, setSortDirection] = useState<SortDirection>("desc");

    const filteredItems = useMemo(() => {
        const searchTerm = normalizeText(searchValue);

        const nextItems = mediaItems.filter((media) => {
            if (mediaTypeFilter !== "all" && media.media_type !== mediaTypeFilter) {
                return false;
            }

            const isWatched = Boolean(media.watched_at?.trim());

            if (watchedFilter === "watched" && !isWatched) {
                return false;
            }

            if (watchedFilter === "unwatched" && isWatched) {
                return false;
            }

            if (searchTerm && !normalizeText(media.title).includes(searchTerm)) {
                return false;
            }

            return true;
        });

        nextItems.sort((left, right) => {
            let result = 0;

            if (sortCategory === "video_date") {
                result = getVideoDateValue(left) - getVideoDateValue(right);

                if (result === 0) {
                    result = compareText(left.title, right.title);
                }
            } else if (sortCategory === "added_date") {
                result = getAddedDateValue(left) - getAddedDateValue(right);

                if (result === 0) {
                    result = compareText(left.title, right.title);
                }
            } else if (sortCategory === "title") {
                result = compareText(left.title, right.title);
            } else if (sortCategory === "duration") {
                result = getDuration(left) - getDuration(right);

                if (result === 0) {
                    result = compareText(left.title, right.title);
                }
            } else if (sortCategory === "comments") {
                result = getCommentsCount(left) - getCommentsCount(right);

                if (result === 0) {
                    result = compareText(left.title, right.title);
                }
            }

            return sortDirection === "asc" ? result : result * -1;
        });

        return nextItems;
    }, [mediaItems, mediaTypeFilter, watchedFilter, searchValue, sortCategory, sortDirection]);

    const filteredCountLabel = `${UI_TEXT.library.showing} ${filteredItems.length} ${UI_TEXT.library.of} ${mediaItems.length} ${UI_TEXT.home.itemCountSuffix}`;

    return (
        <Stack gap="lg">
            <Group justify="space-between" align="center" wrap="wrap">
                <Group gap="md" wrap="nowrap">
                    <Avatar
                        size={58}
                        radius="xl"
                        src={avatarSrc || undefined}
                        color="violet"
                        style={{
                            border: `1px solid ${shellBorder}`,
                        }}
                    >
                        {!avatarSrc ? initials(selectedChannel.name) : null}
                    </Avatar>

                    <Box>
                        <Group gap="xs" align="center" wrap="wrap">
                            <Title order={2} fw={950}>
                                {selectedChannel.name}
                            </Title>
                        </Group>

                        <Text c="dimmed" size="sm">
                            {selectedChannel.youtube_handle} · {itemCountLabel}
                        </Text>
                    </Box>
                </Group>

                <Group gap="xs">
                    <AppButton
                        appVariant="primary"
                        leftSection={<Video size={18} />}
                        onClick={onAddMedia}
                        disabled={disableAddMedia}
                    >
                        {UI_TEXT.home.addMedia}
                    </AppButton>

                    <AppButton
                        appVariant="ghost"
                        leftSection={<ArrowLeft size={18} />}
                        onClick={onBack}
                        disabled={isLoadingMedia}
                    >
                        {UI_TEXT.home.back}
                    </AppButton>
                </Group>
            </Group>

            <Stack gap="sm">
                <Group align="end" wrap="wrap">
                    <TextInput
                        label={UI_TEXT.library.searchLabel}
                        placeholder={UI_TEXT.library.searchPlaceholder}
                        value={searchValue}
                        onChange={(event) => setSearchValue(event.currentTarget.value)}
                        leftSection={<Search size={16} />}
                        style={{ flex: 1, minWidth: 240 }}
                    />

                    <Select
                        label={UI_TEXT.library.typeLabel}
                        value={mediaTypeFilter}
                        onChange={(value) => setMediaTypeFilter((value as MediaTypeFilter) || "all")}
                        data={[
                            { value: "all", label: UI_TEXT.library.filters.all },
                            { value: "video", label: UI_TEXT.library.filters.video },
                            { value: "audio", label: UI_TEXT.library.filters.audio },
                        ]}
                        w={160}
                    />

                    <Select
                        label={UI_TEXT.library.statusLabel}
                        value={watchedFilter}
                        onChange={(value) => setWatchedFilter((value as WatchedFilter) || "all")}
                        data={[
                            { value: "all", label: UI_TEXT.library.filters.all },
                            { value: "watched", label: UI_TEXT.library.filters.watched },
                            { value: "unwatched", label: UI_TEXT.library.filters.unwatched },
                        ]}
                        w={180}
                    />

                    <Select
                        label={UI_TEXT.library.sortLabel}
                        value={sortCategory}
                        onChange={(value) => setSortCategory((value as SortCategory) || "video_date")}
                        data={[
                            { value: "video_date", label: "Video date" },
                            { value: "added_date", label: "Added date" },
                            { value: "title", label: UI_TEXT.library.sortOptions.title },
                            { value: "duration", label: UI_TEXT.library.sortOptions.duration },
                            { value: "comments", label: UI_TEXT.library.sortOptions.comments },
                        ]}
                        w={210}
                    />

                    <Tooltip label={sortDirection === "desc" ? "Descending" : "Ascending"}>
                        <ActionIcon
                            variant="light"
                            color="violet"
                            size="lg"
                            mt={24}
                            onClick={() =>
                                setSortDirection((current) => (current === "desc" ? "asc" : "desc"))
                            }
                            aria-label={
                                sortDirection === "desc" ? "Sort descending" : "Sort ascending"
                            }
                            style={{
                                border: "1px solid rgba(139,92,246,0.26)",
                                background: "rgba(124,92,255,0.13)",
                            }}
                        >
                            {sortDirection === "desc" ? (
                                <ArrowDownAZ size={18} />
                            ) : (
                                <ArrowUpAZ size={18} />
                            )}
                        </ActionIcon>
                    </Tooltip>
                </Group>

                <Text size="sm" c="dimmed">
                    {filteredCountLabel}
                </Text>
            </Stack>

            <MediaGrid
                items={filteredItems}
                activeMediaId={activeMediaId}
                libraryPath={libraryPath}
                shellBorder={shellBorder}
                shellSurface={shellSurface}
                loading={isLoadingMedia}
                isVisible={isVisible}
                emptyTitle={mediaItems.length === 0 ? UI_TEXT.library.emptyTitle : UI_TEXT.library.noResultsTitle}
                emptyDescription={
                    mediaItems.length === 0
                        ? UI_TEXT.library.emptyDescription
                        : UI_TEXT.library.noResultsDescription
                }
                onOpen={onOpenMedia}
                onRequestDelete={onRequestDeleteMedia}
                onMarkWatched={onMarkWatched}
                onMarkUnwatched={onMarkUnwatched}
                onOpenFileLocation={onOpenFileLocation}
                onOpenSourceInYoutube={onOpenSourceInYoutube}
                onEditTitle={onEditTitle}
            />
        </Stack>
    );
}