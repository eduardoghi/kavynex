import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderWithMantine } from "../../test/test-utils";
import { RemoteImagesProvider } from "./remote-images-context";
import { SafeAvatar } from "./safe-avatar";

const REMOTE_SRC = "https://yt3.ggpht.com/avatar.jpg";

function renderAvatar(remoteImagesEnabled: boolean | null, src: string | undefined): void {
    const avatar = <SafeAvatar src={src} initials="AB" shellBorder="#000" size={32} />;

    renderWithMantine(
        remoteImagesEnabled === null ? (
            avatar
        ) : (
            <RemoteImagesProvider value={remoteImagesEnabled}>{avatar}</RemoteImagesProvider>
        )
    );
}

// This component is the privacy gate for every author avatar in the player: PRIVACY.md promises
// that with remote images off, viewing saved media makes no network request, and it is this
// component (not the CSP) that delivers it. So the thing to pin is that no <img> is emitted at all
// when the setting is off, not merely that one is hidden.
describe("SafeAvatar", () => {
    it("renders the initials and no image when remote images are off", () => {
        renderAvatar(false, REMOTE_SRC);

        expect(screen.queryByRole("img")).not.toBeInTheDocument();
        expect(document.querySelector("img")).toBeNull();
        expect(screen.getByText("AB")).toBeInTheDocument();
    });

    it("fails closed outside a provider, the default being off", () => {
        // A SafeAvatar rendered somewhere the provider was forgotten must behave like "off",
        // which is what makes the gate a property of the component rather than of each caller.
        renderAvatar(null, REMOTE_SRC);

        expect(document.querySelector("img")).toBeNull();
        expect(screen.getByText("AB")).toBeInTheDocument();
    });

    it("loads the avatar only when remote images are on, without a referrer", () => {
        renderAvatar(true, REMOTE_SRC);

        const image = document.querySelector("img");
        expect(image).not.toBeNull();
        expect(image).toHaveAttribute("src", REMOTE_SRC);
        expect(image).toHaveAttribute("referrerpolicy", "no-referrer");
        // Decorative. The author name sits next to it, so the alt stays empty.
        expect(image).toHaveAttribute("alt", "");
    });

    it("falls back to the initials when the image fails to load", () => {
        renderAvatar(true, REMOTE_SRC);

        const image = document.querySelector("img");
        expect(image).not.toBeNull();

        if (image) {
            fireEvent.error(image);
        }

        expect(document.querySelector("img")).toBeNull();
        expect(screen.getByText("AB")).toBeInTheDocument();
    });

    it("renders the initials when there is no src even with remote images on", () => {
        renderAvatar(true, undefined);

        expect(document.querySelector("img")).toBeNull();
        expect(screen.getByText("AB")).toBeInTheDocument();
    });
});
