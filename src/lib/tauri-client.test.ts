import { beforeEach, describe, expect, it, vi } from "vitest";

// This is the one file that mocks `@tauri-apps` directly rather than mocking the seam. It is
// the seam. Every other test stubs `../lib/tauri-client`, which means nothing else exercises
// the two things this module actually contributes on top of Tauri's `invoke`. Forwarding the
// command/args untouched, and turning whatever the backend rejects with into a normalized
// AppErrorShape. The mocks are declared through `vi.hoisted` because `vi.mock` is hoisted above
// the imports, so a plain `const` would still be uninitialized when the factory runs.
const { invokeMock, listenMock, FakeChannel } = vi.hoisted(() => {
    // Stands in for Tauri's `Channel`. The seam only constructs one, hands it to `invoke` and sets
    // `onmessage`, so a test drives the stream by calling `onmessage` on the instance the mocked
    // `invoke` received, the same way the backend's messages would arrive.
    class FakeChannel<T> {
        onmessage: (message: T) => void = () => {};
    }

    return { invokeMock: vi.fn(), listenMock: vi.fn(), FakeChannel };
});

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock, Channel: FakeChannel }));
vi.mock("@tauri-apps/api/event", () => ({ listen: listenMock }));

import { TAURI_COMMANDS } from "../constants/tauri-commands";
import { APP_ERROR_CODE } from "../constants/error-codes";
import {
    invokeCommand,
    invokeVoid,
    listenTauri,
    listenValidated,
    migrateLibraryWithProgress,
    streamLibraryVerification,
    streamLiveChatFile,
} from "./tauri-client";
import { IPC_EVENT_SCHEMAS } from "./ipc-schemas";

// A full, schema-valid Channel: LIST_CHANNELS now validates its result at the seam (ipc-schemas.ts),
// so the mock has to be a real row, not a stub, for the forwarding tests to reach the return.
const validChannel = {
    id: 1,
    name: "Some Channel",
    youtube_handle: "@some",
    avatar_path: null,
    created_at: "2026-01-01T00:00:00Z",
};

beforeEach(() => {
    vi.clearAllMocks();
});

describe("invokeCommand", () => {
    it("forwards the command and args to invoke and returns its result", async () => {
        invokeMock.mockResolvedValue([validChannel]);

        const result = await invokeCommand(TAURI_COMMANDS.LIST_CHANNELS, { channelId: 7 });

        expect(result).toEqual([validChannel]);
        expect(invokeMock).toHaveBeenCalledTimes(1);
        expect(invokeMock).toHaveBeenCalledWith(TAURI_COMMANDS.LIST_CHANNELS, { channelId: 7 });
    });

    it("passes undefined args through instead of substituting an empty object", async () => {
        invokeMock.mockResolvedValue([]);

        await invokeCommand(TAURI_COMMANDS.LIST_CHANNELS);

        expect(invokeMock).toHaveBeenCalledWith(TAURI_COMMANDS.LIST_CHANNELS, undefined);
    });

    it("rejects with a normalized error when the backend result fails its schema", async () => {
        // The seam validates structured results (ipc-schemas.ts). A malformed response is turned
        // into the same AppErrorShape a rejection would be, so a caller never receives an object of
        // the wrong shape. The specific failing field is logged, not surfaced.
        const spy = vi.spyOn(console, "error").mockImplementation(() => {});
        invokeMock.mockResolvedValue([{ id: "not-a-number" }]);

        const error = await invokeCommand(TAURI_COMMANDS.LIST_CHANNELS).catch(
            (value: unknown) => value
        );

        expect(error).toMatchObject({ code: APP_ERROR_CODE });
        expect(spy).toHaveBeenCalled();
        spy.mockRestore();
    });

    it("normalizes a rejected backend error into an AppErrorShape", async () => {
        // What a Rust command rejects with. The serialized AppError, not an Error instance.
        invokeMock.mockRejectedValue({
            code: "INVALID_LIBRARY_PATH",
            message: "library path is empty",
            details: "extra context",
        });

        await expect(invokeCommand(TAURI_COMMANDS.GET_LIBRARY_SUMMARY, { path: "" })).rejects
            .toMatchObject({
                code: "INVALID_LIBRARY_PATH",
                message: "library path is empty",
                details: "extra context",
            });
    });

    it("normalizes a non-AppError rejection rather than leaking the raw value", async () => {
        // A thrown string is the shape that would otherwise reach a caller doing
        // `error.code` and get `undefined`; the seam exists so it never does.
        invokeMock.mockRejectedValue("something went sideways");

        const error = await invokeCommand(TAURI_COMMANDS.LIST_CHANNELS).catch(
            (value: unknown) => value
        );

        expect(error).toMatchObject({ code: APP_ERROR_CODE });
        expect(typeof (error as { message: unknown }).message).toBe("string");
    });
});

