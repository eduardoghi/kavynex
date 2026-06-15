import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as dbModule from "../lib/db";
import { createTestDb } from "../test/helpers/create-test-db";
import {
    countChannelsUsingAvatarPathOutsideChannel,
    countMediaUsingFilePathOutsideChannel,
    countMediaUsingThumbnailOutsideChannel,
    deleteChannelById,
    findChannelByYoutubeHandle,
    getChannelAvatarPathByChannelId,
    getChannelById,
    insertChannel,
    listChannels,
    listDistinctFilePathsByChannelId,
    listDistinctThumbnailPathsByChannelId,
    updateChannelAvatarPath,
    updateChannelNameAndHandle,
} from "./channel-repository";
import { insertMedia, listMediaIntegrityReferences } from "./media-repository";

vi.mock("../lib/db");

let closeDb: () => void;

beforeEach(() => {
    const { db, close } = createTestDb();
    closeDb = close;
    vi.mocked(dbModule.getDb).mockResolvedValue(db as any);
});

afterEach(() => {
    closeDb();
});

async function seedChannel(name: string, handle: string, avatar: string | null = null) {
    return (await insertChannel(name, handle, avatar))!;
}

async function seedMedia(channelId: number, filePath: string, thumbPath: string | null = null) {
    return insertMedia(channelId, "Test video", filePath, thumbPath, "video", null, null, null, false, null);
}

describe("insertChannel", () => {
    it("returns a positive numeric id", async () => {
        const id = await insertChannel("Alice", "@alice", null);
        expect(typeof id).toBe("number");
        expect(id).toBeGreaterThan(0);
    });
});

describe("getChannelById", () => {
    it("returns all fields for the channel", async () => {
        const id = await seedChannel("Alice", "@alice", "thumbnails/alice.jpg");
        const channel = await getChannelById(id);
        expect(channel).toMatchObject({
            id,
            name: "Alice",
            youtube_handle: "@alice",
            avatar_path: "thumbnails/alice.jpg",
        });
        expect(typeof channel!.created_at).toBe("string");
    });

    it("stores null avatar_path", async () => {
        const id = await seedChannel("Alice", "@alice");
        const channel = await getChannelById(id);
        expect(channel!.avatar_path).toBeNull();
    });

    it("returns null for unknown id", async () => {
        expect(await getChannelById(999)).toBeNull();
    });
});

describe("listChannels", () => {
    it("returns channels ordered by name asc", async () => {
        await seedChannel("Zebra", "@zebra");
        await seedChannel("Alpha", "@alpha");
        await seedChannel("Mango", "@mango");
        const channels = await listChannels();
        expect(channels.map((c) => c.name)).toEqual(["Alpha", "Mango", "Zebra"]);
    });

    it("returns empty array when no channels exist", async () => {
        expect(await listChannels()).toEqual([]);
    });
});

describe("findChannelByYoutubeHandle", () => {
    it("finds an existing channel by handle", async () => {
        await seedChannel("Alice", "@alice");
        const channel = await findChannelByYoutubeHandle("@alice");
        expect(channel?.name).toBe("Alice");
    });

    it("returns null for a missing handle", async () => {
        expect(await findChannelByYoutubeHandle("@nobody")).toBeNull();
    });
});

describe("updateChannelNameAndHandle", () => {
    it("updates both name and handle", async () => {
        const id = await seedChannel("Old", "@old");
        await updateChannelNameAndHandle(id, "New", "@new");
        const channel = await getChannelById(id);
        expect(channel).toMatchObject({ name: "New", youtube_handle: "@new" });
    });
});

describe("updateChannelAvatarPath", () => {
    it("sets a new avatar path", async () => {
        const id = await seedChannel("Alice", "@alice");
        await updateChannelAvatarPath(id, "thumbnails/avatar.jpg");
        expect((await getChannelById(id))!.avatar_path).toBe("thumbnails/avatar.jpg");
    });

    it("clears the avatar path to null", async () => {
        const id = await seedChannel("Alice", "@alice", "thumbnails/avatar.jpg");
        await updateChannelAvatarPath(id, null);
        expect((await getChannelById(id))!.avatar_path).toBeNull();
    });
});

describe("deleteChannelById", () => {
    it("removes the channel row", async () => {
        const id = await seedChannel("Alice", "@alice");
        await deleteChannelById(id);
        expect(await getChannelById(id)).toBeNull();
    });

    it("cascades deletion to media rows", async () => {
        const id = await seedChannel("Alice", "@alice");
        await seedMedia(id, "video/a.mp4");
        await deleteChannelById(id);
        expect(await listMediaIntegrityReferences()).toHaveLength(0);
    });
});

