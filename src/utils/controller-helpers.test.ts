import { describe, expect, it } from "vitest";
import type { Channel } from "../types/media";
import {
    findSelectedChannel,
    hasSelectedChannel,
} from "./controller-helpers";

function createChannel(overrides: Partial<Channel> = {}): Channel {
    return {
        id: 1,
        name: "Canal A",
        youtube_handle: "@canala",
        avatar_path: null,
        created_at: "2026-03-31T10:00:00.000Z",
        ...overrides,
    };
}

describe("controller-helpers", () => {
    it("finds selected channel", () => {
        expect(findSelectedChannel([createChannel()], 1)?.name).toBe("Canal A");
    });

    it("finds the channel matching the selected id among many", () => {
        const channels = [
            createChannel({ id: 1, name: "Canal A" }),
            createChannel({ id: 2, name: "Canal B" }),
        ];

        expect(findSelectedChannel(channels, 2)?.name).toBe("Canal B");
    });

    it("returns null when channel is not selected", () => {
        expect(findSelectedChannel([], null)).toBeNull();
        expect(findSelectedChannel([createChannel()], null)).toBeNull();
    });

    it("returns null when no channel matches the selected id", () => {
        expect(findSelectedChannel([createChannel({ id: 1 })], 99)).toBeNull();
    });

    it("checks selected channel existence", () => {
        expect(hasSelectedChannel(null)).toBe(false);
        expect(hasSelectedChannel(createChannel())).toBe(true);
    });
});