//! Text normalization for the accent-insensitive media title search and sort.
//!
//! The library media list filters and sorts by title in the database now (server-side
//! pagination), so the title needs a form that compares without regard to accents or case.
//! `normalize_search_text` is applied to two things by the SAME function, which is what keeps
//! the search correct: the value stored in `videos.title_normalized` (written by
//! `insert_media`/`update_media_title` and backfilled by the schema migration), and the raw
//! search term the frontend sends. Because both sides go through this one function, a query for
//! "jose" matches a stored "José" without the frontend and backend having to agree on a shared
//! normalization spec.
//!
//! It mirrors the frontend's original `normalizeText` (`src/utils/media-library-filters.ts`):
//! NFD-decompose, drop combining diacritical marks (U+0300..=U+036F), collapse whitespace runs
//! to a single space, trim, and lowercase.

use unicode_normalization::UnicodeNormalization;

/// The Unicode combining diacritical marks block, stripped after NFD decomposition so an
/// accented letter (`é` -> `e` + U+0301) collapses to its base letter.
const COMBINING_MARKS: std::ops::RangeInclusive<char> = '\u{0300}'..='\u{036f}';

/// Normalizes a title (or a search term) to the accent- and case-insensitive form used for the
/// `title_normalized` column and the `LIKE` search. See the module docs for why both sides use
/// this exact function.
pub fn normalize_search_text(value: &str) -> String {
    let without_marks: String = value
        .nfd()
        .filter(|character| !COMBINING_MARKS.contains(character))
        .collect();

    // split_whitespace collapses runs of any Unicode whitespace and trims the ends in one pass,
    // matching the frontend's `.replace(/\s+/g, " ").trim()`.
    without_marks
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

/// Escapes the `LIKE` metacharacters (`\`, `%`, `_`) in `value` so a user search term is matched
/// literally rather than as a wildcard pattern. The paired query uses `LIKE ? ESCAPE '\'`.
pub fn escape_like_pattern(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());

    for character in value.chars() {
        if matches!(character, '\\' | '%' | '_') {
            escaped.push('\\');
        }

        escaped.push(character);
    }

    escaped
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_accents_and_lowercases() {
        assert_eq!(normalize_search_text("José"), "jose");
        assert_eq!(normalize_search_text("ÀÉÎÕÜ ção"), "aeiou cao");
        assert_eq!(normalize_search_text("Naïve Café"), "naive cafe");
    }

    #[test]
    fn collapses_whitespace_and_trims() {
        assert_eq!(normalize_search_text("  Hello   World  "), "hello world");
        assert_eq!(normalize_search_text("a\t\nb"), "a b");
    }

    #[test]
    fn a_stored_title_and_its_search_term_normalize_equal() {
        // The whole point: the stored column and the search term go through the same function,
        // so a plain-ASCII query matches an accented stored title.
        let stored = normalize_search_text("Café com Pão");
        let query = normalize_search_text("cafe com pao");
        assert_eq!(stored, query);
        assert!(stored.contains(&normalize_search_text("PÃO")));
    }

    #[test]
    fn empty_and_whitespace_only_normalize_to_empty() {
        assert_eq!(normalize_search_text(""), "");
        assert_eq!(normalize_search_text("   \t  "), "");
    }

    #[test]
    fn escapes_like_metacharacters() {
        assert_eq!(escape_like_pattern("100%"), "100\\%");
        assert_eq!(escape_like_pattern("a_b"), "a\\_b");
        assert_eq!(escape_like_pattern("back\\slash"), "back\\\\slash");
        assert_eq!(escape_like_pattern("plain"), "plain");
    }
}
