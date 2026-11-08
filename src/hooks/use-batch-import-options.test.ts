import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useBatchImportOptions } from "./use-batch-import-options";

vi.mock("../services/file-dialog-service", () => ({
    pickFile: vi.fn(),
}));

vi.mock("../utils/app-logger", () => ({
    logError: vi.fn(),
}));

import { pickFile } from "../services/file-dialog-service";

describe("useBatchImportOptions", () => {
    it("starts from the best quality, comments and live chat on, and no cookies", () => {
        const { result } = renderHook(() => useBatchImportOptions());

        expect(result.current.quality).toBe("best");
        expect(result.current.resolve()).toEqual({
            downloadComments: true,
            downloadLiveChat: true,
            cookiesBrowser: null,
            cookiesPath: null,
        });
    });

    it("sends a browser with its profile the way the add-media form does", () => {
        const { result } = renderHook(() => useBatchImportOptions());

        act(() => {
            result.current.setQuality("720");
            result.current.setCookiesBrowser("firefox");
            result.current.setCookiesBrowserProfile("default-release");
        });

        expect(result.current.quality).toBe("720");
        expect(result.current.resolve()).toMatchObject({
            cookiesBrowser: "firefox:default-release",
            cookiesPath: null,
        });
    });

    it("refuses a cookies file chosen as the source and never picked", () => {
        const { result } = renderHook(() => useBatchImportOptions());

        act(() => {
            result.current.setCookiesBrowser("manual");
        });

        let resolved: ReturnType<typeof result.current.resolve> = null;
        act(() => {
            resolved = result.current.resolve();
        });

        expect(resolved).toBeNull();
        expect(result.current.error).not.toBeNull();
    });

    it("takes a picked cookies file, and refuses one that is not a .txt", async () => {
        vi.mocked(pickFile)
            .mockResolvedValueOnce("C:/cookies/notes.pdf")
            .mockResolvedValueOnce("C:/cookies/cookies.txt");
        const { result } = renderHook(() => useBatchImportOptions());

        await act(async () => {
            await result.current.pickCookiesFile();
        });
        expect(result.current.error).toBe("Please choose a valid .txt cookies file.");

        await act(async () => {
            await result.current.pickCookiesFile();
        });

        expect(pickFile).toHaveBeenLastCalledWith("cookies", expect.anything());
        expect(result.current.resolve()).toMatchObject({
            cookiesBrowser: null,
            cookiesPath: "C:/cookies/cookies.txt",
        });
    });
});
