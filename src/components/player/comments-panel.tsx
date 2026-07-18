import { useEffect, useMemo, useState } from "react";
import {
    ActionIcon,
    Box,
    Button,
    Divider,
    Group,
    Paper,
    Select,
    Stack,
    Text,
    TextInput,
    rem,
} from "@mantine/core";
import { useDebouncedValue } from "@mantine/hooks";
import { MessageCircle, RefreshCw, Search, X } from "lucide-react";
import { UI_TEXT } from "../../constants/ui-text";
import type { MediaCommentRow } from "../../types/media";
import { AsyncStatusRegion } from "../common/async-status-region";
import { CommentItem } from "./comment-item";
import {
    buildCommentTree,
    countCommentsInTree,
    filterCommentTree,
    normalizeSearchValue,
    sortCommentTree,
    type CommentSortMode,
} from "./comment-tree";
import { toUnionValue } from "../../utils/guards";

// Cap how many top-level comment threads are mounted at once so media with thousands of
// comments does not build an unbounded DOM. More threads are revealed on demand.
const INITIAL_VISIBLE_THREADS = 30;
const LOAD_MORE_STEP = 30;

// Debounce the search before it drives the (whole-tree) filter, so typing in media with
// thousands of comments does not re-walk the tree on every keystroke. The input itself stays
// controlled and responsive.
const COMMENT_SEARCH_DEBOUNCE_MS = 200;

type CommentsPanelProps = {
    comments: MediaCommentRow[];
    hasComments: boolean;
    commentsCount?: number | null;
    isLoadingComments: boolean;
    // A user-facing message when the saved comments could not be read. When set, the panel shows
    // it instead of the empty/"missing from database" states, so a transient read failure is not
    // reported to the user as if the media simply had no comments.
    error?: string | null;
    shellBorder: string;
    // Whether this media can (re)fetch comments from YouTube - true for a media with a YouTube
    // source. Offered in the empty state so a media whose comment backup was interrupted (a crash
    // between registering the media and saving its comments) can be recovered where the absence is
    // noticed, rather than only from the header's "Refresh comments" button.
    canFetchComments?: boolean;
    isFetchingComments?: boolean;
    onFetchComments?: () => void | Promise<void>;
};

