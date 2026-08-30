// The single IPC seam. The only module that calls into our own Rust backend, wrapping Tauri's
// `invoke`/`listen` with consistent error normalization (parseAppError). Tauri's *platform*
// capabilities (dialogs, opener, process, updater, app version, asset URLs) live in the sibling
// `tauri-platform.ts`. Between them these two modules are the only files allowed to import
// `@tauri-apps` at all, enforced by eslint.config.js. See tauri-platform.ts for the rationale.
import { Channel, invoke } from "@tauri-apps/api/core";
import { listen, type Event, type UnlistenFn } from "@tauri-apps/api/event";
import { TAURI_COMMANDS, type TauriCommandName } from "../constants/tauri-commands";
import type { TauriCommandReturns } from "./tauri-command-returns";
import {
    contentVerificationEventSchema,
    liveChatStreamEventSchema,
    parseEventPayload,
    validateIpcResult,
    type ContentVerificationEvent,
    type ContentVerificationReport,
    type LiveChatStreamEvent,
} from "./ipc-schemas";
import { parseAppError } from "../utils/app-error";
import type { z } from "zod";

// Re-exported so an event subscriber can type its unsubscribe handle (and its handler payload)
// without reaching for `@tauri-apps/api/event` itself, which the boundary rule forbids.
export type { Event, UnlistenFn };

type InvokeArgs = Record<string, unknown> | undefined;

// Commands whose result is `void` (Rust `AppResult<()>`), so `invokeVoid` can reject a call that
// would silently discard a value the command actually returns.
type VoidCommandName = {
    [K in TauriCommandName]: TauriCommandReturns[K] extends void ? K : never;
}[TauriCommandName];

// The result type is not chosen by the caller; it follows from the command via TauriCommandReturns.
// This is what keeps a wrong `invokeCommand<Foo>(SOME_COMMAND)` from compiling.
export async function invokeCommand<K extends TauriCommandName>(
    command: K,
    args?: InvokeArgs
): Promise<TauriCommandReturns[K]> {
    try {
        const result = await invoke<TauriCommandReturns[K]>(command, args);
        // Validate the structured result against its schema (ipc-schemas.ts) before handing it back,
        // so a malformed response fails here with a clear message rather than as a shape surprise
        // deep in a caller. A command with no registered schema passes through unchanged.
        return validateIpcResult(command, result);
    } catch (error) {
        throw parseAppError(error);
    }
}

export async function invokeVoid(
    command: VoidCommandName,
    args?: InvokeArgs
): Promise<void> {
    await invokeCommand(command, args);
}

// Streams a live chat replay file from the backend one batch of lines at a time, so a long replay
// is never held as a single decompressed string on either side of the IPC boundary (the frontend
// keeps only the compact parsed messages). `onLines` runs for each batch as it arrives.
//
// The promise resolves only after the backend's terminal `done` message, not merely when the
// command returns. Channel messages and the invoke response travel independently, so resolving on
// the command return could race the last in-flight batch and drop its lines. It rejects (normalized
// through invokeCommand's parseAppError) if the read fails, in which case the caller discards any
// partial batches it already accumulated.
//
// Each channel message is validated against liveChatStreamEventSchema before it is acted on, so a
// backend bug that changed the wire shape (a batch line that is not a string) is dropped and logged
// at the seam rather than flowing into the parser as the wrong type.
export async function streamLiveChatFile(
    relativePath: string,
    onLines: (lines: string[]) => void
): Promise<void> {
    const channel = new Channel<LiveChatStreamEvent>();

    let signalDone: () => void = () => {};
    const done = new Promise<void>((resolve) => {
        signalDone = resolve;
    });

    channel.onmessage = (rawEvent) => {
        const event = parseEventPayload(
            liveChatStreamEventSchema,
            TAURI_COMMANDS.STREAM_LIVE_CHAT_FILE,
            rawEvent
        );

        if (!event) {
            return;
        }

        if (event.kind === "batch") {
            onLines(event.lines);
        } else {
            signalDone();
        }
    };

    await invokeCommand(TAURI_COMMANDS.STREAM_LIVE_CHAT_FILE, { relativePath, onBatch: channel });
    await done;
}

// Runs the deep library verification, reporting progress through `onProgress` and resolving with
// the report the backend sends on its terminal `done` message.
//
// The same two-phase shape as streamLiveChatFile, and for the same reason. Channel messages and the
// invoke response travel independently, so resolving when the command returns could race the last
// in-flight message. Here that would drop the report itself, since `done` is what carries it.
//
// Rejects when the command fails (a library path that is not the configured one, a verification
// already running), and also when the run ends without a `done` message, which would otherwise be
// an await that never settles and a dialog stuck on "verifying" forever.
export async function streamLibraryVerification(
    libraryPath: string,
    onProgress: (checked: number, total: number) => void
): Promise<ContentVerificationReport> {
    const channel = new Channel<ContentVerificationEvent>();

    let settle: (report: ContentVerificationReport) => void = () => {};
    let fail: (error: Error) => void = () => {};

    const done = new Promise<ContentVerificationReport>((resolve, reject) => {
        settle = resolve;
        fail = reject;
    });

    channel.onmessage = (rawEvent) => {
        const event = parseEventPayload(
            contentVerificationEventSchema,
            TAURI_COMMANDS.VERIFY_LIBRARY_CONTENT,
            rawEvent
        );

        if (!event) {
            // Unlike the live chat stream, a message this seam cannot validate ends the run here
            // rather than being dropped and logged. There the dropped message is one batch of lines
            // out of many; here it may be the terminal `done`, which is the only thing that carries
            // the report and the only thing that settles the promise below. Dropping it silently
            // would leave the caller awaiting forever, which reaches the user as a dialog stuck on
            // "verifying" with no error and no way back.
            fail(new Error("The verification reported a result this app could not read."));
            return;
        }

        if (event.kind === "progress") {
            onProgress(event.checked, event.total);
            return;
        }

        settle(event.report);
    };

    await invokeCommand(TAURI_COMMANDS.VERIFY_LIBRARY_CONTENT, { libraryPath, onProgress: channel });

    // Awaited after the invoke, not instead of it. Channel messages and the invoke response travel
    // independently, so resolving on the return could race the `done` that carries the report.
    return await done;
}

export async function listenTauri<TPayload>(
    eventName: string,
    handler: (event: Event<TPayload>) => void
): Promise<UnlistenFn> {
    return listen<TPayload>(eventName, handler);
}

// Like `listenTauri`, but validates each event's payload against `schema` before invoking the
// handler. A payload that does not match is dropped and logged (see parseEventPayload) rather than
// passed on as the wrong shape. The event-side counterpart to invokeCommand's result validation.
// The handler receives a payload already narrowed to the schema's type.
export async function listenValidated<TSchema extends z.ZodTypeAny>(
    eventName: string,
    schema: TSchema,
    handler: (payload: z.infer<TSchema>) => void
): Promise<UnlistenFn> {
    return listen<unknown>(eventName, (event) => {
        const payload = parseEventPayload(schema, eventName, event.payload);

        if (payload === null) {
            return;
        }

        handler(payload);
    });
}
