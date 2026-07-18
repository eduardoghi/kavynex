import { beforeEach, describe, expect, it, vi } from "vitest";

// This is the one file that mocks `@tauri-apps` directly rather than mocking the seam: it is
// the seam. Every other test stubs `../lib/tauri-client`, which means nothing else exercises
// the two things this module actually contributes on top of Tauri's `invoke` - forwarding the
// command/args untouched, and turning whatever the backend rejects with into a normalized
// AppErrorShape. The mocks are declared through `vi.hoisted` because `vi.mock` is hoisted above
// the imports, so a plain `const` would still be uninitialized when the factory runs.
const { invokeMock, listenMock } = vi.hoisted(() => ({
    invokeMock: vi.fn(),
    listenMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/api/event", () => ({ listen: listenMock }));

import { TAURI_COMMANDS } from "../constants/tauri-commands";
import { APP_ERROR_CODE } from "../constants/error-codes";
import { invokeCommand, invokeVoid, listenTauri } from "./tauri-client";

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
        // The seam validates structured results (ipc-schemas.ts): a malformed response is turned
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
        // What a Rust command rejects with: the serialized AppError, not an Error instance.
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
