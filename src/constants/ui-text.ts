export const UI_TEXT = {
    home: {
        emptyTitle: "No channels yet",
        // Two descriptions because a first run has two states, not two screens. Until a folder is
        // picked the sentence names both steps in the order they happen. Once it is, the folder
        // belongs to Settings and saying anything about it here would be noise.
        emptyDescription: "Add a YouTube channel to start backing up its media.",
        emptyDescriptionNeedsLibrary:
            "Choose a library folder, then add a YouTube channel to start backing up its media.",
        // The same words the sidebar's add button and the modal's own title use, rather than a
        // phrase written for onboarding alone. The button here opens that modal.
        emptyAction: "New channel",
        loadingApp: "Loading your library",
        selectChannelPrompt: "Select a channel from the sidebar to see its library.",
        // A line of state, not an instruction. The description above already says what to do, and
        // this says what the app currently has. What the folder holds, a library on a drive that is
        // not connected, pointing at the same folder again, all belong to Settings > Library folder
        // and docs/TROUBLESHOOTING.md rather than to a first-run screen.
        librarySetupTitle: "Library folder not configured",
        librarySetupAction: "Choose library folder",
        librarySetupInProgress: "Setting up",
        addMedia: "Add media",
        back: "Back",
    },

    library: {
        title: "Media",
        emptyTitle: "No media yet",
        emptyDescription:
            "Click Add media to register your first local file or imported item.",
        noResultsTitle: "No results found",
        noResultsDescription: "Try adjusting your search, filters, or sorting.",
        loading: "Loading media",
        loadingMore: "Loading more",
        searchLabel: "Search by title",
        searchPlaceholder: "Search titles",
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
            publicationDate: "Publication date",
            addedDate: "Added date",
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

    player: {
        errorBoundaryTitle: "The player ran into a problem",
        errorBoundaryDescription:
            "This media could not be displayed. The rest of your library is unaffected. You can close the player and try another item. The details were saved to the application log.",
        errorBoundaryClose: "Close player",
    },

    comments: {
        title: "Saved comments",
        none: "No saved comments for this media",
        savedWithMedia: "saved with this media",
        sortLabel: "Sort by",
        searchLabel: "Search comments",
        searchPlaceholder: "Search by author, @handle, or text",
        loading: "Loading comments",
        noSearchResults: "No comments found for this search.",
        noCommentsAvailable:
            "This media was saved without comments, or no public comments were available at the time of import.",
        missingFromDatabase:
            "The media indicates saved comments, but none were found in the local database.",
        fetchComments: "Fetch comments",
        // Shown instead of the Fetch button once a fetch has run and come back with nothing.
        // Worded as what was observed rather than as a claim about the video. yt-dlp reports a
        // comment count and no separate "comments are off" flag, so telling a video with
        // comments disabled from one that simply has none would be a guess presented as fact.
        noneToSave:
            "Kavynex checked and YouTube returned no comments for this media, so there is nothing to save.",
        fetchCommentsHint:
            "If this media was added but its comment backup was interrupted, you can fetch them now.",
        creator: "Creator",
        pinned: "Pinned",
        edited: "edited",
        // Shown under a comment whose body the backend cut at its ceiling when it was saved. The
        // ceiling itself is appended by the component from the shared constant.
        truncatedNote: "Truncated when it was saved",
        hideReplies: "Hide replies",
        reply: "reply",
        replies: "replies",
        resultsShowing: "Showing",
        resultsFor: "for",
        contextLabel: "Context",
        loadMore: "Load more comments",
        truncatedNoticePrefix: "Showing the first",
        truncatedNoticeMiddle: "of",
        truncatedNoticeSuffix: "saved comments; the rest are not loaded here.",
        sortOptions: {
            likes: "Most relevant",
            newest: "Newest first",
            oldest: "Oldest first",
        },
    },
} as const;
