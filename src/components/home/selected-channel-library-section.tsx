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
import { useDebouncedValue } from "@mantine/hooks";
import { ArrowDownAZ, ArrowLeft, ArrowUpAZ, Search, Video } from "lucide-react";
import { UI_TEXT } from "../../constants/ui-text";
import { MediaGrid } from "../library/media-grid";
import { fileSrcFromStoredPath, initials } from "../../utils/media-utils";
import {
    filterAndSortMedia,
    type MediaTypeFilter,
    type PublicationDateFilter,
    type SortCategory,
    type SortDirection,
    type WatchedFilter,
} from "../../utils/media-library-filters";
import type { Channel, MediaRow } from "../../types/media";
import { AppButton } from "../ui/app-button";

// Debounce the search before it drives the (O(n log n) filter+sort) memo, so typing in a
// large library does not re-filter and re-sort on every keystroke. The input itself stays
// controlled and responsive.
const LIBRARY_SEARCH_DEBOUNCE_MS = 200;

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
    const [debouncedSearchValue] = useDebouncedValue(searchValue, LIBRARY_SEARCH_DEBOUNCE_MS);
    const [mediaTypeFilter, setMediaTypeFilter] = useState<MediaTypeFilter>("all");
    const [watchedFilter, setWatchedFilter] = useState<WatchedFilter>("all");
    const [publicationDateFilter, setPublicationDateFilter] =
        useState<PublicationDateFilter>("all");
    const [sortCategory, setSortCategory] = useState<SortCategory>("publication_date");
    const [sortDirection, setSortDirection] = useState<SortDirection>("desc");

    const filteredItems = useMemo(
        () =>
            filterAndSortMedia(mediaItems, {
                searchValue: debouncedSearchValue,
                mediaTypeFilter,
                watchedFilter,
                publicationDateFilter,
                sortCategory,
                sortDirection,
            }),
        [
            mediaItems,
            mediaTypeFilter,
            watchedFilter,
            publicationDateFilter,
            debouncedSearchValue,
            sortCategory,
            sortDirection,
        ]
    );

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
                        label={UI_TEXT.library.publicationDateLabel}
                        value={publicationDateFilter}
                        onChange={(value) =>
                            setPublicationDateFilter((value as PublicationDateFilter) || "all")
                        }
                        data={[
                            { value: "all", label: UI_TEXT.library.filters.all },
                            {
                                value: "with",
                                label: UI_TEXT.library.filters.withPublicationDate,
                            },
                            {
                                value: "without",
                                label: UI_TEXT.library.filters.withoutPublicationDate,
                            },
                        ]}
                        w={220}
                    />

                    <Select
                        label={UI_TEXT.library.sortLabel}
                        value={sortCategory}
                        onChange={(value) =>
                            setSortCategory((value as SortCategory) || "publication_date")
                        }
                        data={[
                            {
                                value: "publication_date",
                                label: UI_TEXT.library.sortOptions.publicationDate,
                            },
                            {
                                value: "added_date",
                                label: UI_TEXT.library.sortOptions.addedDate,
                            },
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
