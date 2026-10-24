use std::fs;
use std::path::{Component, Path, PathBuf};

use crate::{AppError, AppErrorCode, AppResult};

pub fn extension_from_path(path: &Path) -> String {
    path.extension()
        .and_then(|value| value.to_str())
        .map(|value| value.trim().trim_start_matches('.').to_lowercase())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "bin".to_string())
}

/// True for a character Windows accepts as the ordinal of a `COM<n>`/`LPT<n>` device name.
///
/// The ASCII digits are the obvious half. The superscripts `\u{b9}`, `\u{b2}` and `\u{b3}` are the
/// half that is easy to miss: Windows resolves `COM\u{b9}` to the same device as `COM1`, so a check
/// accepting only ASCII lets those three spellings through as ordinary names. Written as escapes
/// rather than as the characters themselves, matching the convention this repository already applies
/// to a codepoint used as data.
///
/// Nothing this app writes can produce one (every managed path is content-addressed), so this is
/// defense in depth for a name that arrives from an out-of-band writer or an imported database, in
/// the same spirit as the rest of `sanitize_relative_path_strict`.
fn is_device_ordinal(value: char) -> bool {
    value.is_ascii_digit() || matches!(value, '\u{b9}' | '\u{b2}' | '\u{b3}')
}

/// True for a segment that names a Windows reserved device (CON, PRN, AUX, NUL, COM0-9,
/// LPT0-9, plus the superscript `COM`/`LPT` ordinals, see [`is_device_ordinal`]), with or
/// without an extension. Windows treats `CON`, `CON.txt`, etc. as the device.
/// Checked on every platform so a library synced from Windows behaves the same everywhere.
pub(crate) fn is_windows_reserved_name(segment: &str) -> bool {
    let stem = segment.split('.').next().unwrap_or(segment).trim();

    if matches!(
        stem.to_ascii_uppercase().as_str(),
        "CON" | "PRN" | "AUX" | "NUL"
    ) {
        return true;
    }

    let chars: Vec<char> = stem.chars().collect();

    if chars.len() == 4 {
        let head: String = chars[..3].iter().collect::<String>().to_ascii_uppercase();

        if (head == "COM" || head == "LPT") && is_device_ordinal(chars[3]) {
            return true;
        }
    }

    false
}

/// True for a UNC / network location (`\\host\share`, `//host/share`, the verbatim UNC form
/// `\\?\UNC\...`, and the mixed-separator spellings `/\host\share` / `\/host\share` that Windows
/// also resolves to a UNC path). Merely canonicalizing or opening one of these on Windows makes
/// the OS reach out to `host` over SMB and authenticate, leaking the user's NTLM hash to whoever
/// controls that host, so callers must reject network paths *before* any filesystem call
/// (`canonicalize`, `exists`, `read_dir`, `create_dir_all`) touches them.
///
/// Separators are normalized to `\` first so a mixed spelling cannot slip past a literal prefix
/// match (`/\host\share` and `\/host\share` both resolve to `\\host\share` on Windows). Checked on
/// every platform so a library synced from Windows behaves the same everywhere.
///
/// Behind the namespace prefixes (`\\?\`, `\\.\`, and the NT `\??\` that Win32 passes through),
/// only a drive (`\\?\C:\...`) or a volume GUID is treated as local. The rest of that namespace is
/// not just `UNC\`. `GLOBALROOT\Device\Mup\host\share` and the redirector devices reach a remote
/// host as well, so matching `UNC\` alone left those spellings past every caller. No path the app
/// handles needs a device name, which is why the others (`\\.\PhysicalDrive0` among them) are
/// refused along with the shares rather than listed one by one.
///
/// A drive is local only without `.`/`..` components. Win32 normalizes a `\\.\` path and treats
/// its drive as an ordinary component, so `\\.\C:\..\UNC\host\share` resolves to the share. Any
/// component made only of dots and spaces is refused, since trailing dots and spaces are trimmed
/// in that same normalization (`.. ` is `..`).
pub fn is_network_path(value: &str) -> bool {
    let normalized = value.trim_start().replace('/', "\\");

    for prefix in NAMESPACE_PREFIXES {
        if let Some(rest) = normalized.strip_prefix(prefix) {
            return !names_a_local_volume(rest) || has_dot_component(rest);
        }
    }

    normalized.starts_with(r"\\")
}

/// The Win32 namespace prefixes. None is a prefix of another, so their order does not matter.
const NAMESPACE_PREFIXES: [&str; 3] = [r"\\?\", r"\\.\", r"\??\"];

/// True when a component is only dots and spaces (`.`, `..`, `.. `), which Win32 normalization
/// turns into a step up or nothing.
fn has_dot_component(rest: &str) -> bool {
    rest.split('\\').any(|component| {
        !component.is_empty() && component.chars().all(|ch| ch == '.' || ch == ' ')
    })
}

/// True when what follows a namespace prefix is a drive (`C:` or `C:\...`) or a volume GUID.
fn names_a_local_volume(rest: &str) -> bool {
    let bytes = rest.as_bytes();
    let is_drive = bytes.len() >= 2
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes.len() == 2 || bytes[2] == b'\\');

    is_drive
        || rest
            .get(..7)
            .is_some_and(|head| head.eq_ignore_ascii_case("Volume{"))
}

