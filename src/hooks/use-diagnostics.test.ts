import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DiagnosticsSummary } from "../types/diagnostics";

vi.mock("../services/diagnostics-service", () => ({
    getDiagnosticsSummary: vi.fn(),
}));

vi.mock("../utils/app-error", () => ({
    parseAppError: vi.fn((error: unknown) => error),
}));

vi.mock("../utils/error-message", () => ({
    resolveErrorMessage: vi.fn((_error: unknown, fallback: string) => fallback),
}));

vi.mock("../utils/app-logger", () => ({
    logError: vi.fn(),
}));

import { getDiagnosticsSummary } from "../services/diagnostics-service";
import { useDiagnostics } from "./use-diagnostics";

const getDiagnosticsSummaryMock = vi.mocked(getDiagnosticsSummary);

function createSummary(label: string): DiagnosticsSummary {
    return {
        diagnostics: {
            appVersion: "0.1.0",
            platform: "unknown",
            arch: "unknown",
            libraryPath: `/library/${label}`,
            importMode: "copy",
            externalTools: {
                yt_dlp: {
                    path: "/tools/yt-dlp",
                    version: "2026.01.01",
                    healthy: true,
                    release_age_days: null,
                },
                ffmpeg: {
                    path: "/tools/ffmpeg",
                    version: "7.0",
                    healthy: true,
                    release_age_days: null,
                },
            },
            librarySummary: {
                total_bytes: 1024,
                formatted_size: "1 KB",
                video_files: 1,
                audio_files: 0,
                thumbnail_files: 1,
            },
            liveChatStorage: {
                live_chat_files: 0,
            },
            mediaRepositoryStats: {
                total_media: 1,
                total_video_media: 1,
                total_audio_media: 0,
                total_with_thumbnail: 1,
                total_without_thumbnail: 0,
                total_watched: 0,
                total_unwatched: 1,
                total_live_media: 0,
                total_with_live_chat: 0,
                total_without_live_chat: 1,
                total_media_with_live_chat_flag_but_no_path: 0,
                total_media_with_live_chat_path_but_not_live: 0,
            },
            libraryIntegrity: {
                checked_media_files: 1,
                missing_media_files: 0,
                missing_media_examples: [],
                checked_thumbnail_files: 1,
                missing_thumbnail_files: 0,
                missing_thumbnail_examples: [],
                orphan_media_files: 0,
                orphan_media_examples: [],
                orphan_thumbnail_files: 0,
                orphan_thumbnail_examples: [],
                invalid_media_files: 0,
                invalid_media_examples: [],
                invalid_thumbnail_files: 0,
                invalid_thumbnail_examples: [],
            },
            liveChatIntegrity: {
                checked_live_chat_files: 0,
                missing_live_chat_files: 0,
                missing_live_chat_examples: [],
                orphan_live_chat_files: 0,
                orphan_live_chat_examples: [],
            },
        },
        issues: [],
        overview: {
            status: "healthy",
            issueCount: 0,
            errorCount: 0,
            warningCount: 0,
            infoCount: 0,
            headline: "Everything looks good",
            description: "No blocking issues were detected in the current environment.",
        },
    };
}

type HookProps = {
    libraryPath: string;
    importMode: "copy" | "move";
};

