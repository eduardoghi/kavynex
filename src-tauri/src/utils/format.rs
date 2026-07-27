fn normalize_extension(value: &str) -> String {
    value.trim().trim_start_matches('.').to_lowercase()
}

pub fn media_subdir_from_extension(ext: &str) -> &'static str {
    match normalize_extension(ext).as_str() {
        "mp3" | "m4a" | "aac" | "wav" | "flac" | "ogg" | "opus" | "wma" | "alac" | "aiff" => {
            "audio"
        }
        _ => "video",
    }
}

pub fn is_allowed_media_extension(ext: &str) -> bool {
    matches!(
        normalize_extension(ext).as_str(),
        "mp4"
            | "mkv"
            | "webm"
            | "mov"
            | "avi"
            | "m4v"
            | "mpg"
            | "mpeg"
            | "wmv"
            | "flv"
            | "3gp"
            | "ts"
            | "m2ts"
            | "mp3"
            | "m4a"
            | "aac"
            | "wav"
            | "flac"
            | "ogg"
            | "opus"
            | "wma"
            | "alac"
            | "aiff"
    )
}

/// The image extensions a thumbnail may use. Raster formats only: `svg` is deliberately absent
/// because it can carry script and must never be authorized for the asset protocol.
///
/// Declared as a list rather than only spelled out inside the predicate below so the message shown
/// when a file is rejected can be built from it (see [`allowed_thumbnail_extensions_label`]). The
/// two had already drifted once - `gif` was accepted here while the message still named six formats
/// - which is the kind of mismatch that sends a user looking for a bug in their file.
pub const ALLOWED_THUMBNAIL_EXTENSIONS: [&str; 7] =
    ["png", "jpg", "jpeg", "webp", "bmp", "avif", "gif"];

pub fn is_allowed_thumbnail_extension(ext: &str) -> bool {
    ALLOWED_THUMBNAIL_EXTENSIONS.contains(&normalize_extension(ext).as_str())
}

/// The allowed thumbnail extensions as a comma-separated list, for the error a rejected file
/// produces. Derived from [`ALLOWED_THUMBNAIL_EXTENSIONS`] so a format added there cannot be left
/// out of what the user is told.
pub fn allowed_thumbnail_extensions_label() -> String {
    ALLOWED_THUMBNAIL_EXTENSIONS.join(", ")
}

pub fn codec_is_present(codec: &Option<String>) -> bool {
    codec
        .as_deref()
        .map(|value| {
            let normalized = value.trim().to_lowercase();
            !normalized.is_empty() && normalized != "none"
        })
        .unwrap_or(false)
}

pub fn normalize_yt_dlp_upload_date(upload_date: Option<String>) -> Option<String> {
    let value = upload_date?;
    let trimmed = value.trim();

    if trimmed.len() != 8 || !trimmed.chars().all(|ch| ch.is_ascii_digit()) {
        return None;
    }

    let year = &trimmed[0..4];
    let month = &trimmed[4..6];
    let day = &trimmed[6..8];

    Some(format!("{year}-{month}-{day}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn media_subdir_from_extension_detects_audio() {
        assert_eq!(media_subdir_from_extension("mp3"), "audio");
        assert_eq!(media_subdir_from_extension(".flac"), "audio");
        assert_eq!(media_subdir_from_extension("mp4"), "video");
    }

    #[test]
    fn is_allowed_media_extension_accepts_common_media_types() {
        assert!(is_allowed_media_extension("mp4"));
        assert!(is_allowed_media_extension(".mp3"));
        assert!(!is_allowed_media_extension("txt"));
    }

    #[test]
    fn is_allowed_thumbnail_extension_accepts_only_image_types() {
        // Driven off the constant rather than a second hand-written list, so a format added there
        // is covered here without anyone remembering to extend this.
        for ext in ALLOWED_THUMBNAIL_EXTENSIONS {
            assert!(is_allowed_thumbnail_extension(ext), "should allow {ext}");
        }

        // A leading dot and upper case normalize to the same entry.
        for ext in [".PNG", "JPG"] {
            assert!(is_allowed_thumbnail_extension(ext), "should allow {ext}");
        }

        // The allow_asset_file command uses this to decide what can be authorized for the asset
        // protocol, so a non-image extension must be rejected. svg stays rejected because it can
        // carry script; gif is accepted (a raster image, safe as an <img> source).
        for ext in ["txt", "exe", "mp4", "svg", ""] {
            assert!(!is_allowed_thumbnail_extension(ext), "should reject {ext}");
        }
    }

    #[test]
    fn allowed_thumbnail_extensions_label_names_every_accepted_format() {
        // What makes the rejection message unable to drift from the predicate again: the label has
        // to mention each extension the predicate accepts, so adding one without it appearing here
        // fails rather than silently telling the user a shorter list.
        let label = allowed_thumbnail_extensions_label();

        for ext in ALLOWED_THUMBNAIL_EXTENSIONS {
            assert!(
                label.contains(ext),
                "the rejection message should name {ext}, got: {label}"
            );
        }
    }

    #[test]
    fn normalize_yt_dlp_upload_date_returns_iso_date() {
        assert_eq!(
            normalize_yt_dlp_upload_date(Some("20260131".to_string())),
            Some("2026-01-31".to_string())
        );
    }

    #[test]
    fn normalize_yt_dlp_upload_date_rejects_invalid_value() {
        assert_eq!(
            normalize_yt_dlp_upload_date(Some("2026-01-31".to_string())),
            None
        );
        assert_eq!(normalize_yt_dlp_upload_date(Some("abc".to_string())), None);
    }
}
