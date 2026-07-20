import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { useHomeMediaActions } from "./use-home-media-actions";

describe("useHomeMediaActions", () => {
    function createDiagnosticsState(overrides?: Partial<any>) {
        return {
            diagnosticsOpen: false,
            setDiagnosticsOpen: vi.fn(),
            diagnosticsSummary: null,
            isLoadingDiagnostics: false,
            openDiagnostics: vi.fn(),
            closeDiagnostics: vi.fn(),
            reloadDiagnostics: vi.fn().mockResolvedValue(undefined),
            ...overrides,
        };
    }

    function createMediaLibrary(overrides?: Partial<any>) {
        return {
            mediaItems: [],

            addMediaOpen: false,
            setAddMediaOpen: vi.fn(),
            closeAddMediaModal: vi.fn(),

            confirmDeleteMediaOpen: false,
            mediaToDelete: null,

            isLoadingMedia: false,
            isAddingMedia: false,
            isDeletingMedia: false,
            commentsInFlight: new Set<number>(),
            watchedActionInFlight: new Set<number>(),
            isUpdatingTitle: false,
            isCancellingYtDlp: false,

            ytDlpLogs: [],
            isYtDlpRunning: false,

            addMediaForm: {
                sourceMode: "local" as const,
                mediaUrl: "",
                title: "",
                mediaPath: "",
                mediaType: "video" as const,
                thumbPath: "",
                publishedAt: "",
                downloadComments: true,
                downloadLiveChat: true,
                cookiesBrowser: "",
                cookiesPath: "",
                isGeneratingThumb: false,

                ytDlpFormats: [],
                selectedYtDlpFormatId: "",
                isLoadingYtDlpFormats: false,
                selectedYtDlpMediaType: "video" as const,

                setSourceMode: vi.fn(),
                setMediaUrl: vi.fn(),
                setTitle: vi.fn(),
                setPublishedAt: vi.fn(),
                setDownloadComments: vi.fn(),
                setDownloadLiveChat: vi.fn(),
                setCookiesBrowser: vi.fn(),
                setCookiesPath: vi.fn(),
                pickCookiesFileViaDialog: vi.fn(),
                clearCookiesPath: vi.fn(),
                setSelectedYtDlpFormatId: vi.fn(),
                loadYtDlpFormats: vi.fn(),

                pickMediaViaDialog: vi.fn(),
                pickThumbViaDialog: vi.fn(),
                resetForm: vi.fn(),
            },

            mediaPlayer: {
                viewMode: "library" as const,
                activeMedia: null,
                activeIsAudio: false,
                activeSrc: "",
                activeThumbSrc: "",
                activeYoutubeUrl: "",
                canOpenInYoutube: false,
                activeIsWatched: false,
                openPlayer: vi.fn(),
                setActiveMedia: vi.fn(),
                closePlayer: vi.fn(),
                openInYoutube: vi.fn(),
            },

            applyMediaQuery: vi.fn().mockResolvedValue(undefined),
            loadMoreMedia: vi.fn().mockResolvedValue(undefined),
            reloadMedia: vi.fn().mockResolvedValue(undefined),
            mediaTotal: 0,
            channelMediaTotal: 0,
            hasMoreMedia: false,
            isLoadingMoreMedia: false,
            addMedia: vi.fn().mockResolvedValue(undefined),
            cancelYtDlpDownload: vi.fn(),

            markAsWatched: vi.fn().mockResolvedValue(undefined),
            markAsUnwatched: vi.fn().mockResolvedValue(undefined),
            refreshComments: vi.fn().mockResolvedValue(undefined),
            cancelRefreshComments: vi.fn().mockResolvedValue(undefined),
            editTitle: vi.fn().mockResolvedValue(undefined),
            openMediaFileLocation: vi.fn().mockResolvedValue(undefined),
            openMediaSourceInYoutube: vi.fn().mockResolvedValue(undefined),
            saveMediaProgress: vi.fn().mockResolvedValue(undefined),

            requestDeleteMedia: vi.fn(),
            confirmDeleteMedia: vi.fn().mockResolvedValue(undefined),
            closeDeleteMediaModal: vi.fn(),

            clearMediaAndPlayer: vi.fn(),

            ...overrides,
        };
    }

    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("adds media without reloading diagnostics when diagnostics is closed", async () => {
        const diagnosticsState = createDiagnosticsState({
            diagnosticsOpen: false,
        });
        const mediaLibrary = createMediaLibrary();

        const { result } = renderHook(() =>
            useHomeMediaActions({
                diagnosticsState,
                mediaLibrary,
                confirmDeleteChannelFlow: vi.fn().mockResolvedValue(undefined),
            })
        );

        await act(async () => {
            await result.current.addMedia();
        });

        expect(mediaLibrary.addMedia).toHaveBeenCalledTimes(1);
        expect(diagnosticsState.reloadDiagnostics).not.toHaveBeenCalled();
    });

    it("reloads diagnostics after adding media when diagnostics is open", async () => {
        const diagnosticsState = createDiagnosticsState({
            diagnosticsOpen: true,
        });
        const mediaLibrary = createMediaLibrary();

        const { result } = renderHook(() =>
            useHomeMediaActions({
                diagnosticsState,
                mediaLibrary,
                confirmDeleteChannelFlow: vi.fn().mockResolvedValue(undefined),
            })
        );

        await act(async () => {
            await result.current.addMedia();
        });

        expect(mediaLibrary.addMedia).toHaveBeenCalledTimes(1);
        expect(diagnosticsState.reloadDiagnostics).toHaveBeenCalledTimes(1);
    });

    it("reloads diagnostics after confirming media delete when diagnostics is open", async () => {
        const diagnosticsState = createDiagnosticsState({
            diagnosticsOpen: true,
        });
        const mediaLibrary = createMediaLibrary();

        const { result } = renderHook(() =>
            useHomeMediaActions({
                diagnosticsState,
                mediaLibrary,
                confirmDeleteChannelFlow: vi.fn().mockResolvedValue(undefined),
            })
        );

        await act(async () => {
            await result.current.confirmDeleteMedia();
        });

        expect(mediaLibrary.confirmDeleteMedia).toHaveBeenCalledTimes(1);
        expect(diagnosticsState.reloadDiagnostics).toHaveBeenCalledTimes(1);
    });

    it("reloads diagnostics after confirming channel delete when diagnostics is open", async () => {
        const diagnosticsState = createDiagnosticsState({
            diagnosticsOpen: true,
        });
        const confirmDeleteChannelFlow = vi.fn().mockResolvedValue(undefined);

        const { result } = renderHook(() =>
            useHomeMediaActions({
                diagnosticsState,
                mediaLibrary: createMediaLibrary(),
                confirmDeleteChannelFlow,
            })
        );

        await act(async () => {
            await result.current.confirmDeleteChannel();
        });

        expect(confirmDeleteChannelFlow).toHaveBeenCalledTimes(1);
        expect(diagnosticsState.reloadDiagnostics).toHaveBeenCalledTimes(1);
    });

    it("reloads diagnostics after marking media as watched", async () => {
        const diagnosticsState = createDiagnosticsState({
            diagnosticsOpen: true,
        });
        const mediaLibrary = createMediaLibrary();

        const { result } = renderHook(() =>
            useHomeMediaActions({
                diagnosticsState,
                mediaLibrary,
                confirmDeleteChannelFlow: vi.fn().mockResolvedValue(undefined),
            })
        );

        await act(async () => {
            await result.current.markAsWatched(15);
        });

        expect(mediaLibrary.markAsWatched).toHaveBeenCalledWith(15);
        expect(diagnosticsState.reloadDiagnostics).toHaveBeenCalledTimes(1);
    });

    it("reloads diagnostics after marking media as unwatched", async () => {
        const diagnosticsState = createDiagnosticsState({
            diagnosticsOpen: true,
        });
        const mediaLibrary = createMediaLibrary();

        const { result } = renderHook(() =>
            useHomeMediaActions({
                diagnosticsState,
                mediaLibrary,
                confirmDeleteChannelFlow: vi.fn().mockResolvedValue(undefined),
            })
        );

        await act(async () => {
            await result.current.markAsUnwatched(20);
        });

        expect(mediaLibrary.markAsUnwatched).toHaveBeenCalledWith(20);
        expect(diagnosticsState.reloadDiagnostics).toHaveBeenCalledTimes(1);
    });

    it("edits the media title and reloads diagnostics when diagnostics is open", async () => {
        const diagnosticsState = createDiagnosticsState({
            diagnosticsOpen: true,
        });
        const mediaLibrary = createMediaLibrary();
        const media = { id: 5 } as any;

        const { result } = renderHook(() =>
            useHomeMediaActions({
                diagnosticsState,
                mediaLibrary,
                confirmDeleteChannelFlow: vi.fn().mockResolvedValue(undefined),
            })
        );

        await act(async () => {
            await result.current.editMediaTitle(media, "New title");
        });

        expect(mediaLibrary.editTitle).toHaveBeenCalledWith(media, "New title");
        expect(diagnosticsState.reloadDiagnostics).toHaveBeenCalledTimes(1);
    });

    it("edits the media title without reloading diagnostics when diagnostics is closed", async () => {
        const diagnosticsState = createDiagnosticsState({
            diagnosticsOpen: false,
        });
        const mediaLibrary = createMediaLibrary();
        const media = { id: 6 } as any;

        const { result } = renderHook(() =>
            useHomeMediaActions({
                diagnosticsState,
                mediaLibrary,
                confirmDeleteChannelFlow: vi.fn().mockResolvedValue(undefined),
            })
        );

        await act(async () => {
            await result.current.editMediaTitle(media, "New title");
        });

        expect(mediaLibrary.editTitle).toHaveBeenCalledWith(media, "New title");
        expect(diagnosticsState.reloadDiagnostics).not.toHaveBeenCalled();
    });

    it("saves media progress without reloading diagnostics even when diagnostics is open", async () => {
        // Progress saves happen periodically during playback and are irrelevant to what the
        // diagnostics dialog reports, so they never trigger a reload - otherwise an open
        // dialog would refresh every few seconds behind a playing video.
        const diagnosticsState = createDiagnosticsState({
            diagnosticsOpen: true,
        });
        const mediaLibrary = createMediaLibrary();

        const { result } = renderHook(() =>
            useHomeMediaActions({
                diagnosticsState,
                mediaLibrary,
                confirmDeleteChannelFlow: vi.fn().mockResolvedValue(undefined),
            })
        );

        await act(async () => {
            await result.current.saveMediaProgress(23, 12.5);
        });

        expect(mediaLibrary.saveMediaProgress).toHaveBeenCalledWith(23, 12.5);
        expect(diagnosticsState.reloadDiagnostics).not.toHaveBeenCalled();
    });

    it("saves media progress without reloading diagnostics when diagnostics is closed", async () => {
        const diagnosticsState = createDiagnosticsState({
            diagnosticsOpen: false,
        });
        const mediaLibrary = createMediaLibrary();

        const { result } = renderHook(() =>
            useHomeMediaActions({
                diagnosticsState,
                mediaLibrary,
                confirmDeleteChannelFlow: vi.fn().mockResolvedValue(undefined),
            })
        );

        await act(async () => {
            await result.current.saveMediaProgress(23, 12.5);
        });

        expect(mediaLibrary.saveMediaProgress).toHaveBeenCalledWith(23, 12.5);
        expect(diagnosticsState.reloadDiagnostics).not.toHaveBeenCalled();
    });

    describe("dependency freshness across rerenders", () => {
        it("calls mediaLibrary.addMedia from the latest render", async () => {
            const diagnosticsState = createDiagnosticsState({
                diagnosticsOpen: false,
            });
            const mediaLibrary = createMediaLibrary();
            const confirmDeleteChannelFlow = vi.fn().mockResolvedValue(undefined);

            const { result, rerender } = renderHook(
                (props: any) => useHomeMediaActions(props),
                {
                    initialProps: {
                        diagnosticsState,
                        mediaLibrary,
                        confirmDeleteChannelFlow,
                    },
                }
            );

            const newAddMedia = vi.fn().mockResolvedValue(undefined);
            const nextMediaLibrary = { ...mediaLibrary, addMedia: newAddMedia };

            rerender({
                diagnosticsState,
                mediaLibrary: nextMediaLibrary,
                confirmDeleteChannelFlow,
            });

            await act(async () => {
                await result.current.addMedia();
            });

            expect(newAddMedia).toHaveBeenCalledTimes(1);
            expect(mediaLibrary.addMedia).not.toHaveBeenCalled();
        });

        it("calls mediaLibrary.confirmDeleteMedia from the latest render", async () => {
            const diagnosticsState = createDiagnosticsState({
                diagnosticsOpen: false,
            });
            const mediaLibrary = createMediaLibrary();
            const confirmDeleteChannelFlow = vi.fn().mockResolvedValue(undefined);

            const { result, rerender } = renderHook(
                (props: any) => useHomeMediaActions(props),
                {
                    initialProps: {
                        diagnosticsState,
                        mediaLibrary,
                        confirmDeleteChannelFlow,
                    },
                }
            );

            const newConfirmDeleteMedia = vi.fn().mockResolvedValue(undefined);
            const nextMediaLibrary = {
                ...mediaLibrary,
                confirmDeleteMedia: newConfirmDeleteMedia,
            };

            rerender({
                diagnosticsState,
                mediaLibrary: nextMediaLibrary,
                confirmDeleteChannelFlow,
            });

            await act(async () => {
                await result.current.confirmDeleteMedia();
            });

            expect(newConfirmDeleteMedia).toHaveBeenCalledTimes(1);
            expect(mediaLibrary.confirmDeleteMedia).not.toHaveBeenCalled();
        });

        it("calls confirmDeleteChannelFlow from the latest render", async () => {
            const diagnosticsState = createDiagnosticsState({
                diagnosticsOpen: false,
            });
            const mediaLibrary = createMediaLibrary();
            const confirmDeleteChannelFlow = vi.fn().mockResolvedValue(undefined);

            const { result, rerender } = renderHook(
                (props: any) => useHomeMediaActions(props),
                {
                    initialProps: {
                        diagnosticsState,
                        mediaLibrary,
                        confirmDeleteChannelFlow,
                    },
                }
            );

            const newConfirmDeleteChannelFlow = vi.fn().mockResolvedValue(undefined);

            rerender({
                diagnosticsState,
                mediaLibrary,
                confirmDeleteChannelFlow: newConfirmDeleteChannelFlow,
            });

            await act(async () => {
                await result.current.confirmDeleteChannel();
            });

            expect(newConfirmDeleteChannelFlow).toHaveBeenCalledTimes(1);
            expect(confirmDeleteChannelFlow).not.toHaveBeenCalled();
        });

        it("calls mediaLibrary.markAsWatched from the latest render", async () => {
            const diagnosticsState = createDiagnosticsState({
                diagnosticsOpen: false,
            });
            const mediaLibrary = createMediaLibrary();
            const confirmDeleteChannelFlow = vi.fn().mockResolvedValue(undefined);

            const { result, rerender } = renderHook(
                (props: any) => useHomeMediaActions(props),
                {
                    initialProps: {
                        diagnosticsState,
                        mediaLibrary,
                        confirmDeleteChannelFlow,
                    },
                }
            );

            const newMarkAsWatched = vi.fn().mockResolvedValue(undefined);
            const nextMediaLibrary = { ...mediaLibrary, markAsWatched: newMarkAsWatched };

            rerender({
                diagnosticsState,
                mediaLibrary: nextMediaLibrary,
                confirmDeleteChannelFlow,
            });

            await act(async () => {
                await result.current.markAsWatched(15);
            });

            expect(newMarkAsWatched).toHaveBeenCalledWith(15);
            expect(mediaLibrary.markAsWatched).not.toHaveBeenCalled();
        });

        it("calls mediaLibrary.markAsUnwatched from the latest render", async () => {
            const diagnosticsState = createDiagnosticsState({
                diagnosticsOpen: false,
            });
            const mediaLibrary = createMediaLibrary();
            const confirmDeleteChannelFlow = vi.fn().mockResolvedValue(undefined);

            const { result, rerender } = renderHook(
                (props: any) => useHomeMediaActions(props),
                {
                    initialProps: {
                        diagnosticsState,
                        mediaLibrary,
                        confirmDeleteChannelFlow,
                    },
                }
            );

            const newMarkAsUnwatched = vi.fn().mockResolvedValue(undefined);
            const nextMediaLibrary = { ...mediaLibrary, markAsUnwatched: newMarkAsUnwatched };

            rerender({
                diagnosticsState,
                mediaLibrary: nextMediaLibrary,
                confirmDeleteChannelFlow,
            });

            await act(async () => {
                await result.current.markAsUnwatched(20);
            });

            expect(newMarkAsUnwatched).toHaveBeenCalledWith(20);
            expect(mediaLibrary.markAsUnwatched).not.toHaveBeenCalled();
        });

        it("calls mediaLibrary.editTitle from the latest render", async () => {
            const diagnosticsState = createDiagnosticsState({
                diagnosticsOpen: false,
            });
            const mediaLibrary = createMediaLibrary();
            const confirmDeleteChannelFlow = vi.fn().mockResolvedValue(undefined);

            const { result, rerender } = renderHook(
                (props: any) => useHomeMediaActions(props),
                {
                    initialProps: {
                        diagnosticsState,
                        mediaLibrary,
                        confirmDeleteChannelFlow,
                    },
                }
            );

            const newEditTitle = vi.fn().mockResolvedValue(undefined);
            const nextMediaLibrary = { ...mediaLibrary, editTitle: newEditTitle };

            rerender({
                diagnosticsState,
                mediaLibrary: nextMediaLibrary,
                confirmDeleteChannelFlow,
            });

            const media = { id: 9 } as any;

            await act(async () => {
                await result.current.editMediaTitle(media, "Fresh title");
            });

            expect(newEditTitle).toHaveBeenCalledWith(media, "Fresh title");
            expect(mediaLibrary.editTitle).not.toHaveBeenCalled();
        });

        it("calls mediaLibrary.saveMediaProgress from the latest render", async () => {
            const diagnosticsState = createDiagnosticsState({
                diagnosticsOpen: false,
            });
            const mediaLibrary = createMediaLibrary();
            const confirmDeleteChannelFlow = vi.fn().mockResolvedValue(undefined);

            const { result, rerender } = renderHook(
                (props: any) => useHomeMediaActions(props),
                {
                    initialProps: {
                        diagnosticsState,
                        mediaLibrary,
                        confirmDeleteChannelFlow,
                    },
                }
            );

            const newSaveMediaProgress = vi.fn().mockResolvedValue(undefined);
            const nextMediaLibrary = {
                ...mediaLibrary,
                saveMediaProgress: newSaveMediaProgress,
            };

            rerender({
                diagnosticsState,
                mediaLibrary: nextMediaLibrary,
                confirmDeleteChannelFlow,
            });

            await act(async () => {
                await result.current.saveMediaProgress(23, 12.5);
            });

            expect(newSaveMediaProgress).toHaveBeenCalledWith(23, 12.5);
            expect(mediaLibrary.saveMediaProgress).not.toHaveBeenCalled();
        });

        it("reloads diagnostics using the latest diagnosticsState after a rerender", async () => {
            const diagnosticsState = createDiagnosticsState({
                diagnosticsOpen: true,
            });
            const mediaLibrary = createMediaLibrary();
            const confirmDeleteChannelFlow = vi.fn().mockResolvedValue(undefined);

            const { result, rerender } = renderHook(
                (props: any) => useHomeMediaActions(props),
                {
                    initialProps: {
                        diagnosticsState,
                        mediaLibrary,
                        confirmDeleteChannelFlow,
                    },
                }
            );

            const newReloadDiagnostics = vi.fn().mockResolvedValue(undefined);
            const nextDiagnosticsState = {
                ...diagnosticsState,
                reloadDiagnostics: newReloadDiagnostics,
            };

            rerender({
                diagnosticsState: nextDiagnosticsState,
                mediaLibrary,
                confirmDeleteChannelFlow,
            });

            await act(async () => {
                await result.current.addMedia();
            });

            expect(newReloadDiagnostics).toHaveBeenCalledTimes(1);
            expect(diagnosticsState.reloadDiagnostics).not.toHaveBeenCalled();
        });
    });
});