/// The `\\host\share` prefix of a network path, lowercased and with separators normalized, or
/// `None` when `value` is not a network path or names a host without a share.
///
/// Two network paths with different prefixes cannot name the same location, and telling them
/// apart textually is what lets a caller refuse one *before* a `canonicalize` that would
/// authenticate to the host it names. Lowercased because SMB host and share names are
/// case-insensitive, so `\\NAS\Videos` and `\\nas\videos` are one share and must compare equal
/// rather than be refused as different.
pub fn network_share_prefix(value: &str) -> Option<String> {
    if !is_network_path(value) {
        return None;
    }

    let normalized = value.trim().replace('/', "\\");
    let namespaced = NAMESPACE_PREFIXES
        .iter()
        .find_map(|prefix| normalized.strip_prefix(prefix));
    let rest = match namespaced {
        // Only the `UNC\` form names a share textually. A `GLOBALROOT` or redirector spelling has
        // none, so it matches no other path and stays refused.
        Some(namespaced) => match namespaced.get(..4) {
            Some(head) if head.eq_ignore_ascii_case(r"UNC\") => &namespaced[4..],
            _ => return None,
        },
        None => &normalized[2..],
    };
    let mut components = rest.split('\\').filter(|component| !component.is_empty());
    let host = components.next()?;
    let share = components.next()?;

    Some(format!(
        r"\\{}\{}",
        host.to_lowercase(),
        share.to_lowercase()
    ))
}

pub fn sanitize_relative_path_strict(value: &str) -> AppResult<PathBuf> {
    let trimmed = value.trim();

    if trimmed.is_empty() {
        return Err(AppError::from_code(
            AppErrorCode::InvalidRelativePath,
            "relative path is empty",
        ));
    }

    let raw = Path::new(trimmed);

    if raw.is_absolute() {
        return Err(AppError::from_code(
            AppErrorCode::InvalidRelativePath,
            "absolute paths are not allowed",
        ));
    }

    let mut sanitized = PathBuf::new();

    for component in raw.components() {
        match component {
            Component::Normal(part) => {
                let part_str = part.to_str().ok_or_else(|| {
                    AppError::from_code(
                        AppErrorCode::InvalidRelativePath,
                        "relative path contains invalid unicode",
                    )
                })?;

                if part_str.trim().is_empty() {
                    return Err(AppError::from_code(
                        AppErrorCode::InvalidRelativePath,
                        "relative path contains an empty segment",
                    ));
                }

                // Win32 drops trailing spaces and dots from a name, so `video /a.mp4` and
                // `video/a.mp4` are one file there and two different strings everywhere the app
                // compares paths (a reference count, a duplicate check). Nothing the app writes
                // ends a segment that way.
                if part_str.ends_with([' ', '.']) {
                    return Err(AppError::from_code(
                        AppErrorCode::InvalidRelativePath,
                        "relative path segment ends with a space or a dot",
                    ));
                }

                // Reject NTFS alternate-data-stream syntax (`name:stream`) and Windows reserved
                // device names. `Path::components` only flags a drive prefix at the very start,
                // so a `:` or a `CON`/`NUL` segment in the middle otherwise slips through as a
                // plain Normal component.
                if part_str.contains(':') {
                    return Err(AppError::from_code(
                        AppErrorCode::InvalidRelativePath,
                        "relative path segment contains a colon",
                    ));
                }

                if is_windows_reserved_name(part_str) {
                    return Err(AppError::from_code(
                        AppErrorCode::InvalidRelativePath,
                        "relative path segment is a reserved device name",
                    ));
                }

                sanitized.push(part);
            }
            Component::CurDir => {}
            Component::ParentDir => {
                return Err(AppError::from_code(
                    AppErrorCode::InvalidRelativePath,
                    "parent directory segments are not allowed",
                ));
            }
            Component::RootDir | Component::Prefix(_) => {
                return Err(AppError::from_code(
                    AppErrorCode::InvalidRelativePath,
                    "absolute path components are not allowed",
                ));
            }
        }
    }

    if sanitized.as_os_str().is_empty() {
        return Err(AppError::from_code(
            AppErrorCode::InvalidRelativePath,
            "relative path is empty after normalization",
        ));
    }

    // A `.` segment dropped from either end shields the whitespace next to it from the trim above
    // (`./ a` comes out as ` a`), and that result would sanitize to something else the next time
    // it is read. Running it again trims it and checks what is left.
    let text = sanitized.to_str().unwrap_or_default();
    if text.trim() != text {
        return sanitize_relative_path_strict(text);
    }

    Ok(sanitized)
}

/// Validates a library-relative path received over IPC before it is stored on a row (media
/// file, thumbnail, avatar, live chat). On top of `sanitize_relative_path_strict` (no `..`, no
/// absolute/root/prefix component), it requires the path to be rooted at one of the app's
/// managed subdirectories (video/audio/thumbnails/live_chat).
///
/// The managed-directory requirement is what keeps this from being a foothold for arbitrary
/// file deletion. Every path the app legitimately produces is content-addressed under one of
/// those directories, so a bare name like `contract.docx` is rejected here. Without it, a
/// compromised frontend could persist such a name and (combined with a redirected library
/// directory) have a later delete/move command act on a file outside the app's own layout.
pub fn ensure_managed_library_relative_path(value: &str) -> AppResult<()> {
    let sanitized = sanitize_relative_path_strict(value)?;

    let first_component = sanitized
        .components()
        .next()
        .and_then(|component| component.as_os_str().to_str());

    let is_managed = first_component
        .map(|dir| crate::constants::MANAGED_LIBRARY_DIRS.contains(&dir))
        .unwrap_or(false);

    if !is_managed {
        return Err(AppError::from_code(
            AppErrorCode::InvalidRelativePath,
            "path must be inside a managed library directory",
        ));
    }

    Ok(())
}

/// Like [`ensure_managed_library_relative_path`], but requires the path to be rooted at one
/// specific managed subdirectory rather than any of them. Used by the live chat commands, whose
/// `relative_path` arrives raw over IPC. `sanitize_relative_path_strict` alone rejects `..`/absolute
/// paths but not a sibling managed directory, so without this a "stream/delete a live chat file"
/// call could be pointed at a video/audio/thumbnail file instead of the `live_chat/` tree it is
/// meant for.
pub fn ensure_relative_path_in_managed_dir(value: &str, expected_dir: &str) -> AppResult<()> {
    let sanitized = sanitize_relative_path_strict(value)?;

    let first_component = sanitized
        .components()
        .next()
        .and_then(|component| component.as_os_str().to_str());

    if first_component != Some(expected_dir) {
        return Err(AppError::from_code(
            AppErrorCode::InvalidRelativePath,
            "path must be inside the expected managed library directory",
        ));
    }

    Ok(())
}

/// Whether `path` resolves to `protected_dir` or to a directory inside it, comparing canonical paths
/// so a symlink or a `..`-laden path cannot dodge the check.
///
/// Fails open. When either side cannot be canonicalized the answer is `false`, because every caller
/// checks existence separately and only needs containment decided for a path that does resolve.
pub fn resolves_inside_dir(path: &Path, protected_dir: &Path) -> bool {
    let (Ok(canonical_path), Ok(canonical_protected)) =
        (path.canonicalize(), protected_dir.canonicalize())
    else {
        return false;
    };

    canonical_path.starts_with(&canonical_protected)
}

pub fn ensure_existing_path_inside_dir(path: &Path, base_dir: &Path) -> AppResult<()> {
    if !path.exists() {
        return Err(AppError::from_code(
            AppErrorCode::PathNotFound,
            "target path does not exist",
        ));
    }

    let canonical_base = base_dir.canonicalize().map_err(|e| {
        AppError::from_code(
            AppErrorCode::CanonicalizeBaseDirFailed,
            format!("failed to canonicalize base directory: {e}"),
        )
    })?;

    let canonical_path = path.canonicalize().map_err(|e| {
        AppError::from_code(
            AppErrorCode::CanonicalizeTargetPathFailed,
            format!("failed to canonicalize target path: {e}"),
        )
    })?;

    if !canonical_path.starts_with(&canonical_base) {
        return Err(AppError::from_code(
            AppErrorCode::PathOutsideBaseDir,
            "target path is outside the base directory",
        ));
    }

    Ok(())
}

/// Creates `path`'s parent below `base_dir` when missing, and refuses a parent that resolves
/// outside it.
///
/// `base_dir` itself is never created. Every caller passes the library folder, resolved before a
/// download or an import that can take hours, and recreating it here made a write that outlived
/// its drive land in a new, empty folder at the old path (a mount point, or a drive letter since
/// given to another disk) instead of failing. A missing base is reported as the library folder
/// being unreachable, which is what it is.
pub fn ensure_path_parent_inside_dir(path: &Path, base_dir: &Path) -> AppResult<()> {
    if !base_dir.is_dir() {
        return Err(AppError::from_code(
            AppErrorCode::LibraryFolderUnreachable,
            "the library folder is no longer there",
        ));
    }

    let canonical_base = base_dir.canonicalize().map_err(|e| {
        AppError::from_code(
            AppErrorCode::CanonicalizeBaseDirFailed,
            format!("failed to canonicalize base directory: {e}"),
        )
    })?;

    let parent = path.parent().ok_or_else(|| {
        AppError::from_code(
            AppErrorCode::InvalidTargetPath,
            "target path has no parent directory",
        )
    })?;

    if !parent.exists() {
        fs::create_dir_all(parent).map_err(|e| {
            AppError::from_code(
                AppErrorCode::CreateTargetParentFailed,
                format!("failed to create target parent directory: {e}"),
            )
        })?;
    }

    let canonical_parent = parent.canonicalize().map_err(|e| {
        AppError::from_code(
            AppErrorCode::CanonicalizeTargetParentFailed,
            format!("failed to canonicalize target parent directory: {e}"),
        )
    })?;

    if !canonical_parent.starts_with(&canonical_base) {
        return Err(AppError::from_code(
            AppErrorCode::PathOutsideBaseDir,
            "target path is outside the base directory",
        ));
    }

    Ok(())
}

/// Which managed subtree of the library a relative path is being resolved into.
///
/// This is a *required* argument of [`absolute_path_from_relative`] rather than a check a caller
/// remembers to run first, and that is the whole point of it existing. Every resolution of a
/// library-relative path goes through that function, so requiring the subtree here makes "which part
/// of the library may this path name" a question the compiler asks at each of them.
///
/// A check the caller has to remember gets forgotten. Confining a caller-supplied path to the
/// library *root* stops a traversal, but a bare `contract.docx` still resolves inside the folder the
/// user chose as their library and can be unlinked. Listing the command in the IPC path inventory
/// (see `scripts/verify-command-path-surface.js`) does not catch that either, which is why the rule
/// lives in the type of the thing every caller calls.
///
/// The variants are the subtrees an operation actually targets, not the four directories. A media
/// file is `video/` or `audio/` depending on what was downloaded, and the delete that removes one
/// cannot know which ahead of time.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ManagedSubtree {
    /// `video/` or `audio/`. One operation covers both because a media row's kind is data, not a
    /// property of the call.
    Media,
    Thumbnails,
    LiveChat,
}