describe("getChannelAvatarPathByChannelId", () => {
    it("returns the stored avatar path", async () => {
        const id = await seedChannel("Alice", "@alice", "thumbnails/alice.jpg");
        expect(await getChannelAvatarPathByChannelId(id)).toBe("thumbnails/alice.jpg");
    });

    it("returns null when avatar_path is null", async () => {
        const id = await seedChannel("Alice", "@alice");
        expect(await getChannelAvatarPathByChannelId(id)).toBeNull();
    });

    it("returns null when channel does not exist", async () => {
        expect(await getChannelAvatarPathByChannelId(999)).toBeNull();
    });
});

describe("countChannelsUsingAvatarPathOutsideChannel", () => {
    it("counts other channels sharing the same avatar path", async () => {
        const id1 = await seedChannel("A", "@a", "shared.jpg");
        const id2 = await seedChannel("B", "@b", "shared.jpg");
        expect(await countChannelsUsingAvatarPathOutsideChannel("shared.jpg", id1)).toBe(1);
        expect(await countChannelsUsingAvatarPathOutsideChannel("shared.jpg", id2)).toBe(1);
    });

    it("returns 0 when only the given channel uses the path", async () => {
        const id = await seedChannel("A", "@a", "unique.jpg");
        expect(await countChannelsUsingAvatarPathOutsideChannel("unique.jpg", id)).toBe(0);
    });
});

describe("countMediaUsingThumbnailOutsideChannel", () => {
    it("counts media in other channels with the same thumbnail", async () => {
        const id1 = await seedChannel("A", "@a");
        const id2 = await seedChannel("B", "@b");
        await seedMedia(id1, "video/a.mp4", "thumb/shared.jpg");
        await seedMedia(id2, "video/b.mp4", "thumb/shared.jpg");
        expect(await countMediaUsingThumbnailOutsideChannel("thumb/shared.jpg", id1)).toBe(1);
    });

    it("returns 0 when no other channel uses the thumbnail", async () => {
        const id = await seedChannel("A", "@a");
        await seedMedia(id, "video/a.mp4", "thumb/unique.jpg");
        expect(await countMediaUsingThumbnailOutsideChannel("thumb/unique.jpg", id)).toBe(0);
    });
});

describe("countMediaUsingFilePathOutsideChannel", () => {
    it("counts media in other channels with the same file path", async () => {
        const id1 = await seedChannel("A", "@a");
        const id2 = await seedChannel("B", "@b");
        await seedMedia(id1, "video/shared.mp4");
        await seedMedia(id2, "video/shared.mp4");
        expect(await countMediaUsingFilePathOutsideChannel("video/shared.mp4", id1)).toBe(1);
    });

    it("returns 0 when no other channel uses the file path", async () => {
        const id = await seedChannel("A", "@a");
        await seedMedia(id, "video/unique.mp4");
        expect(await countMediaUsingFilePathOutsideChannel("video/unique.mp4", id)).toBe(0);
    });
});

describe("listDistinctThumbnailPathsByChannelId", () => {
    it("returns distinct non-null thumbnail paths for the channel", async () => {
        const id = await seedChannel("A", "@a");
        await seedMedia(id, "video/a.mp4", "thumb/t.jpg");
        await seedMedia(id, "video/b.mp4", "thumb/t.jpg");
        await seedMedia(id, "video/c.mp4", "thumb/u.jpg");
        const paths = await listDistinctThumbnailPathsByChannelId(id);
        expect(paths.sort()).toEqual(["thumb/t.jpg", "thumb/u.jpg"]);
    });

    it("excludes null thumbnail paths", async () => {
        const id = await seedChannel("A", "@a");
        await seedMedia(id, "video/a.mp4", null);
        expect(await listDistinctThumbnailPathsByChannelId(id)).toEqual([]);
    });

    it("excludes media from other channels", async () => {
        const id1 = await seedChannel("A", "@a");
        const id2 = await seedChannel("B", "@b");
        await seedMedia(id2, "video/b.mp4", "thumb/other.jpg");
        expect(await listDistinctThumbnailPathsByChannelId(id1)).toEqual([]);
    });
});

describe("listDistinctFilePathsByChannelId", () => {
    it("returns distinct file paths for the channel", async () => {
        const id1 = await seedChannel("A", "@a");
        const id2 = await seedChannel("B", "@b");
        await seedMedia(id1, "video/a.mp4");
        await seedMedia(id1, "video/b.mp4");
        await seedMedia(id2, "video/c.mp4");
        const paths = await listDistinctFilePathsByChannelId(id1);
        expect(paths.sort()).toEqual(["video/a.mp4", "video/b.mp4"]);
    });

    it("returns empty array when channel has no media", async () => {
        const id = await seedChannel("A", "@a");
        expect(await listDistinctFilePathsByChannelId(id)).toEqual([]);
    });
});
