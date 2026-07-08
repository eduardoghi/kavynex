use crate::models::yt_dlp::{YtDlpFormatMetadata, YtDlpFormatOption};

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

fn format_filesize(bytes: Option<u64>) -> String {
    let Some(bytes) = bytes else {
        return "size unknown".to_string();
    };

    let kb = 1024_f64;
    let mb = kb * 1024_f64;
    let gb = mb * 1024_f64;
    let value = bytes as f64;

    if value >= gb {
        format!("{:.2} GB", value / gb)
    } else if value >= mb {
        format!("{:.2} MB", value / mb)
    } else if value >= kb {
        format!("{:.2} KB", value / kb)
    } else {
        format!("{} B", bytes)
    }
}

pub fn build_format_display_name(format: &YtDlpFormatMetadata, media_type: &str) -> String {
    let mut parts: Vec<String> = Vec::new();

    if let Some(resolution) = format
        .resolution
        .as_ref()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty() && *value != "audio only")
    {
        parts.push(resolution.to_string());
    } else if let Some(height) = format.height {
        parts.push(format!("{height}p"));
    }

    if let Some(format_note) = format
        .format_note
        .as_ref()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
    {
        parts.push(format_note.to_string());
    }

    if let Some(format_name) = format
        .format
        .as_ref()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
    {
        parts.push(format_name.to_string());
    }

    if media_type == "audio" {
        if let Some(abr) = format.abr {
            if abr > 0.0 {
                parts.push(format!("{:.0} kbps", abr));
            }
        }
    } else if let Some(fps) = format.fps {
        if fps > 0.0 {
            parts.push(format!("{:.0} fps", fps));
        }
    }

    if let Some(protocol) = format
        .protocol
        .as_ref()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
    {
        parts.push(protocol.to_string());
    }

    if let Some(ext) = format
        .ext
        .as_ref()
        .map(|value| value.trim().to_lowercase())
        .filter(|value| !value.is_empty())
    {
        parts.push(ext);
    }

    let size_label = format_filesize(format.filesize.or(format.filesize_approx));

    if parts.is_empty() {
        size_label
    } else {
        format!("{} • {}", parts.join(" • "), size_label)
    }
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

pub fn sort_yt_dlp_formats(formats: &mut [YtDlpFormatOption]) {
    formats.sort_by(|a, b| {
        let a_rank = match (a.has_video, a.has_audio) {
            (true, true) => 0,
            (true, false) => 1,
            (false, true) => 2,
            _ => 3,
        };

        let b_rank = match (b.has_video, b.has_audio) {
            (true, true) => 0,
            (true, false) => 1,
            (false, true) => 2,
            _ => 3,
        };

        a_rank
            .cmp(&b_rank)
            .then_with(|| b.height.unwrap_or(0).cmp(&a.height.unwrap_or(0)))
            .then_with(|| {
                b.filesize_bytes
                    .unwrap_or(0)
                    .cmp(&a.filesize_bytes.unwrap_or(0))
            })
            .then_with(|| a.display_name.cmp(&b.display_name))
    });
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
