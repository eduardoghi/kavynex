import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useMediaLiveChat } from "./use-media-live-chat";
import {
    readLiveChatMessagesFromFile,
    type LiveChatMessageItem,
} from "../services/live-chat-service";
import { createMedia } from "../test/factories/media";

vi.mock("../services/live-chat-service", () => ({
    readLiveChatMessagesFromFile: vi.fn(),
}));

const readMock = vi.mocked(readLiveChatMessagesFromFile);

describe("useMediaLiveChat", () => {
    beforeEach(() => {
        readMock.mockReset();
    });

    it("reads the replay for a media that has live chat", async () => {
        readMock.mockResolvedValue([
            { message_id: "m1", message_text: "hi" } as unknown as LiveChatMessageItem,
        ]);

        const { result } = renderHook(() =>
            useMediaLiveChat(
                createMedia({
                    id: 7,
                    has_live_chat: 1,
                    live_chat_file_path: "live_chat/clip.live_chat.json.gz",
                }),
                "/library"
            )
        );

        await waitFor(() => expect(result.current.isLoadingLiveChat).toBe(false));

        expect(readMock).toHaveBeenCalledWith("live_chat/clip.live_chat.json.gz");
        expect(result.current.liveChatMessages).toHaveLength(1);
    });

    it("does not read and stays empty without a live chat file", async () => {
        const { result } = renderHook(() =>
            useMediaLiveChat(createMedia({ id: 7, has_live_chat: 0 }), "/library")
        );

        await waitFor(() => expect(result.current.isLoadingLiveChat).toBe(false));

        expect(readMock).not.toHaveBeenCalled();
        expect(result.current.liveChatMessages).toEqual([]);
    });

    it("clears messages and does not throw when the read fails", async () => {
        readMock.mockRejectedValue(new Error("boom"));

        const { result } = renderHook(() =>
            useMediaLiveChat(
                createMedia({
                    id: 7,
                    has_live_chat: 1,
                    live_chat_file_path: "live_chat/clip.live_chat.json.gz",
                }),
                "/library"
            )
        );

        await waitFor(() => expect(result.current.isLoadingLiveChat).toBe(false));

        expect(result.current.liveChatMessages).toEqual([]);
    });
});