export function CommentsPanel({
    comments,
    hasComments,
    commentsCount,
    isLoadingComments,
    error = null,
    shellBorder,
    canFetchComments = false,
    isFetchingComments = false,
    onFetchComments,
}: CommentsPanelProps): JSX.Element {
    const [commentSortMode, setCommentSortMode] = useState<CommentSortMode>("likes");
    const [commentSearchValue, setCommentSearchValue] = useState("");
    const [debouncedCommentSearch] = useDebouncedValue(
        commentSearchValue,
        COMMENT_SEARCH_DEBOUNCE_MS
    );

    // Build the thread structure once per comment set, then sort separately: linking (the id map
    // and per-node cycle check) depends only on `comments`, so toggling the sort re-sorts without
    // re-linking the whole tree - which matters for media with a large saved comment history.
    const commentThreads = useMemo(() => buildCommentTree(comments), [comments]);

    const commentTree = useMemo(
        () => sortCommentTree(commentThreads, commentSortMode),
        [commentThreads, commentSortMode]
    );

    const normalizedCommentSearch = useMemo(
        () => normalizeSearchValue(debouncedCommentSearch),
        [debouncedCommentSearch]
    );

    const filteredCommentTree = useMemo(
        () => filterCommentTree(commentTree, normalizedCommentSearch),
        [commentTree, normalizedCommentSearch]
    );

    const filteredCommentsCount = useMemo(
        () => countCommentsInTree(filteredCommentTree),
        [filteredCommentTree]
    );

    const [visibleThreadCount, setVisibleThreadCount] = useState(INITIAL_VISIBLE_THREADS);

    // Reset the visible window whenever the result set changes (new media, sort, search).
    useEffect(() => {
        setVisibleThreadCount(INITIAL_VISIBLE_THREADS);
    }, [comments, commentSortMode, normalizedCommentSearch]);

    const visibleCommentTree = useMemo(
        () => filteredCommentTree.slice(0, visibleThreadCount),
        [filteredCommentTree, visibleThreadCount]
    );

    const remainingThreadCount = filteredCommentTree.length - visibleCommentTree.length;

    // The backend caps how many comments a single media loads at once (a defensive ceiling for a
    // pathologically large backup). comments_count is the number of rows actually stored, so fewer
    // loaded than that means the cap truncated the set - surface it rather than letting search and
    // the thread list silently cover only part of what is saved.
    const isCommentLoadTruncated =
        commentsCount != null && comments.length < commentsCount;

    return (
        <Paper
            withBorder
            radius="xl"
            p="lg"
            style={{
                borderColor: shellBorder,
                background:
                    "linear-gradient(180deg, rgba(255,255,255,0.03), rgba(255,255,255,0.015))",
            }}
        >
            <Stack gap="lg">
                <Group justify="space-between" align="center" wrap="wrap">
                    <Group gap="sm" wrap="nowrap">
                        <Box
                            style={{
                                width: rem(40),
                                height: rem(40),
                                borderRadius: rem(14),
                                display: "grid",
                                placeItems: "center",
                                background: "rgba(139,92,246,0.12)",
                                border: `1px solid ${shellBorder}`,
                                flex: "0 0 auto",
                            }}
                        >
                            <MessageCircle size={18} />
                        </Box>

                        <Box style={{ minWidth: 0, flex: 1 }}>
                            <Text fw={900}>{UI_TEXT.comments.title}</Text>
                            <Text size="sm" c="dimmed">
                                {hasComments
                                    ? `${commentsCount ?? comments.length} ${UI_TEXT.comments.savedWithMedia}`
                                    : UI_TEXT.comments.none}
                            </Text>
                            {isCommentLoadTruncated && (
                                <Text size="xs" c="dimmed" role="status">
                                    {UI_TEXT.comments.truncatedNoticePrefix}{" "}
                                    {comments.length.toLocaleString()}{" "}
                                    {UI_TEXT.comments.truncatedNoticeMiddle}{" "}
                                    {(commentsCount ?? 0).toLocaleString()}{" "}
                                    {UI_TEXT.comments.truncatedNoticeSuffix}
                                </Text>
                            )}
                        </Box>
                    </Group>

                    {hasComments && comments.length > 0 && (
                        <Select
                            label={UI_TEXT.comments.sortLabel}
                            value={commentSortMode}
                            onChange={(value) =>
                                setCommentSortMode(
                                    toUnionValue(
                                        value,
                                        ["likes", "newest", "oldest"] as const,
                                        "likes"
                                    )
                                )
                            }
                            data={[
                                { value: "likes", label: UI_TEXT.comments.sortOptions.likes },
                                { value: "newest", label: UI_TEXT.comments.sortOptions.newest },
                                { value: "oldest", label: UI_TEXT.comments.sortOptions.oldest },
                            ]}
                            w={220}
                        />
                    )}
                </Group>

                {hasComments && comments.length > 0 && (
                    <Stack gap="xs">
                        <TextInput
                            label={UI_TEXT.comments.searchLabel}
                            placeholder={UI_TEXT.comments.searchPlaceholder}
                            value={commentSearchValue}
                            onChange={(event) => setCommentSearchValue(event.currentTarget.value)}
                            leftSection={<Search size={16} />}
                            rightSection={
                                commentSearchValue.trim() ? (
                                    <ActionIcon
                                        variant="subtle"
                                        aria-label="Clear comment search"
                                        onClick={() => setCommentSearchValue("")}
                                    >
                                        <X size={16} />
                                    </ActionIcon>
                                ) : undefined
                            }
                        />

                        {normalizedCommentSearch && (
                            <Text size="sm" c="dimmed" role="status" aria-live="polite">
                                {UI_TEXT.comments.resultsShowing} {filteredCommentsCount}{" "}
                                {UI_TEXT.comments.resultsFor} “{commentSearchValue.trim()}”
                            </Text>
                        )}
                    </Stack>
                )}

                <Divider color={shellBorder} />

                <AsyncStatusRegion
                    loading={isLoadingComments}
                    loadingMessage={UI_TEXT.comments.loading}
                    error={error}
                >
                    {!isLoadingComments && !error && !hasComments && (
                        <Text size="sm" c="dimmed">
                            {UI_TEXT.comments.noCommentsAvailable}
                        </Text>
                    )}

                    {!isLoadingComments && !error && hasComments && comments.length === 0 && (
                        <Text size="sm" c="dimmed">
                            {UI_TEXT.comments.missingFromDatabase}
                        </Text>
                    )}

                    {!isLoadingComments &&
                        comments.length === 0 &&
                        canFetchComments &&
                        onFetchComments && (
                            <Stack gap="xs" mt="sm">
                                <Text size="xs" c="dimmed">
                                    {UI_TEXT.comments.fetchCommentsHint}
                                </Text>
                                <Button
                                    variant="light"
                                    color="violet"
                                    leftSection={<RefreshCw size={16} />}
                                    loading={isFetchingComments}
                                    onClick={() => void onFetchComments()}
                                    style={{ alignSelf: "flex-start" }}
                                >
                                    {UI_TEXT.comments.fetchComments}
                                </Button>
                            </Stack>
                        )}

                    {!isLoadingComments &&
                        comments.length > 0 &&
                        filteredCommentTree.length === 0 && (
                            <Text size="sm" c="dimmed">
                                {UI_TEXT.comments.noSearchResults}
                            </Text>
                        )}
                </AsyncStatusRegion>

                {!isLoadingComments && filteredCommentTree.length > 0 && (
                    <Stack gap="lg">
                        {visibleCommentTree.map((comment) => (
                            <CommentItem
                                key={`${comment.id}-${comment.comment_id ?? "comment"}`}
                                comment={comment}
                                shellBorder={shellBorder}
                                forceExpandReplies={Boolean(normalizedCommentSearch)}
                            />
                        ))}

                        {remainingThreadCount > 0 && (
                            <Button
                                variant="light"
                                color="gray"
                                onClick={() =>
                                    setVisibleThreadCount((current) => current + LOAD_MORE_STEP)
                                }
                            >
                                {UI_TEXT.comments.loadMore} ({remainingThreadCount})
                            </Button>
                        )}
                    </Stack>
                )}
            </Stack>
        </Paper>
    );
}