impl ManagedSubtree {
    /// The managed directory names a path in this subtree may start with.
    pub fn dirs(self) -> &'static [&'static str] {
        match self {
            Self::Media => &[
                crate::constants::LIBRARY_DIR_VIDEO,
                crate::constants::LIBRARY_DIR_AUDIO,
            ],
            Self::Thumbnails => &[crate::constants::LIBRARY_DIR_THUMBNAILS],
            Self::LiveChat => &[crate::constants::LIBRARY_DIR_LIVE_CHAT],
        }
    }
}

/// Resolves a library-relative path to an absolute one inside `base_dir`, refusing anything that is
/// not in `subtree`.
///
/// The `subtree` argument is what makes the managed-directory rule impossible to omit; see
/// [`ManagedSubtree`] for the two production bugs that came from it being a separate, forgettable
/// call. Note what this does *not* do. The containment check here is lexical, so a caller unlinking
/// or reading the result still re-checks it with [`ensure_existing_path_inside_dir`], which
/// canonicalizes and therefore also resolves a symlinked intermediate component.
///
/// A path stored in the database is validated on the way in (`video_repository::insert_media` runs
/// `ensure_managed_library_relative_path`), so a row written by this app always passes. One written
/// before that validation existed, or by a hand-edited or imported database, can fail here, and that
/// is the intended direction. The caller reports the artifact as one it could not remove rather than
/// unlinking a file outside the managed tree on a corrupt row's say-so.
pub fn absolute_path_from_relative(
    base_dir: &Path,
    relative_path: &str,
    subtree: ManagedSubtree,
) -> AppResult<PathBuf> {
    let canonical_base = base_dir.canonicalize().map_err(|e| {
        AppError::from_code(
            AppErrorCode::CanonicalizeBaseDirFailed,
            format!("failed to canonicalize base directory: {e}"),
        )
    })?;

    let sanitized_relative = sanitize_relative_path_strict(relative_path)?;

    let first_component = sanitized_relative
        .components()
        .next()
        .and_then(|component| component.as_os_str().to_str());

    if !first_component.is_some_and(|dir| subtree.dirs().contains(&dir)) {
        return Err(AppError::from_code(
            AppErrorCode::InvalidRelativePath,
            format!(
                "path must be inside the {} library directory",
                subtree.dirs().join(" or ")
            ),
        ));
    }

    let absolute = canonical_base.join(sanitized_relative);

    if let Some(parent) = absolute.parent() {
        if !parent.starts_with(&canonical_base) {
            return Err(AppError::from_code(
                AppErrorCode::PathOutsideBaseDir,
                "target path is outside the base directory",
            ));
        }
    } else {
        return Err(AppError::from_code(
            AppErrorCode::InvalidTargetPath,
            "target path has no parent directory",
        ));
    }

    Ok(absolute)
}

