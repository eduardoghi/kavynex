import type { Channel, MediaRow } from "../types/media";
import { formatCount } from "./pluralize";

export function findSelectedChannel(
    channels: Channel[],
    selectedChannelId: number | null
): Channel | null {
    if (selectedChannelId === null) {
        return null;
    }

    return channels.find((channel) => channel.id === selectedChannelId) ?? null;
}

export function buildItemCountLabel(items: MediaRow[]): string {
    return formatCount(items.length, "item");
}

// Same label built from a count rather than an array, for the paginated library where the full
// media list is never held in memory (only the loaded pages) but the channel total is known.
export function buildItemCountLabelFromCount(count: number): string {
    return formatCount(count, "item");
}

export function hasSelectedChannel(
    selectedChannel: Channel | null
): selectedChannel is Channel {
    return selectedChannel !== null;
}