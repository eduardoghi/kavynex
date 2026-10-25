fn normalize_extension(value: &str) -> String {
    value.trim().trim_start_matches('.').to_lowercase()
}

/// The audio extensions the library recognizes. Drives both which managed subdirectory an import
/// lands in ([`media_subdir_from_extension`]) and half of what may be imported at all
/// ([`ALLOWED_MEDIA_EXTENSIONS`]), so the two cannot disagree about whether a `.opus` is audio.
pub const ALLOWED_AUDIO_EXTENSIONS: [&str; 10] = [
    "mp3", "m4a", "aac", "wav", "flac", "ogg", "opus", "wma", "alac", "aiff",
];

/// The video extensions the library recognizes.
pub const ALLOWED_VIDEO_EXTENSIONS: [&str; 13] = [
    "mp4", "mkv", "webm", "mov", "avi", "m4v", "mpg", "mpeg", "wmv", "flv", "3gp", "ts", "m2ts",
];

/// Every extension a local import may carry, video and audio together.
///
/// Declared as lists rather than only spelled out inside the predicate below for the same reason
/// [`ALLOWED_THUMBNAIL_EXTENSIONS`] is. The message a rejected file produces has to be built from
/// the same source that rejected it. The thumbnail pair had already drifted once (`gif` accepted
/// while the message named six formats), and this is the larger list of the two. What the user is
/// told here is the only place the app ever says which files it takes.
pub fn allowed_media_extensions() -> Vec<&'static str> {
    ALLOWED_VIDEO_EXTENSIONS
        .iter()
        .chain(ALLOWED_AUDIO_EXTENSIONS.iter())
        .copied()
        .collect()
}

/// The managed subdirectory an extension belongs in. Anything not recognized as audio is treated
/// as video, which is the fallback the import path relies on. `is_allowed_media_extension` is what
/// keeps an unrecognized extension from reaching here in the first place.
pub fn media_subdir_from_extension(ext: &str) -> &'static str {
    if ALLOWED_AUDIO_EXTENSIONS.contains(&normalize_extension(ext).as_str()) {
        return "audio";
    }

    "video"
}

pub fn is_allowed_media_extension(ext: &str) -> bool {
    let normalized = normalize_extension(ext);

    ALLOWED_VIDEO_EXTENSIONS.contains(&normalized.as_str())
        || ALLOWED_AUDIO_EXTENSIONS.contains(&normalized.as_str())
}

/// The allowed media extensions as a comma-separated list, for the error a rejected file produces.
/// Derived from the lists above so a format added to one cannot be left out of what the user is
/// told. The mirror of [`allowed_thumbnail_extensions_label`].
pub fn allowed_media_extensions_label() -> String {
    allowed_media_extensions().join(", ")
}

/// The image extensions a thumbnail may use. Raster formats only. `svg` is deliberately absent
/// because it can carry script and must never be authorized for the asset protocol.
///
/// Declared as a list rather than only spelled out inside the predicate below so the message shown
/// when a file is rejected can be built from it (see [`allowed_thumbnail_extensions_label`]). The
/// two had already drifted once. `gif` was accepted here while the message still named six formats,
/// which is the kind of mismatch that sends a user looking for a bug in their file.
pub const ALLOWED_THUMBNAIL_EXTENSIONS: [&str; 7] =
    ["png", "jpg", "jpeg", "webp", "bmp", "avif", "gif"];

/// A BMP file header. `BM` alone is two printable letters, so any text file starting with them
/// passed. The header also has four reserved bytes that are zero and the offset of the pixel data,
/// which comes after the 14-byte file header and a DIB header of at least 12.
fn looks_like_bmp(bytes: &[u8]) -> bool {
    if bytes.len() < 14 || !bytes.starts_with(b"BM") || bytes[6..10] != [0, 0, 0, 0] {
        return false;
    }

    let pixel_offset = u32::from_le_bytes([bytes[10], bytes[11], bytes[12], bytes[13]]);

    pixel_offset >= 26
}

