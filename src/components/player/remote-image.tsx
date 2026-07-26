import { useState, type CSSProperties, type ReactNode } from "react";
import { useRemoteImagesEnabled } from "./remote-images-context";

type RemoteImageProps = {
    // The remote URL. Anything that is not an http(s) URL is treated as absent, so a malformed or
    // relative value can never become a request.
    src: string | null | undefined;
    alt: string;
    title?: string;
    style?: CSSProperties;
    // Rendered instead of the image when remote images are disabled, the src is unusable, or the
    // load failed. Nothing by default (the sticker case); the emoji case passes its shortcut text.
    fallback?: ReactNode;
};

/**
 * The only component in the app that loads an image from a remote host.
 *
 * The privacy setting behind it ("Load comment and live chat images from Google",
 * `load_remote_images`, off by default) is a promise the README states plainly: with it off,
 * viewing saved media makes no network requests at all. That promise used to rest on every call
 * site remembering to consult `useRemoteImagesEnabled` before rendering an `<img>` - a convention,
 * not a barrier, and one a component added later would silently break while the setting still read
 * as "off" in Settings.
 *
 * Consolidating the check here (and in `SafeAvatar`, the other leaf that can hold a remote src)
 * makes the gate structural: a caller cannot forget it, because a caller no longer performs it.
 * `remote-images-context` defaults to `false`, so a consumer rendered outside the provider fails
 * closed rather than leaking a load.
 */
export function RemoteImage({
    src,
    alt,
    title,
    style,
    fallback = null,
}: RemoteImageProps): JSX.Element {
    // Track the src the load failed for rather than a bare boolean, so a new src clears the
    // fallback during render instead of one frame later - the same pattern SafeAvatar uses.
    const [failedSrc, setFailedSrc] = useState<string | null>(null);
    const remoteImagesEnabled = useRemoteImagesEnabled();

    const normalized = src?.trim() ?? "";
    const usableSrc = /^https?:\/\//i.test(normalized) ? normalized : null;

    if (failedSrc !== null && failedSrc !== usableSrc) {
        setFailedSrc(null);
    }

    if (!remoteImagesEnabled || !usableSrc || failedSrc === usableSrc) {
        return <>{fallback}</>;
    }

    return (
        <img
            src={usableSrc}
            alt={alt}
            title={title}
            loading="lazy"
            // The request must not carry where in the app it came from.
            referrerPolicy="no-referrer"
            onError={() => setFailedSrc(usableSrc)}
            style={style}
        />
    );
}
