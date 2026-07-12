import { useEffect, useState } from "react";
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
    const [imageFailed, setImageFailed] = useState(false);

    useEffect(() => {
        setImageFailed(false);
    }, [src]);

    const finalSrc = imageFailed ? undefined : src;

    return (
        <Avatar
            radius="xl"
            size={size}
            src={finalSrc}
            color="gray"
            imageProps={{
                referrerPolicy: "no-referrer",
                onError: () => setImageFailed(true),
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