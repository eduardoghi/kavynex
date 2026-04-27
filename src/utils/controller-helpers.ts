import type { Channel, MediaRow } from "../types/media";

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
    return `${items.length} item(s)`;
}

export function hasSelectedChannel(
    selectedChannel: Channel | null
): selectedChannel is Channel {
    return selectedChannel !== null;
}