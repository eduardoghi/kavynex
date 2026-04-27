import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useHomeViewState } from "./use-home-view-state";

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
                isLoadingChannels: false,
                isPreparingSettings: false,
                mediaPlayer: {
                    viewMode: "library",
                },
            })
        );

        expect(result.current.showLoading).toBe(false);
        expect(result.current.showEmpty).toBe(false);
        expect(result.current.showLibrary).toBe(true);
        expect(result.current.showPlayer).toBe(false);
    });

    it("shows loading when settings are preparing", () => {
        const { result } = renderHook(() =>
            useHomeViewState({
                selectedChannel: null,
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

    it("shows empty state when there is no selected channel and nothing is loading", () => {
        const { result } = renderHook(() =>
            useHomeViewState({
                selectedChannel: null,
                isLoadingChannels: false,
                isPreparingSettings: false,
                mediaPlayer: {
                    viewMode: "library",
                },
            })
        );

        expect(result.current.showLoading).toBe(false);
        expect(result.current.showEmpty).toBe(true);
        expect(result.current.showLibrary).toBe(true);
        expect(result.current.showPlayer).toBe(false);
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
});