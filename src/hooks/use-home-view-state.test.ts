import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Channel } from "../types/media";
import { useHomeViewState } from "./use-home-view-state";

function createChannel(overrides: Partial<Channel> = {}): Channel {
    return {
        id: 10,
        name: "Canal A",
        youtube_handle: "@canala",
        avatar_path: null,
        created_at: "2026-03-31T10:00:00.000Z",
        ...overrides,
    };
}

describe("useHomeViewState", () => {
    it("shows library when a channel is selected and player is not active", () => {
        const { result } = renderHook(() =>
            useHomeViewState({
                selectedChannel: {
                    id: 10,
                    name: "Canal A",
                    youtube_handle: "@canala",
                    avatar_path: null,
                    created_at: "2026-03-31T10:00:00.000Z",
                },
                hasChannels: true,
                isLoadingChannels: false,
                isPreparingSettings: false,
                mediaPlayer: {
                    viewMode: "library",
                },
            })
        );

        expect(result.current.showLoading).toBe(false);
        expect(result.current.showEmpty).toBe(false);
        expect(result.current.showSelectChannelPrompt).toBe(false);
        expect(result.current.showLibrary).toBe(true);
        expect(result.current.showPlayer).toBe(false);
    });

    it("shows loading when settings are preparing", () => {
        const { result } = renderHook(() =>
            useHomeViewState({
                selectedChannel: null,
                hasChannels: false,
                isLoadingChannels: false,
                isPreparingSettings: true,
                mediaPlayer: {
                    viewMode: "library",
                },
            })
        );

        expect(result.current.showLoading).toBe(true);
        expect(result.current.showEmpty).toBe(false);
        expect(result.current.showLibrary).toBe(true);
        expect(result.current.showPlayer).toBe(false);
    });

    it("shows empty state when there are no channels and nothing is loading", () => {
        const { result } = renderHook(() =>
            useHomeViewState({
                selectedChannel: null,
                hasChannels: false,
                isLoadingChannels: false,
                isPreparingSettings: false,
                mediaPlayer: {
                    viewMode: "library",
                },
            })
        );

        expect(result.current.showLoading).toBe(false);
        expect(result.current.showEmpty).toBe(true);
        expect(result.current.showSelectChannelPrompt).toBe(false);
        expect(result.current.showLibrary).toBe(true);
        expect(result.current.showPlayer).toBe(false);
    });

    it("shows the select-channel prompt instead of the empty state when channels exist but none is selected", () => {
        const { result } = renderHook(() =>
            useHomeViewState({
                selectedChannel: null,
                hasChannels: true,
                isLoadingChannels: false,
                isPreparingSettings: false,
                mediaPlayer: {
                    viewMode: "library",
                },
            })
        );

        expect(result.current.showEmpty).toBe(false);
        expect(result.current.showSelectChannelPrompt).toBe(true);
        expect(result.current.showLibrary).toBe(true);
        expect(result.current.showPlayer).toBe(false);
    });

    it("shows neither the empty state nor the select-channel prompt once a channel is selected", () => {
        const { result } = renderHook(() =>
            useHomeViewState({
                selectedChannel: createChannel(),
                hasChannels: true,
                isLoadingChannels: false,
                isPreparingSettings: false,
                mediaPlayer: {
                    viewMode: "library",
                },
            })
        );

        expect(result.current.showEmpty).toBe(false);
        expect(result.current.showSelectChannelPrompt).toBe(false);
    });

    it("shows player when player mode is active", () => {
        const { result } = renderHook(() =>
            useHomeViewState({
                selectedChannel: {
                    id: 10,
                    name: "Canal A",
                    youtube_handle: "@canala",
                    avatar_path: null,
                    created_at: "2026-03-31T10:00:00.000Z",
                },
                hasChannels: true,
                isLoadingChannels: false,
                isPreparingSettings: false,
                mediaPlayer: {
                    viewMode: "player",
                },
            })
        );

        expect(result.current.showLoading).toBe(false);
        expect(result.current.showEmpty).toBe(false);
        expect(result.current.showLibrary).toBe(false);
        expect(result.current.showPlayer).toBe(true);
    });

    it("returns non-empty theme tokens", () => {
        const { result } = renderHook(() =>
            useHomeViewState({
                selectedChannel: {
                    id: 10,
                    name: "Canal A",
                    youtube_handle: "@canala",
                    avatar_path: null,
                    created_at: "2026-03-31T10:00:00.000Z",
                },
                hasChannels: true,
                isLoadingChannels: false,
                isPreparingSettings: false,
                mediaPlayer: {
                    viewMode: "library",
                },
            })
        );

        expect(result.current.shellSurface).toBeTruthy();
        expect(result.current.shellBorder).toBeTruthy();
    });

    it("returns the exact page background color", () => {
        const { result } = renderHook(() =>
            useHomeViewState({
                selectedChannel: createChannel(),
                hasChannels: true,
                isLoadingChannels: false,
                isPreparingSettings: false,
                mediaPlayer: {
                    viewMode: "library",
                },
            })
        );

        expect(result.current.pageBackground).toBe("#070A12");
    });

    it("shows loading when there is no selected channel and channels are loading, even when settings are not preparing", () => {
        const { result } = renderHook(() =>
            useHomeViewState({
                selectedChannel: null,
                hasChannels: false,
                isLoadingChannels: true,
                isPreparingSettings: false,
                mediaPlayer: {
                    viewMode: "library",
                },
            })
        );

        expect(result.current.showLoading).toBe(true);
    });

    it("does not show loading for a selected channel even while channels are loading", () => {
        const { result } = renderHook(() =>
            useHomeViewState({
                selectedChannel: createChannel(),
                hasChannels: true,
                isLoadingChannels: true,
                isPreparingSettings: false,
                mediaPlayer: {
                    viewMode: "library",
                },
            })
        );

        expect(result.current.showLoading).toBe(false);
    });

    it("does not show the empty state when the player is active", () => {
        const { result } = renderHook(() =>
            useHomeViewState({
                selectedChannel: null,
                hasChannels: false,
                isLoadingChannels: false,
                isPreparingSettings: false,
                mediaPlayer: {
                    viewMode: "player",
                },
            })
        );

        expect(result.current.showEmpty).toBe(false);
    });

    it("recomputes the view state after a rerender when the view mode changes", () => {
        const initialProps: Parameters<typeof useHomeViewState>[0] = {
            selectedChannel: createChannel(),
            hasChannels: true,
            isLoadingChannels: false,
            isPreparingSettings: false,
            mediaPlayer: {
                viewMode: "library",
            },
        };

        const { result, rerender } = renderHook(
            (props: Parameters<typeof useHomeViewState>[0]) => useHomeViewState(props),
            { initialProps }
        );

        expect(result.current.showLibrary).toBe(true);
        expect(result.current.showPlayer).toBe(false);

        rerender({
            selectedChannel: createChannel(),
            hasChannels: true,
            isLoadingChannels: false,
            isPreparingSettings: false,
            mediaPlayer: {
                viewMode: "player",
            },
        });

        expect(result.current.showLibrary).toBe(false);
        expect(result.current.showPlayer).toBe(true);
    });
});
