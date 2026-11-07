import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useMediaLiveChat } from "./use-media-live-chat";
import {
    readLiveChatMessagesFromFile,
    type LiveChatMessageItem,
} from "../../services/live-chat-service";
import { createMedia } from "../../test/factories/media";

vi.mock("../../services/live-chat-service", () => ({
    readLiveChatMessagesFromFile: vi.fn(),
}));

vi.mock("../../utils/app-logger", () => ({
    logError: vi.fn(),
}));

import { logError } from "../../utils/app-logger";

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

        expect(readMock).toHaveBeenCalledWith(
            "live_chat/clip.live_chat.json.gz",
            expect.any(AbortSignal),
            expect.any(Function)
        );
        expect(result.current.liveChatMessages).toHaveLength(1);
        expect(result.current.error).toBeNull();
    });

    it("shows what has been read while the rest of the replay still loads", async () => {
        let finish: (rows: LiveChatMessageItem[]) => void = () => {};
        const first = { message_id: "m1", message_text: "hi" } as unknown as LiveChatMessageItem;
        readMock.mockImplementation((_path, _signal, onPartial) => {
            onPartial?.([first]);
            return new Promise((resolve) => {
                finish = resolve;
            });
        });

        const { result } = renderHook(() =>
            useMediaLiveChat(
                createMedia({
                    id: 8,
                    has_live_chat: 1,
                    live_chat_file_path: "live_chat/long.live_chat.json.gz",
                }),
                "/library"
            )
        );

        await waitFor(() => expect(result.current.liveChatMessages).toHaveLength(1));
        expect(result.current.isLoadingLiveChat).toBe(true);

        act(() => finish([first, first]));

        await waitFor(() => expect(result.current.isLoadingLiveChat).toBe(false));
        expect(result.current.liveChatMessages).toHaveLength(2);
    });

    it("does not read and stays empty without a live chat file", async () => {
        const { result } = renderHook(() =>
            useMediaLiveChat(createMedia({ id: 7, has_live_chat: 0 }), "/library")
        );

        await waitFor(() => expect(result.current.isLoadingLiveChat).toBe(false));

        expect(readMock).not.toHaveBeenCalled();
        expect(result.current.liveChatMessages).toEqual([]);
        expect(result.current.error).toBeNull();
    });

    it("surfaces an error (not an empty list) when the read fails", async () => {
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

        // The messages clear, but `error` is set so the panel can distinguish a failed read from a
        // media that genuinely has no live chat (rather than showing the empty state).
        expect(result.current.liveChatMessages).toEqual([]);
        expect(result.current.error).not.toBeNull();
    });

    it("abandons the read when the player closes, without reporting an error", async () => {
        let signal: AbortSignal | undefined;
        readMock.mockImplementation((_path, readSignal) => {
            signal = readSignal;
            return new Promise((_resolve, reject) => {
                readSignal?.addEventListener("abort", () =>
                    reject(new DOMException("abandoned", "AbortError"))
                );
            });
        });

        const { result, unmount } = renderHook(() =>
            useMediaLiveChat(
                createMedia({
                    id: 7,
                    has_live_chat: 1,
                    live_chat_file_path: "live_chat/clip.live_chat.json.gz",
                }),
                "/library"
            )
        );

        await waitFor(() => expect(result.current.isLoadingLiveChat).toBe(true));

        unmount();

        expect(signal?.aborted).toBe(true);
        expect(logError).not.toHaveBeenCalled();
    });
});
