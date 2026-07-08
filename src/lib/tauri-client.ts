import { invoke } from "@tauri-apps/api/core";
import { listen, type Event, type UnlistenFn } from "@tauri-apps/api/event";
import type { TauriCommandName } from "../constants/tauri-commands";
import { parseAppError } from "../utils/app-error";

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
