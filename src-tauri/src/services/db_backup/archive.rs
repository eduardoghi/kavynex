//! The daily snapshots older than the newest one, kept gzip-compressed under the time they were
//! taken (`kavynex.db.bak-20261106T120000Z.gz`).
//!
//! The newest snapshot stays a plain `.bak`, since it is the one a restore reaches first and the one
//! whose modification time the daily throttle reads. Every older one is a full copy of a database
//! that grows with each comment saved, and they live in the app config directory, which is the
//! roaming profile on Windows. Compressed, a library database takes about a third of the space.
//!
//! Named by time rather than by position. The positional names (`.bak.1` .. `.bak.6`) had to shift
//! up by one on every snapshot, so a single file another program held stopped the chain, and each
//! day the file stayed held cost one older generation. An archive is written once under its own
//! name and only ever deleted, so a held one only keeps itself.
//!
//! The positional generations a build from before this left behind are still read. The next daily
//! snapshot archives them under their own times and removes them.

use std::fs::{self, File};
use std::io::{BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use flate2::read::GzDecoder;
use flate2::write::GzEncoder;
use flate2::Compression;
use sha2::Digest;

use crate::AppResult;

use super::{backup_error, sibling};

/// How many archives are kept beside the plain `.bak`, so up to seven daily snapshots exist.
pub(super) const BACKUP_ARCHIVES_KEPT: usize = 6;

/// How many positional generations (`.bak.1` ..) a build from before the archives kept.
pub(super) const LEGACY_BACKUP_GENERATIONS: usize = 6;

const ARCHIVE_INFIX: &str = ".bak-";
const ARCHIVE_EXTENSION: &str = ".gz";
const ARCHIVE_TEMP_EXTENSION: &str = ".gz.tmp";

/// The archive of a snapshot taken at `taken_at`, the first one of its second. The tests name
/// archives by it.
#[cfg(test)]
pub(super) fn archive_path(db_path: &Path, taken_at: SystemTime) -> PathBuf {
    numbered_archive_path(db_path, taken_at, 0)
}

/// [`archive_path`] for the `copy`th distinct snapshot taken within the same second, which only two
/// snapshots of different content dated alike reach. The suffix keeps the name sorting by time.
fn numbered_archive_path(db_path: &Path, taken_at: SystemTime, copy: u32) -> PathBuf {
    let stamp = chrono::DateTime::<chrono::Utc>::from(taken_at).format("%Y%m%dT%H%M%SZ");
    let suffix = if copy == 0 {
        String::new()
    } else {
        format!("-{copy}")
    };

    sibling(
        db_path,
        &format!("{ARCHIVE_INFIX}{stamp}{suffix}{ARCHIVE_EXTENSION}"),
    )
}

/// How many snapshots dated within the same second are told apart before archiving gives up.
const MAX_SAME_SECOND_ARCHIVES: u32 = 100;

fn archive_temp_path(archive: &Path) -> PathBuf {
    let mut name = archive.as_os_str().to_owned();
    name.push(".tmp");
    PathBuf::from(name)
}

/// A positional generation from a build before the archives, `.bak.1` through `.bak.6`.
pub(super) fn legacy_generation_path(db_path: &Path, generation: usize) -> PathBuf {
    sibling(db_path, &format!(".bak.{generation}"))
}

pub(super) fn legacy_generation_paths(db_path: &Path) -> Vec<PathBuf> {
    (1..=LEGACY_BACKUP_GENERATIONS)
        .map(|generation| legacy_generation_path(db_path, generation))
        .collect()
}

/// Whether `path` names an archive of the database at `db_path`.
pub(super) fn is_archive(db_path: &Path, path: &Path) -> bool {
    archive_name_matches(db_path, path, ARCHIVE_EXTENSION)
}

fn archive_name_matches(db_path: &Path, path: &Path, extension: &str) -> bool {
    let (Some(db_name), Some(name)) = (
        db_path.file_name().and_then(|name| name.to_str()),
        path.file_name().and_then(|name| name.to_str()),
    ) else {
        return false;
    };

    path.parent() == db_path.parent()
        && name
            .strip_prefix(db_name)
            .and_then(|rest| rest.strip_prefix(ARCHIVE_INFIX))
            .and_then(|rest| rest.strip_suffix(extension))
            .is_some_and(|stamp| !stamp.is_empty() && !stamp.contains('.'))
}

fn files_beside(db_path: &Path, extension: &str) -> Vec<PathBuf> {
    let Some(dir) = db_path.parent() else {
        return Vec::new();
    };

    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };

    entries
        .flatten()
        .map(|entry| db_path.with_file_name(entry.file_name()))
        .filter(|path| archive_name_matches(db_path, path, extension))
        .collect()
}

/// The archives beside `db_path`, newest first. The time in the name sorts as text.
pub(super) fn archived_backups(db_path: &Path) -> Vec<PathBuf> {
    let mut archives = files_beside(db_path, ARCHIVE_EXTENSION);
    archives.sort_unstable_by(|left, right| right.cmp(left));
    archives
}

/// Archives a write that did not finish left behind.
pub(super) fn archive_scratch_paths(db_path: &Path) -> Vec<PathBuf> {
    files_beside(db_path, ARCHIVE_TEMP_EXTENSION)
}

pub(super) fn remove_archive_scratch(db_path: &Path) {
    for scratch in archive_scratch_paths(db_path) {
        let _ = fs::remove_file(scratch);
    }
}

