import { useState } from "react";
import { Avatar } from "@mantine/core";

type SafeAvatarProps = {
    src?: string;
    initials: string;
    shellBorder: string;
    size: number;
};

export function SafeAvatar({
    src,
    initials,
    shellBorder,
    size,
}: SafeAvatarProps): JSX.Element {
    // Track which src the load failed for, not a bare boolean, so the fallback is cleared for a
    // new src synchronously during render. This is deliberately React's "adjust state directly
    // during render" pattern, matching media-card.tsx's thumbnail handling - NOT a useEffect. An
    // effect would render one frame with the stale failure (a flash of the initials fallback) for
    // an avatar that is actually valid, before resetting on the next commit.
    const [failedSrc, setFailedSrc] = useState<string | undefined>(undefined);

    if (failedSrc !== undefined && failedSrc !== src) {
        setFailedSrc(undefined);
    }

    const finalSrc = failedSrc === src ? undefined : src;

    return (
        <Avatar
            radius="xl"
            size={size}
            src={finalSrc}
            color="gray"
            imageProps={{
                referrerPolicy: "no-referrer",
                onError: () => setFailedSrc(src),
                // Decorative: the author name is always shown next to the avatar, so an empty
                // alt keeps screen readers from announcing the image URL/filename as content.
                alt: "",
            }}
            styles={{
                root: {
                    flex: "0 0 auto",
                    background: "rgba(255,255,255,0.06)",
                    border: `1px solid ${shellBorder}`,
                },
            }}
        >
            {!finalSrc ? initials : null}
        </Avatar>
    );
}