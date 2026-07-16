
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

pub fn is_allowed_thumbnail_extension(ext: &str) -> bool {
    matches!(
        normalize_extension(ext).as_str(),
        "png" | "jpg" | "jpeg" | "webp" | "bmp" | "avif"
    )
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
        // The allow_asset_file command uses this to decide what can be authorized for the
        // asset protocol, so a non-image extension must be rejected.
        for ext in ["png", "jpg", "jpeg", "webp", "bmp", "avif", ".PNG", "JPG"] {
            assert!(is_allowed_thumbnail_extension(ext), "should allow {ext}");
        }

        for ext in ["txt", "exe", "mp4", "svg", "gif", ""] {
            assert!(!is_allowed_thumbnail_extension(ext), "should reject {ext}");
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