/// Compresses the snapshot at `snapshot` into an archive named by its modification time, which is
/// when it was taken, and returns the archive.
///
/// The archive is written under a scratch name, read back and compared with what was read from the
/// snapshot, and only then renamed into place, so an archive that exists is whole. One that already
/// exists under the same name and holds the same bytes is this snapshot's, archived by a run that
/// stopped before it could remove the original, and is kept as it is. One that holds other bytes is
/// another snapshot dated alike, and this one takes the next name rather than being dropped as if it
/// were already archived.
///
/// The archive takes the snapshot's modification time, so everything that dates a backup by its
/// file (the status in Settings, a file manager) still reads when it was taken.
pub(super) fn archive_snapshot(db_path: &Path, snapshot: &Path) -> AppResult<PathBuf> {
    let taken_at = fs::metadata(snapshot)
        .and_then(|metadata| metadata.modified())
        .unwrap_or_else(|_| SystemTime::now());
    let mut source_digest = None;
    let mut copy = 0;

    let target = loop {
        let candidate = numbered_archive_path(db_path, taken_at, copy);

        if !candidate.is_file() {
            break candidate;
        }

        if source_digest.is_none() {
            source_digest = Some(crate::utils::hash::file_hash(snapshot)?);
        }

        if unpacked_digest(&candidate).ok() == source_digest {
            return Ok(candidate);
        }

        copy += 1;

        if copy >= MAX_SAME_SECOND_ARCHIVES {
            return Err(backup_error(
                "failed to store a backup archive",
                "too many snapshots are dated the same second",
            ));
        }
    };

    let temp = archive_temp_path(&target);
    let _ = fs::remove_file(&temp);

    let stored = write_verified_archive(snapshot, &temp).and_then(|()| {
        crate::services::filesystem::rename_retrying(&temp, &target)
            .map_err(|error| backup_error("failed to store a backup archive", error))
    });

    if let Err(error) = stored {
        let _ = fs::remove_file(&temp);
        return Err(error);
    }

    if let Ok(file) = File::options().write(true).open(&target) {
        let _ = file.set_modified(taken_at);
    }
    crate::services::filesystem::fsync_parent_dir(&target);

    Ok(target)
}

const ARCHIVE_BUFFER_BYTES: usize = 64 * 1024;

fn write_verified_archive(source: &Path, temp: &Path) -> AppResult<()> {
    let mut reader = BufReader::new(
        File::open(source).map_err(|error| backup_error("failed to read a snapshot", error))?,
    );
    let file = File::create(temp)
        .map_err(|error| backup_error("failed to create a backup archive", error))?;
    let mut encoder = GzEncoder::new(file, Compression::default());
    let mut hasher = sha2::Sha256::new();
    let mut buffer = vec![0u8; ARCHIVE_BUFFER_BYTES];

    loop {
        let read = reader
            .read(&mut buffer)
            .map_err(|error| backup_error("failed to read a snapshot", error))?;

        if read == 0 {
            break;
        }

        hasher.update(&buffer[..read]);
        encoder
            .write_all(&buffer[..read])
            .map_err(|error| backup_error("failed to write a backup archive", error))?;
    }

    let file = encoder
        .finish()
        .map_err(|error| backup_error("failed to write a backup archive", error))?;
    file.sync_all()
        .map_err(|error| backup_error("failed to flush a backup archive", error))?;
    drop(file);

    let read_digest = crate::utils::hash::hex_digest(hasher);
    let written_digest = unpacked_digest(temp)?;

    if read_digest != written_digest {
        return Err(backup_error(
            "failed to write a backup archive",
            "the archive does not hold what was read from the snapshot",
        ));
    }

    Ok(())
}

fn unpacked_digest(archive: &Path) -> AppResult<String> {
    let mut decoder =
        GzDecoder::new(BufReader::new(File::open(archive).map_err(|error| {
            backup_error("failed to read a backup archive", error)
        })?));
    let mut hasher = sha2::Sha256::new();
    let mut buffer = vec![0u8; ARCHIVE_BUFFER_BYTES];

    loop {
        let read = decoder
            .read(&mut buffer)
            .map_err(|error| backup_error("failed to read a backup archive", error))?;

        if read == 0 {
            break;
        }

        hasher.update(&buffer[..read]);
    }

    Ok(crate::utils::hash::hex_digest(hasher))
}

/// Writes the database an archive holds to `destination`, replacing whatever is there, and flushes
/// it. A destination left by a failure is removed.
pub(super) fn unpack_archive(archive: &Path, destination: &Path) -> AppResult<()> {
    let unpacked = (|| {
        let mut decoder =
            GzDecoder::new(BufReader::new(File::open(archive).map_err(|error| {
                backup_error("failed to read a backup archive", error)
            })?));
        let mut file = File::create(destination)
            .map_err(|error| backup_error("failed to unpack a backup archive", error))?;

        std::io::copy(&mut decoder, &mut file)
            .map_err(|error| backup_error("failed to unpack a backup archive", error))?;
        file.sync_all()
            .map_err(|error| backup_error("failed to flush an unpacked backup", error))
    })();

    if unpacked.is_err() {
        let _ = fs::remove_file(destination);
    }

    unpacked
}

/// Deletes the archives past the newest [`BACKUP_ARCHIVES_KEPT`]. One that cannot be deleted is left
/// and tried again next time. Nothing else depends on it going.
pub(super) fn prune_archives(db_path: &Path) {
    for archive in archived_backups(db_path)
        .into_iter()
        .skip(BACKUP_ARCHIVES_KEPT)
    {
        if let Err(error) = fs::remove_file(&archive) {
            crate::services::logger::warn(
                "db_backup",
                format!(
                    "an old backup archive could not be removed, so it stays until the next run: {error}"
                ),
            );
        }
    }
}
