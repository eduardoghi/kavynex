import { Checkbox, Group, Loader, Paper, ScrollArea, Select, Stack, Text } from "@mantine/core";
import type { ChannelMediaOnYoutube } from "../../types/generated/ChannelMediaOnYoutube";
import {
    BATCH_PAUSE_MS,
    type BatchImportItem,
    type BatchImportOptions,
} from "../../hooks/use-batch-import";
import type { BatchImportOptionsController } from "../../hooks/use-batch-import-options";
import { useBatchFormats, type BatchQuality } from "../../hooks/use-batch-formats";
import { formatBytes } from "../../utils/media-utils";
import { formatNumber } from "../../utils/number-format";
import { toUnionValue } from "../../utils/guards";
import { AppButton } from "../ui/app-button";
import { CookiesFields } from "./add-media-sections/cookies-fields";

const QUALITY_OPTIONS: { value: BatchQuality; label: string }[] = [
    { value: "best", label: "Best available" },
    { value: "1080", label: "Up to 1080p" },
    { value: "720", label: "Up to 720p" },
    { value: "480", label: "Up to 480p" },
    { value: "360", label: "Up to 360p" },
    { value: "audio", label: "Audio only" },
];

const QUALITY_VALUES = QUALITY_OPTIONS.map((option) => option.value);

type BatchImportSetupPanelProps = {
    // The media picked for the batch, in the list's order.
    media: ChannelMediaOnYoutube[];
    options: BatchImportOptionsController;
    onBack: () => void;
    onStart: (items: BatchImportItem[], options: BatchImportOptions) => void;
};

