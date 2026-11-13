//! Telling whether two paths lead to the same place on disk, whatever spelling each one took.
//!
//! The canonical paths cannot tell. On Windows `canonicalize` keeps a share's host as it was
//! spelled, so `\\nas\share\lib`, `\\192.168.0.10\share\lib` and a drive letter mapped to the same
//! share come back as three different strings for one folder. A bind mount on Linux and a firmlink
//! on macOS do the same. What the disk itself says does not depend on the spelling. That is the
//! volume and file index on Windows and the device and inode on Unix, which `same_file` compares.
//!
//! Both checks are kept, because each covers what the other cannot. The canonical paths settle the
//! ordinary case without opening anything, and identity covers the alias.

use super::*;

/// Whether `left` and `right` name the same directory entry.
///
/// Not the same question as naming the same file. A hard link gives one file two entries, which is
/// what a Move import makes on purpose (the library's name beside the user's), and removing one of
/// them leaves the file under the other. The same entry reached twice is the case that matters,
/// since removing "the other one" then removes the only one.
pub(crate) fn is_same_directory_entry(left: &Path, right: &Path) -> bool {
    canonical_paths_match(left, right) || same_entry_by_identity(left, right)
}

fn canonical_paths_match(left: &Path, right: &Path) -> bool {
    matches!(
        (left.canonicalize(), right.canonicalize()),
        (Ok(left), Ok(right)) if left == right
    )
}

/// The half of [`is_same_directory_entry`] that does not read the paths as text. The same file,
/// in the same directory, under the same name.
///
/// The name is compared without regard to case, since on Windows and on a default macOS volume two
/// spellings that differ only in case are one entry. On a case-sensitive volume that reads two
/// hard links named `A` and `a` in one folder as one entry, which errs toward keeping a file. A
/// name or a parent that cannot be compared counts as the same, for the same reason.
pub(super) fn same_entry_by_identity(left: &Path, right: &Path) -> bool {
    if !same_file::is_same_file(left, right).unwrap_or(false) {
        return false;
    }

    let same_name = match (left.file_name(), right.file_name()) {
        (Some(left), Some(right)) => {
            left.to_string_lossy().to_lowercase() == right.to_string_lossy().to_lowercase()
        }
        _ => true,
    };

    if !same_name {
        return false;
    }

    match (left.parent(), right.parent()) {
        (Some(left), Some(right)) => same_file::is_same_file(left, right).unwrap_or(true),
        _ => true,
    }
}

/// Whether `path` is the directory `dir` or lies under it.
pub(crate) fn path_is_inside_dir(path: &Path, dir: &Path) -> bool {
    let by_spelling = matches!(
        (path.canonicalize(), dir.canonicalize()),
        (Ok(path), Ok(dir)) if path.starts_with(&dir)
    );

    by_spelling || directory_chain_contains(path, dir)
}

/// Whether `path` or one of its ancestors is the directory `target`, compared by identity on disk.
///
/// A directory that cannot be opened counts as not matching.
pub(crate) fn directory_chain_contains(path: &Path, target: &Path) -> bool {
    let Ok(target) = same_file::Handle::from_path(target) else {
        return false;
    };

    path.ancestors()
        .filter_map(|ancestor| same_file::Handle::from_path(ancestor).ok())
        .any(|ancestor| ancestor == target)
}
