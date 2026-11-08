//! Turning what yt-dlp reports into names a file can safely carry.

pub(super) type NormalizedDownloadMetadata =
    (String, String, String, Option<String>, Option<String>);

pub fn sanitize_filename_component(value: &str) -> String {
    let sanitized: String = value
        .trim()
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '.' || ch == '_' || ch == '-' {
                ch
            } else {
                '_'
            }
        })
        .collect();

    let compact = sanitized
        .split('_')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("_");

    if compact.is_empty() {
        return "media".to_string();
    }

    // A component made only of dots ('.', '..', ...) is path-significant. As a bare path segment it
    // means the current/parent directory. Every current call site concatenates this into a longer
    // string rather than using it as a lone `Path` component, so no traversal is reachable today,
    // but returning it verbatim would make any future `dir.join(sanitize_filename_component(x))` a
    // traversal. Map it to the same neutral placeholder as the empty case. Defense in depth,
    // mirroring the leading-dash and reserved-name guards below.
    if compact.chars().all(|ch| ch == '.') {
        return "media".to_string();
    }

    // yt-dlp reads a leading '-' as an option, so a component that sanitizes to one starting with
    // '-' is prefixed with '_'. Rare (extractor/id come from yt-dlp's own extractor, not free-form
    // text), but this mirrors the leading-dash guard in yt_dlp::download::is_valid_format_id and
    // keeps the value safe wherever the resulting file_prefix feeds an argv position.
    let guarded = if compact.starts_with('-') {
        format!("_{compact}")
    } else {
        compact
    };

    // A component that sanitizes to a Windows reserved device name (CON, NUL, COM1, ...) would make
    // the resulting file unusable on Windows. In practice the download filename joins three such
    // components as extractor_id_formatid, so a bare reserved stem is not normally reachable, but
    // prefix it with '_' as defense in depth, mirroring the leading-dash guard above and the
    // reserved-name rejection in utils::path::sanitize_relative_path_strict.
    if crate::utils::path::is_windows_reserved_name(&guarded) {
        format!("_{guarded}")
    } else {
        guarded
    }
}

/// Sanitizes the value that identifies the downloaded media (the video id) for use in a
/// filename, disambiguating collisions. `sanitize_filename_component` maps every character
/// outside `[A-Za-z0-9._-]` to `_` and collapses runs of `_`, so two distinct ids can map to the
/// same string (e.g. `a__b` and `a_b` both become `a_b`, or a future non-YouTube id containing
/// `:`/`/`). The download filename is derived from this and `place_downloaded_file` never
/// overwrites an existing destination, so a collision would silently discard the second video.
///
/// When sanitization actually changes the value, a short hash of the ORIGINAL is appended so
/// distinct ids get distinct filenames. A value that survives sanitization unchanged (the
/// overwhelming majority of YouTube ids) keeps its exact name, so filenames of already
/// downloaded media are unaffected.
pub fn sanitize_identifier_component(value: &str) -> String {
    let trimmed = value.trim();
    let sanitized = sanitize_filename_component(trimmed);

    if trimmed.is_empty() || sanitized == trimmed {
        return sanitized;
    }

    format!("{sanitized}_{}", short_identifier_hash(trimmed))
}

/// First 10 lowercase-hex chars (40 bits) of the SHA-256 of `value`. Enough to disambiguate the
/// handful of ids that could share a sanitized form, without bloating the filename.
pub(super) fn short_identifier_hash(value: &str) -> String {
    use sha2::{Digest, Sha256};

    crate::utils::hash::hex_encode(&Sha256::digest(value.as_bytes())[..5])
}