// Sets a batch import up. The sign-in first, since it decides which formats YouTube offers, then
// the formats of each media, listed one at a time and chosen one by one, as in the add-media form.
export function BatchImportSetupPanel({
    media,
    options,
    onBack,
    onStart,
}: BatchImportSetupPanelProps): JSX.Element {
    // Owned here, so closing the panel stops a listing and forgets what it found.
    const formats = useBatchFormats();
    const { entries, isLoading } = formats;
    const hasListed = entries.size > 0;

    const ready = media.filter((item) => {
        const entry = entries.get(item.youtube_video_id);
        return entry?.status === "loaded" && entry.selectedFormatId !== "";
    });
    const settled = media.filter((item) => {
        const status = entries.get(item.youtube_video_id)?.status;
        return status === "loaded" || status === "failed";
    }).length;
    const failed = media.filter(
        (item) => entries.get(item.youtube_video_id)?.status === "failed"
    ).length;

    // A different sign-in offers different formats, so what was listed under the old one goes.
    const changeCookies = (apply: () => void): void => {
        apply();
        formats.reset();
    };

    const loadFormats = (): void => {
        const resolved = options.resolve();

        if (resolved) {
            void formats.loadAll(
                media.map((item) => ({ youtubeVideoId: item.youtube_video_id, title: item.title })),
                resolved,
                options.quality
            );
        }
    };

    const start = (): void => {
        const resolved = options.resolve();

        if (!resolved) {
            return;
        }

        onStart(
            ready.map((item) => {
                const entry = entries.get(item.youtube_video_id)!;

                return {
                    youtubeVideoId: item.youtube_video_id,
                    title: entry.title ?? item.title,
                    formatId: entry.selectedFormatId,
                };
            }),
            resolved
        );
    };

    return (
        <Paper withBorder p="sm" radius="md">
            <Stack gap="xs">
                <Text size="sm" fw={600}>
                    Import {formatNumber(media.length)} media
                </Text>
                <Text size="xs" c="dimmed">
                    Choose how to sign in, load the formats and pick one for each media. They are
                    downloaded one at a time, {BATCH_PAUSE_MS / 1000} seconds apart, and a media
                    that fails is reported while the rest go on.
                </Text>

                <CookiesFields
                    cookiesBrowser={options.cookiesBrowser}
                    cookiesBrowserProfile={options.cookiesBrowserProfile}
                    cookiesPath={options.cookiesPath}
                    isLocked={isLoading}
                    onChangeCookiesBrowser={(value) =>
                        changeCookies(() => options.setCookiesBrowser(value))
                    }
                    onChangeCookiesBrowserProfile={(value) =>
                        changeCookies(() => options.setCookiesBrowserProfile(value))
                    }
                    onPickCookiesFile={() =>
                        changeCookies(() => void options.pickCookiesFile())
                    }
                    onClearCookiesPath={() => changeCookies(options.clearCookiesPath)}
                />

                <Checkbox
                    label="Save the comments"
                    checked={options.downloadComments}
                    onChange={(event) => options.setDownloadComments(event.currentTarget.checked)}
                />
                <Checkbox
                    label="Save the live chat"
                    checked={options.downloadLiveChat}
                    onChange={(event) => options.setDownloadLiveChat(event.currentTarget.checked)}
                />

                {options.error && (
                    <Text size="xs" c="red" role="alert">
                        {options.error}
                    </Text>
                )}

                {!hasListed ? (
                    <Group justify="flex-end">
                        <AppButton size="xs" onClick={loadFormats}>
                            Load formats
                        </AppButton>
                    </Group>
                ) : (
                    <>
                        <Group justify="space-between" align="end">
                            <Select
                                label="Pre-select all"
                                value={options.quality}
                                onChange={(value) => {
                                    const quality = toUnionValue(value, QUALITY_VALUES, "best");
                                    options.setQuality(quality);
                                    formats.preselectAll(quality);
                                }}
                                data={QUALITY_OPTIONS}
                                allowDeselect={false}
                                description="Picks for every media at once. Each can still be changed below."
                                style={{ flex: 1 }}
                            />
                        </Group>

                        {isLoading && (
                            <Group gap="xs" role="status">
                                <Loader size="xs" />
                                <Text size="xs">
                                    {`Loading formats ${formatNumber(
                                        Math.min(settled + 1, media.length)
                                    )} of ${formatNumber(media.length)}`}
                                </Text>
                            </Group>
                        )}

                        <ScrollArea.Autosize mah="45vh" offsetScrollbars>
                            <Stack
                                gap="sm"
                                component="ul"
                                style={{ listStyle: "none", padding: 0, margin: 0 }}
                            >
                                {media.map((item) => {
                                    const entry = entries.get(item.youtube_video_id);
                                    const title = entry?.title ?? item.title;

                                    return (
                                        <Stack key={item.youtube_video_id} component="li" gap={4}>
                                            <Text size="sm" fw={600} lineClamp={1}>
                                                {title}
                                            </Text>

                                            {entry?.status === "loaded" && (
                                                <Select
                                                    aria-label={`Format for ${title}`}
                                                    value={entry.selectedFormatId || null}
                                                    onChange={(value) =>
                                                        formats.selectFormat(
                                                            item.youtube_video_id,
                                                            value ?? ""
                                                        )
                                                    }
                                                    data={entry.formats.map((format) => ({
                                                        value: format.format_id,
                                                        label:
                                                            format.filesize_bytes != null
                                                                ? `${format.display_name} · ${formatBytes(format.filesize_bytes)}`
                                                                : format.display_name,
                                                    }))}
                                                    allowDeselect={false}
                                                    size="xs"
                                                />
                                            )}

                                            {entry?.status === "failed" && (
                                                <Group gap="xs" wrap="nowrap">
                                                    <Text size="xs" c="red" style={{ flex: 1 }}>
                                                        {entry.error}
                                                    </Text>
                                                    <AppButton
                                                        size="xs"
                                                        appVariant="ghost"
                                                        disabled={isLoading}
                                                        aria-label={`Load the formats of ${title} again`}
                                                        onClick={() => {
                                                            const resolved = options.resolve();

                                                            if (resolved) {
                                                                void formats.retry(
                                                                    {
                                                                        youtubeVideoId:
                                                                            item.youtube_video_id,
                                                                        title: item.title,
                                                                    },
                                                                    resolved,
                                                                    options.quality
                                                                );
                                                            }
                                                        }}
                                                    >
                                                        Try again
                                                    </AppButton>
                                                </Group>
                                            )}

                                            {(entry === undefined ||
                                                entry.status === "waiting" ||
                                                entry.status === "loading") && (
                                                <Text size="xs" c="dimmed">
                                                    {entry?.status === "loading"
                                                        ? "Loading formats..."
                                                        : "Waiting"}
                                                </Text>
                                            )}
                                        </Stack>
                                    );
                                })}
                            </Stack>
                        </ScrollArea.Autosize>

                        {!isLoading && failed > 0 && (
                            <Text size="xs" c="dimmed">
                                {formatNumber(failed)} without formats will be left out.
                            </Text>
                        )}
                    </>
                )}

                <Group justify="flex-end" gap="xs">
                    <AppButton appVariant="ghost" size="xs" onClick={onBack}>
                        Back
                    </AppButton>
                    {hasListed && (
                        <AppButton
                            size="xs"
                            disabled={isLoading || ready.length === 0}
                            onClick={start}
                        >
                            Start ({formatNumber(ready.length)})
                        </AppButton>
                    )}
                </Group>
            </Stack>
        </Paper>
    );
}
