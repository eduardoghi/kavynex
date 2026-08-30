import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { MediaCommentRow } from "../../types/media";
import type { LiveChatMessageItem } from "../../services/live-chat-service";
import type { CommentTreeNode } from "./comment-tree";
import { CommentContent } from "./comment-content";
import { RemoteImage } from "./remote-image";
import { RemoteImagesProvider } from "./remote-images-context";
import { SafeAvatar } from "./safe-avatar";
import { SuperChatMessage } from "./live-chat-sections/super-chat-message";
import { renderWithMantine } from "../../test/test-utils";

const REMOTE_AVATAR = "https://yt3.ggpht.com/author-avatar.jpg";
const REMOTE_EMOJI = "https://yt3.ggpht.com/custom-emoji.png";
const REMOTE_STICKER = "https://lh3.googleusercontent.com/super-sticker.png";

function makeComment(overrides: Partial<MediaCommentRow> = {}): CommentTreeNode {
    return {
        id: 1,
        video_id: 1,
        comment_id: "c1",
        parent_comment_id: null,
        author_name: "Author",
        author_handle: "@author",
        author_channel_id: null,
        author_thumbnail: REMOTE_AVATAR,
        text: "hello",
        like_count: 0,
        reply_count: 0,
        is_author_uploader: 0,
        is_favorited: 0,
        is_pinned: 0,
        is_edited: 0,
        time_text: null,
        published_at: null,
        created_at: "2026-01-01T00:00:00Z",
        ...overrides,
        replies: [],
    };
}

function makeSticker(): LiveChatMessageItem {
    return {
        kind: "sticker",
        message_id: "s1",
        message_offset_ms: 1000,
        author_name: "Buyer",
        author_channel_id: null,
        author_thumbnail: REMOTE_AVATAR,
        author_badges: [],
        // Non-empty so the card renders its message body, which is what holds the custom emoji;
        // SuperChatMessage skips that block entirely for a bodyless sticker.
        message_text: ":custom:",
        message_parts: [{ type: "emoji", url: REMOTE_EMOJI, label: ":custom:" }],
        timestamp_text: null,
        amount_text: "R$ 10,00",
        superchat_body_color: null,
        superchat_text_color: null,
        sticker_image_url: REMOTE_STICKER,
        pinned_header: null,
    };
}

/** Every `<img>` in the document whose src points at a remote host. */
function externalImageSources(): string[] {
    return Array.from(document.querySelectorAll("img"))
        .map((image) => image.getAttribute("src") ?? "")
        .filter((src) => /^https?:\/\//i.test(src));
}

describe("RemoteImage", () => {
    it("renders nothing but the fallback while remote images are disabled", () => {
        renderWithMantine(
            <RemoteImagesProvider value={false}>
                <RemoteImage src={REMOTE_EMOJI} alt=":custom:" fallback=":custom:" />
            </RemoteImagesProvider>
        );

        expect(externalImageSources()).toEqual([]);
        expect(screen.getByText(":custom:")).toBeInTheDocument();
    });

    it("renders the image once remote images are enabled", () => {
        renderWithMantine(
            <RemoteImagesProvider value>
                <RemoteImage src={REMOTE_EMOJI} alt=":custom:" fallback=":custom:" />
            </RemoteImagesProvider>
        );

        expect(externalImageSources()).toEqual([REMOTE_EMOJI]);
    });

    it("fails closed when rendered outside a provider", () => {
        // The context defaults to false, so a component mounted somewhere that forgot the provider
        // must not load anything rather than quietly defaulting to "allowed".
        renderWithMantine(<RemoteImage src={REMOTE_EMOJI} alt=":custom:" fallback=":custom:" />);

        expect(externalImageSources()).toEqual([]);
    });

    it("ignores a src that is not an http(s) URL", () => {
        renderWithMantine(
            <RemoteImagesProvider value>
                <RemoteImage src="javascript:alert(1)" alt="x" fallback="x" />
            </RemoteImagesProvider>
        );

        expect(document.querySelectorAll("img")).toHaveLength(0);
        expect(screen.getByText("x")).toBeInTheDocument();
    });
});

describe("SafeAvatar", () => {
    it("drops a remote src while remote images are disabled and shows initials", () => {
        renderWithMantine(
            <RemoteImagesProvider value={false}>
                <SafeAvatar src={REMOTE_AVATAR} initials="AU" shellBorder="#000" size={36} />
            </RemoteImagesProvider>
        );

        expect(externalImageSources()).toEqual([]);
        expect(screen.getByText("AU")).toBeInTheDocument();
    });

    it("loads the avatar once remote images are enabled", () => {
        renderWithMantine(
            <RemoteImagesProvider value>
                <SafeAvatar src={REMOTE_AVATAR} initials="AU" shellBorder="#000" size={36} />
            </RemoteImagesProvider>
        );

        expect(externalImageSources()).toEqual([REMOTE_AVATAR]);
    });
});

describe("the remote image privacy gate", () => {
    // What this pins is the README's plain promise. With "Load comment and live chat images from
    // Google" off, viewing saved media makes no network requests at all. That used to rest on every
    // call site remembering to consult the context before rendering an <img>. A convention a
    // component added later could break while Settings still read "off". These assertions are over
    // the rendered DOM rather than over any one component, so a future remote <img> added anywhere
    // in this tree fails them regardless of how it was written.
    it("issues no external image request across a comment and a super sticker when disabled", () => {
        renderWithMantine(
            <RemoteImagesProvider value={false}>
                <CommentContent comment={makeComment()} shellBorder="#000" />
                <SuperChatMessage
                    message={makeSticker()}
                    shellBorder="#000"
                    avatarSrc={REMOTE_AVATAR}
                />
            </RemoteImagesProvider>
        );

        expect(externalImageSources()).toEqual([]);
        // The emoji degrades to its shortcut text rather than simply vanishing.
        expect(screen.getByText(":custom:")).toBeInTheDocument();
    });

    it("issues exactly the avatar, emoji and sticker requests when enabled", () => {
        renderWithMantine(
            <RemoteImagesProvider value>
                <CommentContent comment={makeComment()} shellBorder="#000" />
                <SuperChatMessage
                    message={makeSticker()}
                    shellBorder="#000"
                    avatarSrc={REMOTE_AVATAR}
                />
            </RemoteImagesProvider>
        );

        // Two avatars (the comment's and the sticker buyer's), the custom emoji, and the sticker.
        expect(externalImageSources().sort()).toEqual(
            [REMOTE_AVATAR, REMOTE_AVATAR, REMOTE_EMOJI, REMOTE_STICKER].sort()
        );
    });
});
