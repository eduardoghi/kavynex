import type { LiveChatMessageItem } from "../../../services/live-chat-service";
import { RemoteImage } from "../remote-image";

// Shared props for the message-variant components (pinned/membership/super chat/regular).
export type LiveChatVariantProps = {
    message: LiveChatMessageItem;
    shellBorder: string;
    avatarSrc: string | undefined;
};

// Inline custom-emoji image. RemoteImage owns both the privacy gate (with remote images off, no
// request is made) and the load-failure fallback (these image URLs can expire) - in either case
// the emoji's shortcut text renders in its place.
export function EmojiImage({ url, label }: { url: string; label: string }): JSX.Element {
    return (
        <RemoteImage
            src={url}
            alt={label}
            title={label}
            fallback={label}
            style={{ height: "1.25em", verticalAlign: "-0.25em", margin: "0 1px" }}
        />
    );
}

export function renderMessageContent(message: LiveChatMessageItem): JSX.Element | string {
    if (message.message_parts.length === 0) {
        return message.message_text;
    }

    return (
        <>
            {message.message_parts.map((part, index) => {
                // The parts of a single message never reorder, but the same emoji or text can
                // repeat within one message, so key by position and content together rather than
                // by the bare array index.
                const key =
                    part.type === "emoji"
                        ? `${index}:emoji:${part.url}`
                        : `${index}:text:${part.text}`;

                return part.type === "emoji" ? (
                    <EmojiImage key={key} url={part.url} label={part.label} />
                ) : (
                    <span key={key}>{part.text}</span>
                );
            })}
        </>
    );
}
