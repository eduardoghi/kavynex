import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { describeIssues, validateIpcResult } from "./ipc-schemas";
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

// The diagnostic line a rejected payload leaves behind, and the only record of *which* field was
// wrong: the user is shown a generic message by design, so a bug report about this is the log line.
// Nothing above reaches it - both callers hand the result to `console.error` and nothing else - so
// every part of it survived a mutation pass while the polarity decisions around it were killed.
// These assert the exact output rather than that it is non-empty, which is what makes the joins and
// the fallback killable.
describe("describeIssues", () => {
    /** The ZodError a failed parse of `schema` against `value` produces. */
    function issuesFrom(schema: z.ZodTypeAny, value: unknown): z.ZodError {
        const parsed = schema.safeParse(value);

        if (parsed.success) {
            throw new Error("the fixture must fail to parse or this test asserts nothing");
        }

        return parsed.error;
    }

    it("names the failing field by its dotted path", () => {
        const schema = z.object({ outer: z.object({ inner: z.string() }) });

        const described = describeIssues(issuesFrom(schema, { outer: { inner: 1 } }));

        // The `.` is what makes a nested field identifiable at all. Joined with "" it reads
        // "outerinner", which names no field in the payload the report is about.
        expect(described).toMatch(/^outer\.inner: /);
    });

    it("falls back to (root) when the failure is the value itself", () => {
        // Nothing has a path when the whole payload is the wrong type, and an empty path would
        // render as ": Invalid input" - a line that says something failed and not what.
        const described = describeIssues(issuesFrom(z.object({ a: z.string() }), 42));

        expect(described).toMatch(/^\(root\): /);
    });

    it("separates the path from the message", () => {
        const schema = z.object({ title: z.string() });
        const error = issuesFrom(schema, { title: 7 });

        const described = describeIssues(error);

        // Pinned against zod's own message rather than a literal, so a wording change upstream does
        // not fail this - what is asserted is that both halves are present and in that order.
        expect(described).toBe(`title: ${error.issues[0]?.message}`);
    });

    it("puts every failing field in one line, separated", () => {
        // A malformed payload usually fails several fields at once. Joined with "" they run
        // together into one unreadable string, which is the state this separator prevents.
        const schema = z.object({ a: z.string(), b: z.number() });

        const described = describeIssues(issuesFrom(schema, { a: 1, b: "x" }));

        expect(described.split("; ")).toHaveLength(2);
        expect(described).toContain("a: ");
        expect(described).toContain("b: ");
    });

    it("describes a single issue with no separator", () => {
        // The boundary of the join: one issue must not carry a trailing or leading separator into
        // the log line.
        const described = describeIssues(issuesFrom(z.object({ a: z.string() }), { a: 1 }));

        expect(described).not.toContain(";");
        expect(described.length).toBeGreaterThan(0);
    });
});
