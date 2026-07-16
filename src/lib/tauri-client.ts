// The single IPC seam: the only module that calls into our own Rust backend, wrapping Tauri's
// `invoke`/`listen` with consistent error normalization (parseAppError). Tauri's *platform*
// capabilities (dialogs, opener, process, updater, app version, asset URLs) live in the sibling
// `tauri-platform.ts`. Between them these two modules are the only files allowed to import
// `@tauri-apps` at all, enforced by eslint.config.js - see tauri-platform.ts for the rationale.
import { invoke } from "@tauri-apps/api/core";
import { listen, type Event, type UnlistenFn } from "@tauri-apps/api/event";
import type { TauriCommandName } from "../constants/tauri-commands";
import type { TauriCommandReturns } from "./tauri-command-returns";
import { parseAppError } from "../utils/app-error";

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
        return await invoke<TauriCommandReturns[K]>(command, args);
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

export async function listenTauri<TPayload>(
    eventName: string,
    handler: (event: Event<TPayload>) => void
): Promise<UnlistenFn> {
    return listen<TPayload>(eventName, handler);
}