/// Sniffs `bytes` against the magic numbers of the image formats this app accepts. The
/// Content-Type header on a direct thumbnail download is attacker-controlled (any server the
/// URL points to), so it is not sufficient on its own to prove the bytes are actually an
/// image before they are written to disk and later served from the library.
pub fn looks_like_supported_image(bytes: &[u8]) -> bool {
    const PNG_SIGNATURE: &[u8] = b"\x89PNG\r\n\x1a\n";
    const JPEG_SIGNATURE: &[u8] = b"\xFF\xD8\xFF";
    const GIF_SIGNATURE: &[u8] = b"GIF8";

    if bytes.starts_with(PNG_SIGNATURE)
        || bytes.starts_with(JPEG_SIGNATURE)
        || bytes.starts_with(GIF_SIGNATURE)
        || looks_like_bmp(bytes)
    {
        return true;
    }

    // WEBP. A RIFF container with a "WEBP" fourCC at offset 8.
    if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return true;
    }

    // AVIF. An ISOBMFF `ftyp` box (offset 4) whose brand (offset 8) is avif/avis.
    if bytes.len() >= 12
        && &bytes[4..8] == b"ftyp"
        && (&bytes[8..12] == b"avif" || &bytes[8..12] == b"avis")
    {
        return true;
    }

    false
}

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

/// Renders a byte count as a human-readable size (`0 B`, `10 B`, `1.00 KB`, `2.34 GB`).
///
/// Shared rather than defined per caller. The settings dialog shows the library size and the
/// database size next to each other, and two formatters that rounded or spelled units differently
/// would read as a bug in the numbers rather than as a formatting difference. Whole bytes below
/// 1 KB, two decimals above it.
pub fn format_bytes(bytes: u64) -> String {
    const UNITS: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];

    if bytes == 0 {
        return "0 B".to_string();
    }

    let mut value = bytes as f64;
    let mut unit_index = 0usize;

    while value >= 1024.0 && unit_index < UNITS.len() - 1 {
        value /= 1024.0;
        unit_index += 1;
    }

    if unit_index == 0 {
        format!("{} {}", bytes, UNITS[unit_index])
    } else {
        format!("{value:.2} {}", UNITS[unit_index])
    }
}