pub fn relative_path_from_base(base_dir: &Path, absolute_path: &Path) -> AppResult<String> {
    let canonical_base = base_dir.canonicalize().map_err(|e| {
        AppError::from_code(
            AppErrorCode::CanonicalizeBaseDirFailed,
            format!("failed to canonicalize base directory: {e}"),
        )
    })?;

    let canonical_absolute = absolute_path.canonicalize().map_err(|e| {
        AppError::from_code(
            AppErrorCode::CanonicalizeTargetPathFailed,
            format!("failed to canonicalize target path: {e}"),
        )
    })?;

    if !canonical_absolute.starts_with(&canonical_base) {
        return Err(AppError::from_code(
            AppErrorCode::PathOutsideBaseDir,
            "target path is outside the base directory",
        ));
    }

    let relative = canonical_absolute
        .strip_prefix(&canonical_base)
        .map_err(|e| {
            AppError::from_code(
                AppErrorCode::RelativePathResolveFailed,
                format!("failed to resolve relative path: {e}"),
            )
        })?
        .to_path_buf();

    let relative_str = relative
        .to_str()
        .ok_or_else(|| {
            AppError::from_code(
                AppErrorCode::RelativePathResolveFailed,
                "relative path contains invalid unicode",
            )
        })?
        .replace('\\', "/");

    if relative_str.trim().is_empty() {
        return Err(AppError::from_code(
            AppErrorCode::RelativePathResolveFailed,
            "relative path is empty",
        ));
    }

    Ok(relative_str)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unique_test_dir() -> PathBuf {
        std::env::temp_dir().join(format!(
            "kavynex-path-test-{}",
            crate::utils::naming::unique_temp_suffix()
        ))
    }

    #[test]
    fn is_network_path_flags_unc_forward_slash_and_mixed_separator_shares() {
        for value in [
            r"\\server\share",
            r"\\server\share\clip.mp4",
            "//server/share",
            r"\\?\UNC\server\share", // verbatim UNC is still a network share
            r"\\?\Unc\server\share",
            // The other spellings that reach a share through the namespace.
            r"\\.\UNC\server\share",
            r"\??\UNC\server\share",
            r"\\?\GLOBALROOT\Device\Mup\server\share",
            r"\\.\globalroot\device\mup\server\share",
            r"\\.\LanmanRedirector\server\share",
            // Not a drive: a digit where the letter goes, and a letter with no colon.
            r"\\?\1:\video.mp4",
            r"\\?\C",
            // A drive or volume that `..` steps out of, into the namespace root, after Win32
            // normalizes the device path.
            r"\\.\C:\..\UNC\server\share",
            r"\\.\C:\folder\..\..\UNC\server\share",
            r"\\.\C:\.. \UNC\server\share",
            r"\\.\Volume{0b1c2d3e-0000-0000-0000-000000000000}\..\UNC\server\share",
            r"\\?\C:\.\video.mp4",
            // Not a share, but a device name no media path needs, refused with them.
            r"\\.\PhysicalDrive0",
            // Mixed separators that Windows normalizes to a UNC path; a literal `\\`/`//` prefix
            // match misses these, which is exactly the bypass this normalization closes.
            r"/\server\share",
            r"\/server\share",
            "  \\\\server\\share  ", // surrounding whitespace is trimmed before the check
        ] {
            assert!(is_network_path(value), "should flag: {value}");
        }

        for value in [
            r"C:\Users\me\video.mp4",
            "/home/me/video.mp4",
            "video/clip.mp4",
            r"\\?\C:\Users\me\video.mp4", // extended-length local path, not a network share
            r"\\.\C:\Users\me\video.mp4",
            r"\??\C:\Users\me\video.mp4",
            r"\\?\c:",
            r"\\?\C:\my...clips\video.mp4", // dots inside a name are not a step up
            r"\\?\Volume{0b1c2d3e-0000-0000-0000-000000000000}\video.mp4",
        ] {
            assert!(!is_network_path(value), "should not flag: {value}");
        }
    }

    #[test]
    fn network_share_prefix_reads_the_share_regardless_of_case_separators_and_verbatim_form() {
        for value in [
            r"\\NAS\Videos",
            r"\\nas\videos\2024\clip.mp4",
            "//Nas/VIDEOS/",
            r"/\nas\videos",
            r"\\?\UNC\nas\videos\clip.mp4",
            r"\\?\unc\NAS\VIDEOS",
            r"\\.\UNC\nas\videos\clip.mp4",
            r"\??\UNC\nas\videos",
            "  \\\\nas\\videos  ",
        ] {
            assert_eq!(
                network_share_prefix(value).as_deref(),
                Some(r"\\nas\videos"),
                "share prefix of {value}"
            );
        }
    }

    #[test]
    fn network_share_prefix_is_none_for_local_paths_and_a_host_without_a_share() {
        for value in [
            r"C:\Users\me\video.mp4",
            "/home/me/video.mp4",
            r"\\?\C:\Users\me\video.mp4",
            r"\\.\PhysicalDrive0",
            r"\\?\GLOBALROOT\Device\Mup\nas\videos",
            r"\\nas",
            r"\\nas\",
            "//nas//",
            "",
        ] {
            assert_eq!(
                network_share_prefix(value),
                None,
                "should have no share: {value}"
            );
        }
    }

    #[test]
    fn sanitize_relative_path_rejects_parent_dir() {
        let result = sanitize_relative_path_strict("../outside/file.txt");
        assert!(result.is_err());
    }

    #[test]
    fn sanitize_relative_path_accepts_normal_relative_path() {
        let result = sanitize_relative_path_strict("video/file.mp4").unwrap();
        assert_eq!(result, PathBuf::from("video/file.mp4"));
    }

    #[test]
    fn sanitize_relative_path_rejects_a_colon_segment() {
        // NTFS alternate data stream syntax.
        let error = sanitize_relative_path_strict("thumbnails/thumb.jpg:hidden").unwrap_err();
        assert_eq!(error.code, AppErrorCode::InvalidRelativePath.as_str());
    }

    #[test]
    fn sanitize_relative_path_rejects_a_segment_ending_in_a_space_or_a_dot() {
        // Win32 trims these, so each names the same file as the path without them.
        for raw in ["video /a.mp4", "video./a.mp4", "video/a.mp4./b"] {
            let error = sanitize_relative_path_strict(raw).unwrap_err();
            assert_eq!(
                error.code,
                AppErrorCode::InvalidRelativePath.as_str(),
                "{raw:?}"
            );
        }
    }

    #[test]
    fn sanitize_relative_path_trims_whitespace_a_dot_segment_hid() {
        assert_eq!(
            sanitize_relative_path_strict("./ video/a.mp4").unwrap(),
            sanitize_relative_path_strict("video/a.mp4").unwrap()
        );
        assert_eq!(
            sanitize_relative_path_strict("video/a.mp4\t/.").unwrap(),
            sanitize_relative_path_strict("video/a.mp4").unwrap()
        );
    }

    #[test]
    fn sanitize_relative_path_rejects_windows_reserved_device_names() {
        for path in [
            "video/CON",
            "video/con.mp4",
            "video/NUL.txt",
            "audio/COM1",
            "thumbnails/LPT9.jpg",
        ] {
            let error = sanitize_relative_path_strict(path)
                .expect_err(&format!("{path} should be rejected"));
            assert_eq!(error.code, AppErrorCode::InvalidRelativePath.as_str());
        }
    }

    #[test]
    fn sanitize_relative_path_allows_names_that_only_start_like_a_reserved_name() {
        // "console" / "computer" are not reserved even though they start with CON/COM.
        for path in ["video/console.mp4", "video/computer.mp4", "audio/lpt.m4a"] {
            sanitize_relative_path_strict(path)
                .unwrap_or_else(|error| panic!("{path} should be accepted: {error}"));
        }
    }

    #[test]
    fn sanitize_relative_path_allows_four_char_names_ending_in_a_digit() {
        // A four-character stem that ends in a digit but does not start with COM/LPT (e.g.
        // "pic1", "km2x" is five, "abc9") is a normal name, not a reserved device. The device
        // check must require *both* the COM/LPT head and the trailing digit, so this must be
        // accepted while COM1/LPT9 stay rejected.
        for path in ["video/pic1.mp4", "audio/abc9.m4a", "thumbnails/xyz0.jpg"] {
            sanitize_relative_path_strict(path)
                .unwrap_or_else(|error| panic!("{path} should be accepted: {error}"));
        }

        // The genuine device names with the same 4-char digit shape stay rejected.
        for path in ["video/COM1", "audio/lpt9.m4a"] {
            sanitize_relative_path_strict(path).expect_err(&format!("{path} should be rejected"));
        }
    }

    #[test]
    fn sanitize_relative_path_rejects_the_superscript_com_and_lpt_devices() {
        // Windows resolves the superscript ordinals to the same devices as COM1/COM2/COM3, so a
        // check written against `is_ascii_digit` alone lets exactly these three spellings through.
        // Written as escapes rather than as the characters themselves, per the repository's rule for
        // a codepoint used as data.
        for path in [
            "video/COM\u{b9}",
            "video/com\u{b2}.mp4",
            "audio/LPT\u{b3}.m4a",
            "thumbnails/lpt\u{b9}.jpg",
        ] {
            let error = sanitize_relative_path_strict(path)
                .expect_err(&format!("{path} should be rejected"));
            assert_eq!(error.code, AppErrorCode::InvalidRelativePath.as_str());
        }
    }

    #[test]
    fn sanitize_relative_path_allows_other_superscripts_and_non_ascii_ordinals() {
        // The other direction, so the ordinal rule stays exactly as wide as Windows' own aliasing
        // rather than growing into "any non-ASCII fourth character". Superscript four is not a
        // device alias, and neither is a non-Latin digit, both are ordinary names.
        for path in [
            "video/COM\u{2074}.mp4", // superscript four
            "video/COM\u{0660}.mp4", // arabic-indic zero
            "audio/lpt\u{2070}.m4a", // superscript zero
        ] {
            sanitize_relative_path_strict(path)
                .unwrap_or_else(|error| panic!("{path} should be accepted: {error}"));
        }
    }

    #[test]
    fn ensure_managed_library_relative_path_accepts_paths_under_managed_dirs() {
        for path in [
            "video/media_abc.mp4",
            "audio/media_abc.m4a",
            "thumbnails/thumb_abc.jpg",
            "live_chat/clip.live_chat.json.gz",
        ] {
            ensure_managed_library_relative_path(path)
                .unwrap_or_else(|error| panic!("{path} should be accepted: {error}"));
        }
    }

    #[test]
    fn ensure_managed_library_relative_path_rejects_bare_and_unmanaged_paths() {
        // A bare filename at the (possibly redirected) library root, an unmanaged directory,
        // a traversal attempt, and an absolute path must all be rejected.
        for path in [
            "contract.docx",
            "Documents/secret.txt",
            "video/../../secret.txt",
            "../secret.txt",
            "config/app.ini",
        ] {
            let error = ensure_managed_library_relative_path(path)
                .expect_err(&format!("{path} should be rejected"));
            assert_eq!(error.code, AppErrorCode::InvalidRelativePath.as_str());
        }
    }

    #[test]
    fn absolute_path_from_relative_resolves_inside_base_without_creating_parent() {
        let base_dir = unique_test_dir();
        fs::create_dir_all(&base_dir).unwrap();

        let nested_parent = base_dir.join("video");
        assert!(!nested_parent.exists());

        let absolute =
            absolute_path_from_relative(&base_dir, "video/test.mp4", ManagedSubtree::Media)
                .unwrap();
        assert!(absolute.starts_with(base_dir.canonicalize().unwrap()));
        assert!(!nested_parent.exists());

        let _ = fs::remove_dir_all(base_dir);
    }

    #[test]
    fn absolute_path_from_relative_refuses_a_path_outside_the_requested_subtree() {
        // The rule the `subtree` argument exists to make unforgettable. Before it, this function
        // confined a path to the base directory and said nothing about which part of it, so a bare
        // name resolved inside the user's own library folder and the caller unlinked it. Two
        // commands shipped that way (see ManagedSubtree).
        let base_dir = unique_test_dir();
        fs::create_dir_all(&base_dir).unwrap();

        for (relative, subtree) in [
            // A file of the user's that merely shares the folder.
            ("contract.docx", ManagedSubtree::Media),
            ("photos/wedding.jpg", ManagedSubtree::Thumbnails),
            // A sibling managed directory. Managed, and still not the one this call is for. The
            // generic "is it one of the four" check would have allowed each of these.
            ("video/media_abc.mp4", ManagedSubtree::Thumbnails),
            ("thumbnails/thumb_abc.jpg", ManagedSubtree::LiveChat),
            ("live_chat/chat.json.gz", ManagedSubtree::Media),
        ] {
            let error = absolute_path_from_relative(&base_dir, relative, subtree)
                .expect_err("a path outside the requested subtree must be refused");

            assert_eq!(
                error.code,
                AppErrorCode::InvalidRelativePath.as_str(),
                "{relative} under {subtree:?}"
            );
        }

        let _ = fs::remove_dir_all(base_dir);
    }

    #[test]
    fn absolute_path_from_relative_accepts_both_media_directories() {
        // `Media` covers two directories because a media row's kind is data: the delete that
        // removes one cannot know whether it was a video or an audio download ahead of time.
        let base_dir = unique_test_dir();
        fs::create_dir_all(&base_dir).unwrap();

        for relative in ["video/media_abc.mp4", "audio/media_abc.mp3"] {
            absolute_path_from_relative(&base_dir, relative, ManagedSubtree::Media)
                .unwrap_or_else(|error| panic!("{relative} must resolve, got {error:?}"));
        }

        let _ = fs::remove_dir_all(base_dir);
    }

    #[test]
    fn managed_subtree_dirs_are_the_managed_directory_names() {
        // Pins the mapping against the constants rather than against a literal, so a renamed
        // directory cannot leave a subtree pointing at a name the library no longer uses.
        assert_eq!(
            ManagedSubtree::Media.dirs(),
            [
                crate::constants::LIBRARY_DIR_VIDEO,
                crate::constants::LIBRARY_DIR_AUDIO
            ]
        );
        assert_eq!(
            ManagedSubtree::Thumbnails.dirs(),
            [crate::constants::LIBRARY_DIR_THUMBNAILS]
        );
        assert_eq!(
            ManagedSubtree::LiveChat.dirs(),
            [crate::constants::LIBRARY_DIR_LIVE_CHAT]
        );

        // Every name a subtree names is one of the four the library manages, so no subtree can
        // authorize a directory outside the managed layout.
        for subtree in [
            ManagedSubtree::Media,
            ManagedSubtree::Thumbnails,
            ManagedSubtree::LiveChat,
        ] {
            for dir in subtree.dirs() {
                assert!(
                    crate::constants::MANAGED_LIBRARY_DIRS.contains(dir),
                    "{dir} is not a managed library directory"
                );
            }
        }
    }

    #[test]
    fn ensure_path_parent_inside_dir_never_recreates_a_missing_base_dir() {
        // The base is the library folder. Recreating it put a write that outlived its drive into
        // a new, empty folder at the old path.
        let base_dir = unique_test_dir();
        assert!(!base_dir.exists());

        let target = base_dir.join("video").join("clip.mp4");
        let error = ensure_path_parent_inside_dir(&target, &base_dir).unwrap_err();

        assert_eq!(error.code, AppErrorCode::LibraryFolderUnreachable.as_str());
        assert!(!base_dir.exists());
    }

    #[test]
    fn ensure_path_parent_inside_dir_creates_the_parent_below_an_existing_base() {
        let base_dir = unique_test_dir();
        fs::create_dir_all(&base_dir).unwrap();

        let target = base_dir.join("video").join("clip.mp4");
        ensure_path_parent_inside_dir(&target, &base_dir).unwrap();

        assert!(base_dir.join("video").is_dir());

        let _ = fs::remove_dir_all(&base_dir);
    }

    #[test]
    fn relative_path_from_base_returns_forward_slashes() {
        let base_dir = unique_test_dir();
        let nested_dir = base_dir.join("video");
        let target_path = nested_dir.join("test.mp4");

        fs::create_dir_all(&nested_dir).unwrap();
        fs::write(&target_path, b"abc").unwrap();

        let relative = relative_path_from_base(&base_dir, &target_path).unwrap();
        assert_eq!(relative, "video/test.mp4");

        let _ = fs::remove_dir_all(base_dir);
    }
}

