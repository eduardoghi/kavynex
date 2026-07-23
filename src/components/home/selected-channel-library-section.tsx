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
import type { MediaQueryFilters } from "../../utils/media-library-filters";
import { useChannelLibraryFilters } from "../../hooks/use-channel-library-filters";
import type { Channel, MediaRow } from "../../types/media";
import { toUnionValue } from "../../utils/guards";
import { AppButton } from "../ui/app-button";

// The per-card actions the grid exposes on each media row. Grouped into one object rather than
// passed as eight separate props (most of them optional callbacks) so the section's contract stays
// legible and a caller cannot silently drop one to `undefined` by mistyping its name - the whole
// object is required, and a missing field on it is a type error.
export type MediaCardActions = {
    onOpenMedia: (media: MediaRow) => void;
    onRequestDeleteMedia: (media: MediaRow) => void;
    onMarkWatched?: (media: MediaRow) => void;
    onMarkUnwatched?: (media: MediaRow) => void;
    // See MediaLibraryController.watchedActionInFlight - passed through to disable a card's own
    // watch/unwatch menu item while that row's toggle is in flight.
    watchedActionInFlight?: ReadonlySet<number>;
    onOpenFileLocation?: (media: MediaRow) => void;
    onOpenSourceInYoutube?: (media: MediaRow) => void;
    onEditTitle?: (media: MediaRow) => void;
};

type SelectedChannelLibrarySectionProps = {
    selectedChannel: Channel;
    itemCountLabel: string;
    disableAddMedia: boolean;
    isLoadingMedia: boolean;
    isVisible?: boolean;
    mediaItems: MediaRow[];
    // Rows matching the active filters across the whole channel (for "X of Y").
    total: number;
    // Rows in the channel with no filter applied (decides the empty-vs-no-results message).
    channelTotal: number;
    hasMore: boolean;
    isLoadingMore: boolean;
    onApplyQuery: (filters: MediaQueryFilters) => void;
    onLoadMore: () => void;
    activeMediaId?: number | null;
    focusMediaId?: number | null;
    onFocusMediaHandled?: () => void;
    libraryPath: string;
    shellBorder: string;
    shellSurface: string;
    onAddMedia: () => void;
    onBack: () => void;
    cardActions: MediaCardActions;
};

export function SelectedChannelLibrarySection({
    selectedChannel,
    itemCountLabel,
    disableAddMedia,
    isLoadingMedia,
    isVisible = true,
    mediaItems,
    total,
    channelTotal,
    hasMore,
    isLoadingMore,
    onApplyQuery,
    onLoadMore,
    activeMediaId = null,
    focusMediaId = null,
    onFocusMediaHandled,
    libraryPath,
    shellBorder,
    shellSurface,
    onAddMedia,
    onBack,
    cardActions,
}: SelectedChannelLibrarySectionProps): JSX.Element {
    const avatarSrc = fileSrcFromStoredPath(selectedChannel.avatar_path, libraryPath);

    // Filter/sort/search state and the backend query it drives live in a dedicated hook so this
    // component stays presentational; see use-channel-library-filters for the debounce and the
    // focus-jump reset behavior.
    const {
        searchValue,
        setSearchValue,
        mediaTypeFilter,
        setMediaTypeFilter,
        watchedFilter,
        setWatchedFilter,
        publicationDateFilter,
        setPublicationDateFilter,
        sortCategory,
        setSortCategory,
        sortDirection,
        setSortDirection,
    } = useChannelLibraryFilters({ focusMediaId, onApplyQuery });

    // "showing <loaded> of <total matching the filters>". With no filter active, total is the
    // whole channel; with a filter, it is the filtered match count.
    const filteredCountLabel = `${UI_TEXT.library.showing} ${mediaItems.length} ${UI_TEXT.library.of} ${total} ${UI_TEXT.home.itemCountSuffix}`;

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
                        onChange={(value) =>
                            setMediaTypeFilter(
                                toUnionValue(value, ["all", "video", "audio"] as const, "all")
                            )
                        }
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
                        onChange={(value) =>
                            setWatchedFilter(
                                toUnionValue(value, ["all", "watched", "unwatched"] as const, "all")
                            )
                        }
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
                            setPublicationDateFilter(
                                toUnionValue(value, ["all", "with", "without"] as const, "all")
                            )
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
                            setSortCategory(
                                toUnionValue(
                                    value,
                                    [
                                        "publication_date",
                                        "added_date",
                                        "title",
                                        "duration",
                                        "comments",
                                    ] as const,
                                    "publication_date"
                                )
                            )
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

                <Text size="sm" c="dimmed" aria-live="polite">
                    {filteredCountLabel}
                </Text>
            </Stack>

            <MediaGrid
                items={mediaItems}
                hasMore={hasMore}
                isLoadingMore={isLoadingMore}
                onLoadMore={onLoadMore}
                activeMediaId={activeMediaId}
                focusMediaId={focusMediaId}
                onFocusHandled={onFocusMediaHandled}
                libraryPath={libraryPath}
                shellBorder={shellBorder}
                shellSurface={shellSurface}
                loading={isLoadingMedia}
                isVisible={isVisible}
                emptyTitle={channelTotal === 0 ? UI_TEXT.library.emptyTitle : UI_TEXT.library.noResultsTitle}
                emptyDescription={
                    channelTotal === 0
                        ? UI_TEXT.library.emptyDescription
                        : UI_TEXT.library.noResultsDescription
                }
                onOpen={cardActions.onOpenMedia}
                onRequestDelete={cardActions.onRequestDeleteMedia}
                onMarkWatched={cardActions.onMarkWatched}
                onMarkUnwatched={cardActions.onMarkUnwatched}
                watchedActionInFlight={cardActions.watchedActionInFlight}
                onOpenFileLocation={cardActions.onOpenFileLocation}
                onOpenSourceInYoutube={cardActions.onOpenSourceInYoutube}
                onEditTitle={cardActions.onEditTitle}
            />
        </Stack>
    );
}
