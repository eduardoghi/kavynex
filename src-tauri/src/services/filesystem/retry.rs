//! Telling the OS errors apart that a file operation recovers from, and retrying while another
//! program (an antivirus scanner, the search indexer) briefly holds a file.

use super::*;

#[cfg(unix)]
pub(super) fn is_cross_device_error(error: &std::io::Error) -> bool {
    error.raw_os_error() == Some(18)
}

#[cfg(windows)]
pub(super) fn is_cross_device_error(error: &std::io::Error) -> bool {
    error.raw_os_error() == Some(17)
}

#[cfg(not(any(unix, windows)))]
pub(super) fn is_cross_device_error(_: &std::io::Error) -> bool {
    false
}

/// The Windows errors a file just created or written tends to return for a moment while an antivirus
/// scanner or the search indexer holds it (access denied, sharing violation, lock violation).
#[cfg(windows)]
pub(super) fn is_held_by_another_program(error: &std::io::Error) -> bool {
    matches!(error.raw_os_error(), Some(5) | Some(32) | Some(33))
}

/// Runs `op`, and on Windows runs it again a few times, a little later each time, while it fails
/// because another program is holding the file.
///
/// A scanner opens every new file the moment it appears, so the rename that follows a copy, or
/// reopening the copy to flush it, failed now and then for a reason that was gone a second later,
/// and took a whole import, download or marker write with it. Elsewhere `op` runs once.
pub(crate) fn retry_while_held<T>(op: impl FnMut() -> std::io::Result<T>) -> std::io::Result<T> {
    retry_while_held_with(&[50, 100, 200, 400], op)
}

/// [`retry_while_held`] with a longer wait, for a file of gigabytes a scanner is still reading when
/// the rename comes. Under a second of retries is enough for a thumbnail and not for a finished
/// download, whose failed placement would leave it only in the run folder that is deleted next.
pub(crate) fn retry_while_held_patiently<T>(
    op: impl FnMut() -> std::io::Result<T>,
) -> std::io::Result<T> {
    retry_while_held_with(&[100, 250, 500, 1_000, 2_000, 4_000], op)
}

#[cfg_attr(not(windows), allow(unused_variables))]
pub(super) fn retry_while_held_with<T>(
    delays_ms: &[u64],
    mut op: impl FnMut() -> std::io::Result<T>,
) -> std::io::Result<T> {
    #[cfg(windows)]
    {
        for &delay_ms in delays_ms {
            match op() {
                Err(error) if is_held_by_another_program(&error) => {
                    std::thread::sleep(std::time::Duration::from_millis(delay_ms));
                }
                result => return result,
            }
        }
    }

    op()
}

/// `fs::rename` through [`retry_while_held`].
pub(crate) fn rename_retrying(from: &Path, to: &Path) -> std::io::Result<()> {
    retry_while_held(|| fs::rename(from, to))
}

/// `fs::rename` through [`retry_while_held_patiently`], for a media file.
pub(crate) fn rename_retrying_patiently(from: &Path, to: &Path) -> std::io::Result<()> {
    retry_while_held_patiently(|| fs::rename(from, to))
}
