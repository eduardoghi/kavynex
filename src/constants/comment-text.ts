// The most characters a saved comment keeps. The backend cuts a longer body at this many scalar
// values when it stores it (MAX_COMMENT_TEXT_CHARS in src-tauri/src/services/media_comments.rs)
// and records nothing about having done so. What tells the player a comment was cut is its length
// reaching this number, so the two constants have to agree, and shared/comment-text-limit.json is
// what both sides assert against.
export const MAX_COMMENT_TEXT_CHARS = 16_000;