describe("invokeVoid", () => {
    it("forwards the command and args and resolves without a value", async () => {
        invokeMock.mockResolvedValue(null);

        await expect(
            invokeVoid(TAURI_COMMANDS.UPDATE_MEDIA_TITLE, { mediaId: 3, title: "x" })
        ).resolves.toBeUndefined();

        expect(invokeMock).toHaveBeenCalledWith(TAURI_COMMANDS.UPDATE_MEDIA_TITLE, {
            mediaId: 3,
            title: "x",
        });
    });

    it("normalizes a rejection the same way invokeCommand does", async () => {
        invokeMock.mockRejectedValue({ code: "INVALID_MEDIA_ID", message: "media id is invalid" });

        await expect(invokeVoid(TAURI_COMMANDS.UPDATE_MEDIA_TITLE, { mediaId: 0 })).rejects
            .toMatchObject({
                code: "INVALID_MEDIA_ID",
                message: "media id is invalid",
            });
    });
});

describe("listenTauri", () => {
    it("subscribes through listen and hands back its unlisten function", async () => {
        const unlisten = vi.fn();
        listenMock.mockResolvedValue(unlisten);
        const handler = vi.fn();

        const result = await listenTauri("yt-dlp://log", handler);

        expect(listenMock).toHaveBeenCalledWith("yt-dlp://log", handler);
        expect(result).toBe(unlisten);
    });
});

describe("listenValidated", () => {
    it("hands the validated payload to the handler when it matches the schema", async () => {
        const unlisten = vi.fn();
        listenMock.mockResolvedValue(unlisten);
        const handler = vi.fn();

        const result = await listenValidated("yt-dlp-log", IPC_EVENT_SCHEMAS.ytDlpLog, handler);

        // listenValidated wraps the handler; drive the wrapper the way `listen` would.
        const wrapped = listenMock.mock.calls[0]?.[1] as (event: { payload: unknown }) => void;
        wrapped({
            payload: { run_id: "r1", line: "hello", stream: "stdout", level: "info" },
        });

        expect(handler).toHaveBeenCalledTimes(1);
        expect(handler).toHaveBeenCalledWith({
            run_id: "r1",
            line: "hello",
            stream: "stdout",
            level: "info",
        });
        expect(result).toBe(unlisten);
    });

    it("drops a payload that does not match the schema instead of calling the handler", async () => {
        const spy = vi.spyOn(console, "error").mockImplementation(() => {});
        const unlisten = vi.fn();
        listenMock.mockResolvedValue(unlisten);
        const handler = vi.fn();

        await listenValidated("yt-dlp-log", IPC_EVENT_SCHEMAS.ytDlpLog, handler);

        const wrapped = listenMock.mock.calls[0]?.[1] as (event: { payload: unknown }) => void;
        // `run_id` as a number, and missing `stream`/`level`. A backend contract break.
        wrapped({ payload: { run_id: 7, line: "hello" } });

        expect(handler).not.toHaveBeenCalled();
        expect(spy).toHaveBeenCalled();
        spy.mockRestore();
    });
});

// Lets every already-queued promise callback run, so a test can tell "not settled yet" apart from
// "settled" without a timer.
async function flushPromises(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
}

// The channel the seam handed to the most recent `invoke`, under the argument name it used.
function channelPassedAs<T>(argName: string): InstanceType<typeof FakeChannel<T>> {
    const calls = invokeMock.mock.calls;
    const args = calls[calls.length - 1]?.[1] as Record<string, unknown> | undefined;
    const channel = args?.[argName];

    if (!(channel instanceof FakeChannel)) {
        throw new Error(`invoke was not handed a channel as "${argName}"`);
    }

    return channel as InstanceType<typeof FakeChannel<T>>;
}

