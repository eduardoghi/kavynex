import type { CSSProperties, ReactNode } from "react";
import { Anchor, Text } from "@mantine/core";
import { openAuthorYoutubeChannel } from "../../services/author-navigation";
import { activateOnEnterOrSpace } from "../../utils/keyboard";

type AuthorNameProps = {
    // The author's channel. Without one the name is plain text, since there is nowhere to go.
    channelId: string | null | undefined;
    fw: number;
    // The link's color. Plain text keeps the surrounding one.
    linkColor?: string;
    style?: CSSProperties;
    // Plain text as a span, inline with what follows, or as its own block.
    inline?: boolean;
    children: ReactNode;
};

/**
 * A comment's or a chat message's author, as a link to their channel on YouTube when the message
 * names one. The link answers Enter and Space as well as a click, so it works from the keyboard.
 */
export function AuthorName({
    channelId,
    fw,
    linkColor,
    style,
    inline = true,
    children,
}: AuthorNameProps): JSX.Element {
    if (channelId) {
        return (
            <Anchor
                fw={fw}
                size="sm"
                c={linkColor}
                role="button"
                tabIndex={0}
                title="Open channel on YouTube"
                style={{ cursor: "pointer", ...style }}
                onClick={() => void openAuthorYoutubeChannel(channelId)}
                onKeyDown={activateOnEnterOrSpace(() => void openAuthorYoutubeChannel(channelId))}
            >
                {children}
            </Anchor>
        );
    }

    return inline ? (
        <Text component="span" fw={fw} size="sm" style={style}>
            {children}
        </Text>
    ) : (
        <Text fw={fw} size="sm" style={style}>
            {children}
        </Text>
    );
}