// The cases above pin the shapes someone thought of. These run each check over generated input, so
// what they assert has to hold for every path, including the ones nobody wrote down.
#[cfg(test)]
mod properties {
    use std::path::Component;

    use proptest::prelude::*;

    use super::{is_network_path, sanitize_relative_path_strict};

    /// Text made of what a relative path is built from, separators and the characters the checks
    /// treat specially included.
    const PATH_TEXT: &str = r"[A-Za-z0-9 ._:/\\-]{0,40}";

    fn separator() -> impl Strategy<Value = char> {
        prop::sample::select(vec!['/', '\\'])
    }

    fn components() -> impl Strategy<Value = Vec<String>> {
        prop::collection::vec("[A-Za-z0-9_]{1,8}", 0..4)
    }

    proptest! {
        #[test]
        fn a_sanitized_path_is_only_plain_components(raw in PATH_TEXT) {
            if let Ok(path) = sanitize_relative_path_strict(&raw) {
                prop_assert!(path.is_relative());

                for part in path.components() {
                    prop_assert!(matches!(part, Component::Normal(_)), "{raw:?} gave {path:?}");

                    let text = part.as_os_str().to_str().unwrap();
                    prop_assert!(!text.contains(':'));
                    prop_assert!(!text.trim().is_empty());
                }
            }
        }

        #[test]
        fn sanitizing_a_sanitized_path_changes_nothing(raw in PATH_TEXT) {
            if let Ok(path) = sanitize_relative_path_strict(&raw) {
                let again = sanitize_relative_path_strict(path.to_str().unwrap()).unwrap();
                prop_assert_eq!(again, path);
            }
        }

        #[test]
        fn a_parent_segment_is_refused_wherever_it_sits(
            before in components(),
            after in components(),
        ) {
            let mut parts = before;
            parts.push("..".to_string());
            parts.extend(after);

            prop_assert!(sanitize_relative_path_strict(&parts.join("/")).is_err());
        }

        #[test]
        fn a_share_is_a_network_path_whatever_the_separators(
            host in "[a-z0-9]{1,10}",
            share in "[a-z0-9]{1,10}",
            first in separator(),
            second in separator(),
            third in separator(),
            lead in " {0,2}",
        ) {
            let path = format!("{lead}{first}{second}{host}{third}{share}");
            prop_assert!(is_network_path(&path), "{path:?}");
        }

        #[test]
        fn a_drive_behind_a_namespace_prefix_is_local(
            prefix in prop::sample::select(vec![r"\\?\", r"\\.\", r"\??\"]),
            drive in "[A-Za-z]",
            parts in components(),
        ) {
            let path = format!(r"{prefix}{drive}:\{}", parts.join(r"\"));
            prop_assert!(!is_network_path(&path), "{path:?}");
        }

        #[test]
        fn a_dot_component_behind_a_namespace_prefix_is_refused(
            prefix in prop::sample::select(vec![r"\\?\", r"\\.\", r"\??\"]),
            drive in "[A-Za-z]",
            dots in prop::sample::select(vec![".", "..", ".. ", " ."]),
            parts in components(),
        ) {
            let path = format!(r"{prefix}{drive}:\{dots}\{}", parts.join(r"\"));
            prop_assert!(is_network_path(&path), "{path:?}");
        }

        #[test]
        fn a_drive_or_relative_path_is_local(drive in "[A-Za-z]", parts in components()) {
            let drive_path = format!(r"{drive}:\{}", parts.join(r"\"));
            prop_assert!(!is_network_path(&drive_path));
            prop_assert!(!is_network_path(&parts.join("/")));
        }
    }
}
