// The single IPC seam: the only module that calls into our own Rust backend, wrapping Tauri's
// `invoke`/`listen` with consistent error normalization (parseAppError). Tauri's *platform*
// capabilities (dialogs, opener, process, updater, app version, asset URLs) live in the sibling
// `tauri-platform.ts`. Between them these two modules are the only files allowed to import
// `@tauri-apps` at all, enforced by eslint.config.js - see tauri-platform.ts for the rationale.
import { invoke } from "@tauri-apps/api/core";
import { listen, type Event, type UnlistenFn } from "@tauri-apps/api/event";
import type { TauriCommandName } from "../constants/tauri-commands";
import { parseAppError } from "../utils/app-error";

// Re-exported so an event subscriber can type its unsubscribe handle (and its handler payload)
// without reaching for `@tauri-apps/api/event` itself, which the boundary rule forbids.
export type { Event, UnlistenFn };

type InvokeArgs = Record<string, unknown> | undefined;

export async function invokeTauri<TResult>(
    command: TauriCommandName | string,
    args?: InvokeArgs
): Promise<TResult> {
    try {
        return await invoke<TResult>(command, args);
    } catch (error) {
        throw parseAppError(error);
    }
}

export async function invokeCommand<TResult>(
    command: TauriCommandName | string,
    args?: InvokeArgs
): Promise<TResult> {
    return invokeTauri<TResult>(command, args);
}

export async function invokeVoid(
    command: TauriCommandName | string,
    args?: InvokeArgs
): Promise<void> {
    await invokeTauri<null>(command, args);
}

export async function listenTauri<TPayload>(
    eventName: string,
    handler: (event: Event<TPayload>) => void
): Promise<UnlistenFn> {
    return listen<TPayload>(eventName, handler);
}
