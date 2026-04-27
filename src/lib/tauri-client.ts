import { invoke } from "@tauri-apps/api/core";
import { listen, type Event, type UnlistenFn } from "@tauri-apps/api/event";
import type { TauriCommandName, TauriEventName } from "../constants/tauri-commands";
import { parseAppError } from "../utils/app-error";

type InvokeArgs = Record<string, unknown> | undefined;

type LegacyInvokeInput = {
    command: TauriCommandName | string;
    args?: InvokeArgs;
};

function normalizeInvokeInput(
    commandOrInput: TauriCommandName | string | LegacyInvokeInput,
    args?: InvokeArgs
): {
    command: TauriCommandName | string;
    args?: InvokeArgs;
} {
    if (
        typeof commandOrInput === "object" &&
        commandOrInput !== null &&
        "command" in commandOrInput
    ) {
        return {
            command: commandOrInput.command,
            args: commandOrInput.args,
        };
    }

    return {
        command: commandOrInput,
        args,
    };
}

export async function invokeTauri<TResult>(
    commandOrInput: TauriCommandName | string | LegacyInvokeInput,
    args?: InvokeArgs
): Promise<TResult> {
    const normalized = normalizeInvokeInput(commandOrInput, args);

    try {
        return await invoke<TResult>(normalized.command, normalized.args);
    } catch (error) {
        throw parseAppError(error);
    }
}

export async function invokeCommand<TResult>(
    commandOrInput: TauriCommandName | string | LegacyInvokeInput,
    args?: InvokeArgs
): Promise<TResult> {
    return invokeTauri<TResult>(commandOrInput, args);
}

export async function invokeVoid(
    commandOrInput: TauriCommandName | string | LegacyInvokeInput,
    args?: InvokeArgs
): Promise<void> {
    await invokeTauri<null>(commandOrInput, args);
}

export async function listenTauri<TPayload>(
    eventName: TauriEventName | string,
    handler: (event: Event<TPayload>) => void
): Promise<UnlistenFn> {
    return listen<TPayload>(eventName, handler);
}

export function mapTauriErrorMessage(error: unknown, fallbackMessage: string): string {
    const parsed = parseAppError(error);

    if (parsed.message?.trim()) {
        return parsed.message.trim();
    }

    return fallbackMessage;
}