use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use chrono::{SecondsFormat, Utc};

const MAX_LOG_BYTES: u64 = 5 * 1024 * 1024;

static LOG_PATH: OnceLock<PathBuf> = OnceLock::new();
static LOG_LOCK: Mutex<()> = Mutex::new(());

/// Enables the file sink. Called once at startup with the app log directory; until then
/// logs only go to stderr. Failures are swallowed so logging never breaks the app.
pub fn init(log_dir: PathBuf) {
    if fs::create_dir_all(&log_dir).is_err() {
        return;
    }

    let _ = LOG_PATH.set(log_dir.join("kavynex.log"));
}

/// Human-readable UTC timestamp for a log line (RFC 3339, second precision, e.g.
/// `2026-07-06T12:34:56Z`). Raw epoch seconds are hard to read in a bug report; `Utc::now()`
/// cannot fail, so this never panics.
fn timestamp_string() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true)
}

fn backup_path(path: &Path) -> PathBuf {
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("kavynex.log");

    path.with_file_name(format!("{name}.1"))
}

/// Keeps a single rolled-over backup: when the log passes the size limit it is renamed to
/// `<name>.1` (replacing any previous backup) and a fresh log is started.
fn rotate_if_needed(path: &Path, max_bytes: u64) {
    let Ok(metadata) = fs::metadata(path) else {
        return;
    };

    if metadata.len() < max_bytes {
        return;
    }

    let backup = backup_path(path);
    let _ = fs::remove_file(&backup);
    let _ = fs::rename(path, &backup);
}

/// Reduz um caminho ao seu componente final para uso em log. Uma linha de log pode ser
/// colada num bug report publico, e um caminho absoluto no Windows embute
/// `C:\Users\<nome>\...`, revelando o usuario/perfil do SO. Espelha a redacao que os
/// caminhos do yt-dlp ja recebem (services::yt_dlp_download::redact_paths_value). Cai para
/// `<path>` quando o caminho nao tem componente final (ex.: uma raiz).
pub fn redact_path(path: impl AsRef<Path>) -> String {
    path.as_ref()
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "<path>".to_string())
}

fn append_line(path: &Path, line: &str) {
    rotate_if_needed(path, MAX_LOG_BYTES);

    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(file, "{line}");
    }
}

/// Acquires the file lock and appends a single line. Split out from [`write`] so the same
/// body can run either inline (synchronous callers) or on the blocking pool (async callers).
fn append_line_locked(path: &Path, line: &str) {
    let _guard = LOG_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    append_line(path, line);
}

fn write(level: &str, scope: &str, message: &str) {
    let line = format!(
        "[{}] [{}] [{}] {}",
        timestamp_string(),
        level,
        scope,
        message
    );

    eprintln!("{line}");

    let Some(path) = LOG_PATH.get() else {
        return;
    };

    // The file write (rotation check + append under a mutex) is blocking disk I/O. When this
    // runs inside the async runtime - which is most log calls, since services log from async
    // commands and background tasks - hand it to the blocking pool so a log line never stalls
    // a Tokio worker thread on a slow disk. Fire-and-forget is acceptable: logging is
    // best-effort and every line carries its own timestamp, so a slight reordering between
    // concurrent writers is harmless. Outside the runtime (Tauri's synchronous setup hook, the
    // app-exit sweep, tests) there is nothing to offload to, so write inline.
    match tokio::runtime::Handle::try_current() {
        Ok(_) => {
            let path = path.clone();
            // Detach the handle: this is fire-and-forget, and dropping a spawn_blocking handle
            // does not cancel the already-running write.
            drop(tauri::async_runtime::spawn_blocking(move || {
                append_line_locked(&path, &line)
            }));
        }
        Err(_) => append_line_locked(path, &line),
    }
}

pub fn info(scope: &str, message: impl AsRef<str>) {
    write("INFO", scope, message.as_ref());
}

pub fn warn(scope: &str, message: impl AsRef<str>) {
    write("WARN", scope, message.as_ref());
}

pub fn error(scope: &str, message: impl AsRef<str>) {
    write("ERROR", scope, message.as_ref());
}

#[cfg(test)]
mod tests {
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::*;

    fn temp_log(label: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("kavynex_log_{label}_{nanos}"));
        fs::create_dir_all(&dir).unwrap();
        dir.join("kavynex.log")
    }

    #[test]
    fn timestamp_string_is_a_readable_utc_rfc3339_timestamp() {
        let timestamp = timestamp_string();

        // e.g. "2026-07-06T12:34:56Z" - readable in a bug report, unlike raw epoch seconds.
        assert!(timestamp.ends_with('Z'), "{timestamp} should end with Z");
        assert!(timestamp.contains('T'), "{timestamp} should contain T");
        assert_eq!(timestamp.len(), "2026-07-06T12:34:56Z".len());
    }

    #[test]
    fn append_line_creates_and_appends() {
        let path = temp_log("append");

        append_line(&path, "first");
        append_line(&path, "second");

        let content = fs::read_to_string(&path).unwrap();
        assert!(content.contains("first"));
        assert!(content.contains("second"));

        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn rotate_moves_oversized_log_to_backup() {
        let path = temp_log("rotate");
        fs::write(&path, "0123456789").unwrap();

        rotate_if_needed(&path, 5);

        assert!(!path.exists());
        assert!(backup_path(&path).exists());
        assert_eq!(
            fs::read_to_string(backup_path(&path)).unwrap(),
            "0123456789"
        );

        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn rotate_keeps_log_under_limit() {
        let path = temp_log("small");
        fs::write(&path, "tiny").unwrap();

        rotate_if_needed(&path, 1024);

        assert!(path.exists());
        assert!(!backup_path(&path).exists());

        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn redact_path_keeps_only_the_final_component() {
        assert_eq!(
            redact_path(Path::new("/home/alice/library/video/clip.mp4")),
            "clip.mp4"
        );
        assert_eq!(redact_path("C:\\Users\\alice\\library"), "library");
    }
}
