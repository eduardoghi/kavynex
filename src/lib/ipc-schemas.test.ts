import { describe, expect, it, vi } from "vitest";
import { validateIpcResult } from "./ipc-schemas";
import { APP_ERROR_CODE } from "../constants/error-codes";
import type { AppErrorShape } from "../utils/app-error";

const validChannel = {
    id: 1,
    name: "Some Channel",
    youtube_handle: "@some",
    avatar_path: null,
    created_at: "2026-01-01T00:00:00Z",
};

describe("validateIpcResult", () => {
    it("returns a valid structured payload unchanged", () => {
        expect(validateIpcResult("get_channel_by_id", { ...validChannel })).toEqual(validChannel);
    });

    it("accepts null for a nullable command result", () => {
        expect(validateIpcResult("get_channel_by_id", null)).toBeNull();
    });

    it("validates every element of an array result", () => {
        expect(validateIpcResult("list_channels", [{ ...validChannel }])).toEqual([validChannel]);
    });

    it("strips unknown keys so a new backend field does not break the call", () => {
        // A response carrying a field the schema does not know about (a backend that shipped a new
        // column before the frontend schema learned it) must pass, with the extra field dropped -
        // never rejected. This is why the schemas are non-strict.
        const withExtra = { ...validChannel, brand_new_field: "surprise" } as unknown as never;
        const result = validateIpcResult("get_channel_by_id", withExtra);

        expect(result).not.toBeNull();
        expect(result).not.toHaveProperty("brand_new_field");
        expect(result).toMatchObject(validChannel);
    });

    it("throws a generic app error and logs the detail on a malformed payload", () => {
        const spy = vi.spyOn(console, "error").mockImplementation(() => {});
        // Wrong type for a required field: the kind of shape surprise the seam exists to catch.
        const malformed = { ...validChannel, id: "not-a-number" } as unknown as never;

        let thrown: AppErrorShape | undefined;
        try {
            validateIpcResult("get_channel_by_id", malformed);
        } catch (error) {
            thrown = error as AppErrorShape;
        }

        expect(thrown?.code).toBe(APP_ERROR_CODE);
        // The user-facing message is generic (an internal contract violation is not user-actionable);
        // the specific failing field is logged for a bug report, not shown.
        expect(thrown?.message).toContain("get_channel_by_id");
        expect(spy).toHaveBeenCalledWith(
            expect.stringContaining("Invalid IPC response for \"get_channel_by_id\"")
        );
        spy.mockRestore();
    });

    it("rejects a payload missing a required field", () => {
        const spy = vi.spyOn(console, "error").mockImplementation(() => {});
        const incomplete = { id: 1, name: "n" } as unknown as never;

        expect(() => validateIpcResult("get_channel_by_id", incomplete)).toThrow();
        spy.mockRestore();
    });

    it("passes a command with no registered schema through untouched", () => {
        // insert_channel returns a bare number - there is no shape for a wrong value to hide in, so
        // it is not registered and the value is returned as-is.
        expect(validateIpcResult("insert_channel", 42)).toBe(42);
    });
});
