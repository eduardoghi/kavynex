export const UI_TEXT = {
    home: {
        emptyTitle: "Channel library",
        emptyDescription:
            "Create channels and add media manually. You can configure tools and diagnostics from settings.",
        loadingApp: "Loading application...",
        addMedia: "Add media",
        back: "Back",
        itemCountSuffix: "item(s)",
        emptyCards: {
            channels: {
                title: "1) Channels",
                description: "Organize content by channel.",
            },
            media: {
                title: "2) Media",
                description: "Import local files or download using yt-dlp.",
            },
            diagnostics: {
                title: "3) Diagnostics",
                description: "Check library setup, ffmpeg and yt-dlp status.",
            },
        },
    },

    library: {
        title: "Media",
        emptyTitle: "No media yet",
        emptyDescription:
            "Click Add media to register your first local file or imported item.",
        noResultsTitle: "No results found",
        noResultsDescription: "Try adjusting your search, filters, or sorting.",
        loading: "Loading media...",
        searchLabel: "Search by title",
        searchPlaceholder: "Type to search...",
        typeLabel: "Type",
        statusLabel: "Status",
        publicationDateLabel: "Publication date",
        sortLabel: "Sort by",
        showing: "Showing",
        of: "of",
        filters: {
            all: "All",
            video: "Video",
            audio: "Audio",
            watched: "Watched",
            unwatched: "Unwatched",
            withPublicationDate: "With publication date",
            withoutPublicationDate: "No publication date",
        },
        sortOptions: {
            recent: "Newest first",
            oldest: "Oldest first",
            title: "Title",
            duration: "Duration",
            comments: "Comments",
        },
        selected: "Selected",
        noPublicationDate: "No publication date",
        mediaTypeVideo: "Video",
        mediaTypeAudio: "Audio",
        watchedBadge: "Watched",
        delete: "Delete",
    },

    comments: {
        title: "Saved comments",
        none: "No saved comments for this media",
        savedWithMedia: "comment(s) saved with this media",
        sortLabel: "Sort by",
        searchLabel: "Search comments",
        searchPlaceholder: "Search by author, @handle, or text...",
        loading: "Loading comments...",
        noSearchResults: "No comments found for this search.",
        noCommentsAvailable:
            "This media was saved without comments, or no public comments were available at the time of import.",
        missingFromDatabase:
            "The media indicates saved comments, but none were found in the local database.",
        creator: "Creator",
        pinned: "Pinned",
        edited: "edited",
        hideReplies: "Hide replies",
        reply: "reply",
        replies: "replies",
        resultsShowing: "Showing",
        resultsFor: "result(s) for",
        sortOptions: {
            likes: "Most relevant",
            newest: "Newest first",
            oldest: "Oldest first",
        },
    },
} as const;