describe("useDiagnostics", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("opens diagnostics and loads summary", async () => {
        const onError = vi.fn();

        getDiagnosticsSummaryMock.mockResolvedValueOnce(createSummary("open"));

        const { result } = renderHook(() =>
            useDiagnostics({
                libraryPath: "/library",
                importMode: "copy",
                onError,
            })
        );

        await act(async () => {
            await result.current.openDiagnostics();
        });

        expect(result.current.diagnosticsOpen).toBe(true);
        expect(getDiagnosticsSummaryMock).toHaveBeenCalledWith({
            libraryPath: "/library",
            importMode: "copy",
        });

        await waitFor(() => {
            expect(result.current.diagnosticsSummary).not.toBeNull();
        });

        expect(result.current.isLoadingDiagnostics).toBe(false);
        expect(onError).not.toHaveBeenCalled();
    });

    it("reloads diagnostics manually", async () => {
        const onError = vi.fn();

        getDiagnosticsSummaryMock
            .mockResolvedValueOnce(createSummary("first"))
            .mockResolvedValueOnce(createSummary("second"));

        const { result } = renderHook(() =>
            useDiagnostics({
                libraryPath: "/library",
                importMode: "copy",
                onError,
            })
        );

        await act(async () => {
            await result.current.openDiagnostics();
        });

        await waitFor(() => {
            expect(result.current.diagnosticsSummary?.diagnostics.libraryPath).toBe(
                "/library/first"
            );
        });

        await act(async () => {
            await result.current.reloadDiagnostics();
        });

        await waitFor(() => {
            expect(result.current.diagnosticsSummary?.diagnostics.libraryPath).toBe(
                "/library/second"
            );
        });

        expect(getDiagnosticsSummaryMock).toHaveBeenCalledTimes(2);
    });

    it("clears summary and loading state when closing diagnostics", async () => {
        const onError = vi.fn();

        getDiagnosticsSummaryMock.mockResolvedValueOnce(createSummary("close"));

        const { result } = renderHook(() =>
            useDiagnostics({
                libraryPath: "/library",
                importMode: "copy",
                onError,
            })
        );

        await act(async () => {
            await result.current.openDiagnostics();
        });

        await waitFor(() => {
            expect(result.current.diagnosticsSummary).not.toBeNull();
        });

        act(() => {
            result.current.closeDiagnostics();
        });

        expect(result.current.diagnosticsOpen).toBe(false);
        expect(result.current.isLoadingDiagnostics).toBe(false);
        expect(result.current.diagnosticsSummary).toBeNull();
    });

    it("calls onError when loading diagnostics fails", async () => {
        const onError = vi.fn();

        getDiagnosticsSummaryMock.mockRejectedValueOnce(new Error("boom"));

        const { result } = renderHook(() =>
            useDiagnostics({
                libraryPath: "/library",
                importMode: "copy",
                onError,
            })
        );

        await act(async () => {
            await result.current.openDiagnostics();
        });

        await waitFor(() => {
            expect(onError).toHaveBeenCalledWith("Failed to load diagnostics.");
        });

        expect(result.current.isLoadingDiagnostics).toBe(false);
        expect(result.current.diagnosticsSummary).toBeNull();
    });

    it("clears previous summary when reload fails", async () => {
        const onError = vi.fn();

        getDiagnosticsSummaryMock
            .mockResolvedValueOnce(createSummary("ok"))
            .mockRejectedValueOnce(new Error("boom"));

        const { result } = renderHook(() =>
            useDiagnostics({
                libraryPath: "/library",
                importMode: "copy",
                onError,
            })
        );

        await act(async () => {
            await result.current.openDiagnostics();
        });

        await waitFor(() => {
            expect(result.current.diagnosticsSummary?.diagnostics.libraryPath).toBe(
                "/library/ok"
            );
        });

        await act(async () => {
            await result.current.reloadDiagnostics();
        });

        await waitFor(() => {
            expect(onError).toHaveBeenCalledWith("Failed to load diagnostics.");
        });

        expect(result.current.diagnosticsSummary).toBeNull();
    });

    it("reloads automatically when libraryPath changes while diagnostics is open", async () => {
        const onError = vi.fn();

        getDiagnosticsSummaryMock
            .mockResolvedValueOnce(createSummary("initial"))
            .mockResolvedValueOnce(createSummary("changed-path"));

        const initialProps: HookProps = {
            libraryPath: "/library-a",
            importMode: "copy",
        };

        const { result, rerender } = renderHook(
            ({ libraryPath, importMode }: HookProps) =>
                useDiagnostics({
                    libraryPath,
                    importMode,
                    onError,
                }),
            {
                initialProps,
            }
        );

        await act(async () => {
            await result.current.openDiagnostics();
        });

        await waitFor(() => {
            expect(result.current.diagnosticsSummary?.diagnostics.libraryPath).toBe(
                "/library/initial"
            );
        });

        rerender({
            libraryPath: "/library-b",
            importMode: "copy",
        });

        await waitFor(() => {
            expect(getDiagnosticsSummaryMock).toHaveBeenCalledTimes(2);
        });

        await waitFor(() => {
            expect(result.current.diagnosticsSummary?.diagnostics.libraryPath).toBe(
                "/library/changed-path"
            );
        });
    });

    it("reloads automatically when importMode changes while diagnostics is open", async () => {
        const onError = vi.fn();

        getDiagnosticsSummaryMock
            .mockResolvedValueOnce(createSummary("copy"))
            .mockResolvedValueOnce(createSummary("move"));

        const initialProps: HookProps = {
            libraryPath: "/library",
            importMode: "copy",
        };

        const { result, rerender } = renderHook(
            ({ libraryPath, importMode }: HookProps) =>
                useDiagnostics({
                    libraryPath,
                    importMode,
                    onError,
                }),
            {
                initialProps,
            }
        );

        await act(async () => {
            await result.current.openDiagnostics();
        });

        await waitFor(() => {
            expect(result.current.diagnosticsSummary?.diagnostics.libraryPath).toBe(
                "/library/copy"
            );
        });

        rerender({
            libraryPath: "/library",
            importMode: "move",
        });

        await waitFor(() => {
            expect(getDiagnosticsSummaryMock).toHaveBeenCalledTimes(2);
        });

        await waitFor(() => {
            expect(result.current.diagnosticsSummary?.diagnostics.libraryPath).toBe(
                "/library/move"
            );
        });
    });

    it("does not auto-load while diagnostics is closed", async () => {
        const onError = vi.fn();

        const initialProps: HookProps = {
            libraryPath: "/library-a",
            importMode: "copy",
        };

        const { rerender } = renderHook(
            ({ libraryPath, importMode }: HookProps) =>
                useDiagnostics({
                    libraryPath,
                    importMode,
                    onError,
                }),
            {
                initialProps,
            }
        );

        rerender({
            libraryPath: "/library-b",
            importMode: "move",
        });

        expect(getDiagnosticsSummaryMock).not.toHaveBeenCalled();
    });

    it("does not reload when reopening props stay identical while open", async () => {
        const onError = vi.fn();

        getDiagnosticsSummaryMock.mockResolvedValue(createSummary("stable"));

        const initialProps: HookProps = {
            libraryPath: "/library",
            importMode: "copy",
        };

        const { result, rerender } = renderHook(
            ({ libraryPath, importMode }: HookProps) =>
                useDiagnostics({ libraryPath, importMode, onError }),
            { initialProps }
        );

        await act(async () => {
            await result.current.openDiagnostics();
        });

        expect(getDiagnosticsSummaryMock).toHaveBeenCalledTimes(1);

        rerender({ libraryPath: "/library", importMode: "copy" });

        // Same libraryPath and importMode: the auto-reload effect must bail out.
        expect(getDiagnosticsSummaryMock).toHaveBeenCalledTimes(1);
    });

    it("discards a stale error without calling onError", async () => {
        const onError = vi.fn();

        let rejectFirst: ((reason: unknown) => void) | null = null;

        getDiagnosticsSummaryMock
            .mockImplementationOnce(
                () =>
                    new Promise<DiagnosticsSummary>((_resolve, reject) => {
                        rejectFirst = reject;
                    })
            )
            .mockResolvedValueOnce(createSummary("fresh"));

        const { result } = renderHook(() =>
            useDiagnostics({ libraryPath: "/library", importMode: "copy", onError })
        );

        await act(async () => {
            void result.current.openDiagnostics();
        });

        // A manual reload supersedes the in-flight first request.
        await act(async () => {
            await result.current.reloadDiagnostics();
        });

        await waitFor(() => {
            expect(result.current.diagnosticsSummary?.diagnostics.libraryPath).toBe(
                "/library/fresh"
            );
        });

        await act(async () => {
            rejectFirst?.(new Error("stale failure"));
        });

        // The stale rejection must neither surface an error nor wipe the fresh summary.
        expect(onError).not.toHaveBeenCalled();
        expect(result.current.diagnosticsSummary?.diagnostics.libraryPath).toBe(
            "/library/fresh"
        );
    });

    it("ignores stale request results and keeps only the latest summary", async () => {
        const onError = vi.fn();

        let resolveFirst: ((value: DiagnosticsSummary) => void) | null = null;
        let resolveSecond: ((value: DiagnosticsSummary) => void) | null = null;

        getDiagnosticsSummaryMock
            .mockImplementationOnce(
                () =>
                    new Promise<DiagnosticsSummary>((resolve) => {
                        resolveFirst = resolve;
                    })
            )
            .mockImplementationOnce(
                () =>
                    new Promise<DiagnosticsSummary>((resolve) => {
                        resolveSecond = resolve;
                    })
            );

        const initialProps: HookProps = {
            libraryPath: "/library-a",
            importMode: "copy",
        };

        const { result, rerender } = renderHook(
            ({ libraryPath, importMode }: HookProps) =>
                useDiagnostics({
                    libraryPath,
                    importMode,
                    onError,
                }),
            {
                initialProps,
            }
        );

        await act(async () => {
            void result.current.openDiagnostics();
        });

        rerender({
            libraryPath: "/library-b",
            importMode: "copy",
        });

        await act(async () => {
            resolveSecond?.(createSummary("latest"));
        });

        await waitFor(() => {
            expect(result.current.diagnosticsSummary?.diagnostics.libraryPath).toBe(
                "/library/latest"
            );
        });

        await act(async () => {
            resolveFirst?.(createSummary("stale"));
        });

        expect(result.current.diagnosticsSummary?.diagnostics.libraryPath).toBe(
            "/library/latest"
        );
        expect(onError).not.toHaveBeenCalled();
    });
});