describe("streamLiveChatFile", () => {
    it("passes the path and the channel, and hands each batch to onLines", async () => {
        invokeMock.mockResolvedValue(null);
        const onLines = vi.fn();

        const streaming = streamLiveChatFile("live_chat/a.json.gz", onLines);
        await flushPromises();

        expect(invokeMock).toHaveBeenCalledWith(TAURI_COMMANDS.STREAM_LIVE_CHAT_FILE, {
            relativePath: "live_chat/a.json.gz",
            streamId: expect.any(String),
            onBatch: expect.any(FakeChannel),
        });

        const channel = channelPassedAs("onBatch");
        channel.onmessage({ kind: "batch", lines: ["one", "two"] });
        channel.onmessage({ kind: "batch", lines: ["three"] });
        channel.onmessage({ kind: "done" });

        await expect(streaming).resolves.toBeUndefined();
        expect(onLines.mock.calls).toEqual([[["one", "two"]], [["three"]]]);
    });

    it("does not resolve when the command returns, only when done arrives", async () => {
        // The command response and the channel messages travel independently. Resolving on the
        // return would drop a batch still in flight, which is why the seam waits for `done`.
        invokeMock.mockResolvedValue(null);
        let settled = false;

        const streaming = streamLiveChatFile("live_chat/a.json.gz", vi.fn()).then(() => {
            settled = true;
        });
        await flushPromises();

        expect(settled).toBe(false);

        channelPassedAs("onBatch").onmessage({ kind: "done" });
        await streaming;

        expect(settled).toBe(true);
    });

    it("rejects when the command returned and done never followed", async () => {
        // The wait for `done` is bounded, like the verification's. A backend that returned without
        // sending it would otherwise leave the live chat panel loading for good.
        vi.useFakeTimers();
        invokeMock.mockResolvedValue(null);

        const streaming = streamLiveChatFile("live_chat/a.json.gz", vi.fn());
        const outcome = expect(streaming).rejects.toThrow("without finishing");

        await vi.advanceTimersByTimeAsync(10_000);
        await outcome;

        vi.useRealTimers();
    });

    it("rejects at once when aborted, ignores later batches and cancels the backend stream", async () => {
        invokeMock.mockResolvedValue(null);
        const onLines = vi.fn();
        const controller = new AbortController();

        const streaming = streamLiveChatFile("live_chat/a.json.gz", onLines, controller.signal);
        await flushPromises();

        const streamId = (invokeMock.mock.calls[0]?.[1] as { streamId: string }).streamId;
        const channel = channelPassedAs("onBatch");
        channel.onmessage({ kind: "batch", lines: ["before"] });

        controller.abort();
        channel.onmessage({ kind: "batch", lines: ["after"] });

        await expect(streaming).rejects.toMatchObject({ name: "AbortError" });
        expect(onLines.mock.calls).toEqual([[["before"]]]);
        expect(invokeMock).toHaveBeenCalledWith(TAURI_COMMANDS.CANCEL_LIVE_CHAT_STREAM, {
            streamId,
        });
    });

    it("does not start a read for a signal already aborted", async () => {
        const controller = new AbortController();
        controller.abort();

        await expect(
            streamLiveChatFile("live_chat/a.json.gz", vi.fn(), controller.signal)
        ).rejects.toMatchObject({ name: "AbortError" });
        expect(invokeMock).not.toHaveBeenCalledWith(
            TAURI_COMMANDS.STREAM_LIVE_CHAT_FILE,
            expect.anything()
        );
    });

    it("drops a malformed message and keeps reading", async () => {
        const spy = vi.spyOn(console, "error").mockImplementation(() => {});
        invokeMock.mockResolvedValue(null);
        const onLines = vi.fn();

        const streaming = streamLiveChatFile("live_chat/a.json.gz", onLines);
        await flushPromises();

        const channel = channelPassedAs("onBatch");
        channel.onmessage({ kind: "batch", lines: [42] });
        channel.onmessage({ kind: "batch", lines: ["kept"] });
        channel.onmessage({ kind: "done" });

        await streaming;

        expect(onLines.mock.calls).toEqual([[["kept"]]]);
        expect(spy).toHaveBeenCalled();
        spy.mockRestore();
    });

    it("rejects on an unreadable message that is not a batch instead of waiting forever", async () => {
        // It may be the terminal `done`, the only message that settles the read. Dropping it the way
        // a bad batch is dropped left the live chat panel loading with no error and no way back.
        for (const message of [{ kind: "finished" }, { lines: ["x"] }, null]) {
            const spy = vi.spyOn(console, "error").mockImplementation(() => {});
            invokeMock.mockResolvedValue(null);

            const streaming = streamLiveChatFile("live_chat/a.json.gz", vi.fn());
            await flushPromises();

            channelPassedAs("onBatch").onmessage(message);

            await expect(streaming).rejects.toThrow("could not read");
            spy.mockRestore();
            invokeMock.mockClear();
        }
    });

    it("hands no more batches to onLines once the read has failed", async () => {
        const spy = vi.spyOn(console, "error").mockImplementation(() => {});
        invokeMock.mockResolvedValue(null);
        const onLines = vi.fn();

        const streaming = streamLiveChatFile("live_chat/a.json.gz", onLines);
        await flushPromises();

        const channel = channelPassedAs("onBatch");
        channel.onmessage({ kind: "finished" });
        channel.onmessage({ kind: "batch", lines: ["late"] });

        await expect(streaming).rejects.toThrow("could not read");
        expect(onLines).not.toHaveBeenCalled();
        spy.mockRestore();
    });

    it("rejects with a normalized error when the read fails", async () => {
        invokeMock.mockRejectedValue({
            code: "LIVE_CHAT_FILE_NOT_FOUND",
            message: "live chat file not found",
        });

        await expect(streamLiveChatFile("live_chat/gone.json.gz", vi.fn())).rejects.toMatchObject({
            code: "LIVE_CHAT_FILE_NOT_FOUND",
        });
    });
});