pub fn normalize_yt_dlp_upload_date(upload_date: Option<String>) -> Option<String> {
    let value = upload_date?;
    let trimmed = value.trim();

    if trimmed.len() != 8 || !trimmed.chars().all(|ch| ch.is_ascii_digit()) {
        return None;
    }

    // A date that does not exist (`20261399`, `00000000`) is dropped rather than stored. The column
    // is sorted as text, so a value like `2026-13-99` would sit among real dates in the wrong place.
    let date = chrono::NaiveDate::parse_from_str(trimmed, "%Y%m%d").ok()?;

    Some(date.format("%Y-%m-%d").to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn format_bytes_formats_values_consistently() {
        assert_eq!(format_bytes(0), "0 B");
        assert_eq!(format_bytes(10), "10 B");
        assert_eq!(format_bytes(1024), "1.00 KB");
        assert_eq!(format_bytes(1024 * 1024), "1.00 MB");
        assert_eq!(format_bytes(1024 * 1024 * 1024), "1.00 GB");
        // Saturates at the largest unit rather than inventing one past TB.
        assert_eq!(format_bytes(2 * 1024_u64.pow(5)), "2048.00 TB");
    }

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
    fn is_allowed_media_extension_accepts_every_listed_format() {
        // Driven off the constants rather than a second hand-written list, matching the thumbnail
        // test below. A format added to either list is covered here without anyone remembering to
        // extend this.
        for ext in allowed_media_extensions() {
            assert!(is_allowed_media_extension(ext), "should allow {ext}");
        }

        // A leading dot and upper case normalize to the same entry.
        for ext in [".MP4", "FLAC"] {
            assert!(is_allowed_media_extension(ext), "should allow {ext}");
        }
    }

    #[test]
    fn every_audio_extension_lands_in_the_audio_subdir_and_every_video_one_does_not() {
        // A second spelling of the audio list in media_subdir_from_extension would let the two
        // disagree about whether a `.opus` is audio. The file would be accepted for import and
        // then filed under video/. Deriving both from ALLOWED_AUDIO_EXTENSIONS is what prevents
        // that, and this is what pins it.
        for ext in ALLOWED_AUDIO_EXTENSIONS {
            assert_eq!(media_subdir_from_extension(ext), "audio", "{ext}");
        }

        for ext in ALLOWED_VIDEO_EXTENSIONS {
            assert_eq!(media_subdir_from_extension(ext), "video", "{ext}");
        }
    }

    #[test]
    fn allowed_media_extensions_label_names_every_accepted_format() {
        // The import rejection puts this label in the error's `details`, which the frontend appends
        // after its catalogued message, so this string is the only place the app ever tells a user
        // which files it takes. A format accepted but not named here is a user hunting for a bug in
        // their file.
        let label = allowed_media_extensions_label();

        for ext in allowed_media_extensions() {
            assert!(
                label.contains(ext),
                "the rejection message should name {ext}, got: {label}"
            );
        }
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
        // carry script, while gif is accepted (a raster image, safe as an <img> source).
        for ext in ["txt", "exe", "mp4", "svg", ""] {
            assert!(!is_allowed_thumbnail_extension(ext), "should reject {ext}");
        }
    }

    #[test]
    fn allowed_thumbnail_extensions_label_names_every_accepted_format() {
        // What makes the rejection message unable to drift from the predicate again. The label has
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
    fn a_bmp_header_cut_short_is_refused_without_reading_past_it() {
        for short in [&b"BM"[..], b"BM\0\0\0\0\0\0", b"BM\0\0\0\0\0\0\0\0\0\0\0"] {
            assert!(!looks_like_bmp(short), "{short:?}");
        }
    }

    #[test]
    fn an_upload_date_of_eight_characters_that_are_not_all_digits_is_dropped() {
        // Each one is eight characters long, so only the digit check can refuse it. chrono's own
        // parser would take a sign or a single-digit field.
        for value in ["+2026011", "2026 1 1", "202601+1"] {
            assert_eq!(
                normalize_yt_dlp_upload_date(Some(value.to_string())),
                None,
                "{value:?}"
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

    #[test]
    fn normalize_yt_dlp_upload_date_needs_both_halves_of_its_guard() {
        // Every value rejected above fails the length check *and* the digit check at once, so it
        // cannot tell an `||` from an `&&`. Both spellings reject it. These two fail exactly one
        // half each, which is the only arrangement where the two disagree.
        //
        // Eight characters, not all digits. With the guard weakened to `&&` this is accepted and
        // sliced positionally, producing the nonsense date "2026--1--1" on a row that would then
        // sort and display as though it were real.
        assert_eq!(
            normalize_yt_dlp_upload_date(Some("2026-1-1".to_string())),
            None
        );

        // All digits, fewer than eight. The guard holds the field to yt-dlp's exact YYYYMMDD before
        // chrono reads it, since chrono's own parser is more lenient about widths than this field
        // ever is. yt-dlp supplies the value, so it is not this app's to trust.
        assert_eq!(
            normalize_yt_dlp_upload_date(Some("202601".to_string())),
            None
        );
    }

    #[test]
    fn normalize_yt_dlp_upload_date_drops_a_date_that_does_not_exist() {
        for impossible in ["20261399", "00000000", "20260230", "20261301"] {
            assert_eq!(
                normalize_yt_dlp_upload_date(Some(impossible.to_string())),
                None,
                "{impossible}"
            );
        }

        assert_eq!(
            normalize_yt_dlp_upload_date(Some("20240229".to_string())),
            Some("2024-02-29".to_string())
        );
    }

    #[test]
    fn allowed_media_extensions_is_the_two_lists_and_is_never_empty() {
        // The two tests that walk this list (`is_allowed_media_extension_accepts_every_listed_format`
        // and `allowed_media_extensions_label_names_every_accepted_format`) both iterate it, so an
        // empty list satisfies them without executing a single assertion. That is the shape a
        // vacuous pass takes, and it left the one function the rejection message is built from
        // unpinned. Asserted against the constants rather than a hand-written list, so a format
        // added to either constant is covered here without anyone extending this test.
        let allowed = allowed_media_extensions();

        assert!(!allowed.is_empty());
        assert_eq!(
            allowed.len(),
            ALLOWED_VIDEO_EXTENSIONS.len() + ALLOWED_AUDIO_EXTENSIONS.len()
        );

        for ext in ALLOWED_VIDEO_EXTENSIONS
            .iter()
            .chain(ALLOWED_AUDIO_EXTENSIONS.iter())
        {
            assert!(allowed.contains(ext), "the list should carry {ext}");
        }
    }
}