describe("migrateLibraryWithProgress", () => {
    it("passes the channel with the paths, reports valid progress and returns the result", async () => {
        const result = { final_library_path: "E:/Library", changed: true, old_directory_retained: false };
        invokeMock.mockResolvedValue(result);
        const spy = vi.spyOn(console, "error").mockImplementation(() => {});
        const onProgress = vi.fn();

        const moving = migrateLibraryWithProgress(
            { oldLibraryPath: "D:/Library", newLibraryPath: "E:/Library", switchWithoutMoving: false },
            onProgress
        );
        await flushPromises();

        expect(invokeMock).toHaveBeenCalledWith(TAURI_COMMANDS.MIGRATE_LIBRARY_DIRECTORY, {
            oldLibraryPath: "D:/Library",
            newLibraryPath: "E:/Library",
            switchWithoutMoving: false,
            onProgress: expect.any(FakeChannel),
        });

        const channel = channelPassedAs("onProgress");
        const progress = { copiedFiles: 1, totalFiles: 2, copiedBytes: 10, totalBytes: 20 };
        channel.onmessage(progress);
        // Only a progress bar depends on these, so one it cannot read is dropped, not fatal.
        channel.onmessage({ copiedFiles: "one" });

        await expect(moving).resolves.toEqual(result);
        expect(onProgress.mock.calls).toEqual([[progress]]);
        spy.mockRestore();
    });
});

describe("streamLibraryVerification", () => {
    const report = {
        checked: 3,
        verified: 2,
        corrupt: 1,
        corruptExamples: ["video/media_abc.mp4"],
        unverifiable: 0,
        unverifiableExamples: [],
        unreadable: 0,
        unreadableExamples: [],
        cancelled: false,
    };

    it("passes only the channel, reports progress and resolves with the report", async () => {
        invokeMock.mockResolvedValue(null);
        const onProgress = vi.fn();

        const verifying = streamLibraryVerification(onProgress);
        await flushPromises();

        expect(invokeMock).toHaveBeenCalledWith(TAURI_COMMANDS.VERIFY_LIBRARY_CONTENT, {
            onProgress: expect.any(FakeChannel),
        });

        const channel = channelPassedAs("onProgress");
        channel.onmessage({ kind: "progress", checked: 1, total: 3 });
        channel.onmessage({ kind: "progress", checked: 3, total: 3 });
        channel.onmessage({ kind: "done", report });

        await expect(verifying).resolves.toEqual(report);
        expect(onProgress.mock.calls).toEqual([
            [1, 3],
            [3, 3],
        ]);
    });

    it("rejects on a message it cannot read instead of waiting forever", async () => {
        // Unlike the live chat stream, the unreadable message may be the `done` that carries the
        // report, so dropping it would leave the dialog on "verifying" with no way back.
        const spy = vi.spyOn(console, "error").mockImplementation(() => {});
        invokeMock.mockResolvedValue(null);

        const verifying = streamLibraryVerification(vi.fn());
        await flushPromises();

        channelPassedAs("onProgress").onmessage({ kind: "done", report: { checked: "3" } });

        await expect(verifying).rejects.toThrow("could not read");
        spy.mockRestore();
    });

    it("rejects when the command returned and no report ever arrived", async () => {
        vi.useFakeTimers();
        invokeMock.mockResolvedValue(null);

        const verifying = streamLibraryVerification(vi.fn());
        const outcome = expect(verifying).rejects.toThrow("without reporting a result");

        await vi.advanceTimersByTimeAsync(10_000);
        await outcome;

        vi.useRealTimers();
    });

    it("rejects with a normalized error when the command is refused", async () => {
        invokeMock.mockRejectedValue({
            code: "LIBRARY_VERIFICATION_IN_PROGRESS",
            message: "a verification is already running",
        });

        await expect(streamLibraryVerification(vi.fn())).rejects.toMatchObject({
            code: "LIBRARY_VERIFICATION_IN_PROGRESS",
        });
    });
});
