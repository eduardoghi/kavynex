use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use chrono::{SecondsFormat, Utc};

const MAX_LOG_BYTES: u64 = 5 * 1024 * 1024;

static LOG_PATH: OnceLock<PathBuf> = OnceLock::new();
static LOG_LOCK: Mutex<()> = Mutex::new(());

/// File writes handed to the blocking pool that have not landed yet (see [`write`] and [`flush`]).
static PENDING_WRITES: AtomicUsize = AtomicUsize::new(0);

/// How long [`flush`] waits for the pending writes. A disk that takes longer than this is one the
/// exit should not hang on.
const FLUSH_TIMEOUT: Duration = Duration::from_secs(2);

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

/// Keeps a single rolled-over backup. When the log passes the size limit it is renamed to
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

/// Reduces a path to its final component for use in a log line. A log line can be pasted into
/// a public bug report, and an absolute Windows path embeds `C:\Users\<name>\...`, revealing
/// the OS username/profile. Mirrors the redaction the yt-dlp paths already receive
/// (services::yt_dlp::download::redact_paths_value).
///
/// Splits on both `/` and `\` on every platform. A path can come from a library synced from
/// Windows even when running on Unix, where `\` is not a separator and `Path::file_name` would
/// otherwise return the whole string unredacted. Falls back to `<path>` when no final
/// component remains (e.g. a root).
///
/// The cost of that is worth stating, because it is a real one rather than a theoretical one. On
/// Unix `\` is an ordinary filename character, so a file legitimately named `my\clip.mp4` is
/// logged as `clip.mp4`. That is over-redaction, which is the direction this function is allowed
/// to be wrong in. The alternative is a platform-conditional split that leaves a Windows-synced
/// path whole on Unix, i.e. exactly the username leak the whole function exists to prevent.
/// Treating the ambiguous case as a separator therefore loses a little diagnostic detail on a rare
/// name and never leaks; the other way round would leak on a common one.
pub fn redact_path(path: impl AsRef<Path>) -> String {
    let raw = path.as_ref().to_string_lossy();

    raw.rsplit(['/', '\\'])
        .find(|segment| !segment.trim().is_empty())
        .unwrap_or("<path>")
        .to_string()
}

/// The ways the user's home directory can be spelled in a log message: as the OS gives it, with
/// forward slashes, with the backslashes doubled by JSON, and percent-encoded the way the webview
/// writes a path into an `asset:` or `kvxmedia:` URL. Longest first, so a longer spelling is replaced
/// before a shorter one inside it could be.
fn home_dir_spellings(home: &str) -> Vec<String> {
    let home = home.trim_end_matches(['/', '\\']);

    // A home of `/` or a bare drive would turn every absolute path into `~`, and name nobody.
    if home
        .chars()
        .filter(|ch| !matches!(ch, '/' | '\\' | ':'))
        .count()
        < 3
    {
        return Vec::new();
    }

    let forward = home.replace('\\', "/");
    let mut spellings = vec![
        home.to_string(),
        forward.clone(),
        home.replace('\\', r"\\"),
        percent_encode_component(home),
        percent_encode_component(&forward),
    ];

    spellings.sort_by(|a, b| b.len().cmp(&a.len()).then_with(|| a.cmp(b)));
    spellings.dedup();
    spellings
}

/// What `encodeURIComponent` makes of `value`.
fn percent_encode_component(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());

    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            encoded.push(char::from(byte));
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }

    encoded
}

/// `line` with every spelling of the home directory replaced by `~`, ignoring ASCII case (Windows
/// paths are case-insensitive, and on Unix the cost is only redacting a little more). A match that
/// runs on into a longer name (`/home/ed` inside `/home/eduardo`) is left alone.
fn redact_home_dir_in(line: &str, spellings: &[String]) -> String {
    let mut redacted = line.to_string();

    for spelling in spellings {
        // ASCII lowercasing keeps every byte where it was, so an offset found in the lowered copy
        // is a char boundary in the original too.
        let haystack = redacted.to_ascii_lowercase();
        let needle = spelling.to_ascii_lowercase();
        let mut out = String::with_capacity(redacted.len());
        let mut copied = 0;
        let mut from = 0;

        while let Some(found) = haystack[from..].find(&needle) {
            let start = from + found;
            let end = start + needle.len();
            let ends_a_name = redacted[end..]
                .chars()
                .next()
                .is_none_or(|next| !(next.is_alphanumeric() || matches!(next, '_' | '-' | '.')));

            if ends_a_name {
                out.push_str(&redacted[copied..start]);
                out.push('~');
                copied = end;
            }

            from = end;
        }

        out.push_str(&redacted[copied..]);
        redacted = out;
    }

    redacted
}

/// Replaces the user's home directory in `line` with `~`. Every log line goes through it, since a
/// log is attached to bug reports and the home directory carries the OS user name. Paths the code
/// logs on purpose already go through [`redact_path`]. This one is for what arrives as text, a
/// child process's output or a stack trace the webview sent.
fn redact_home_dir(line: &str) -> String {
    static SPELLINGS: OnceLock<Vec<String>> = OnceLock::new();

    let spellings = SPELLINGS.get_or_init(|| {
        let variable = if cfg!(windows) { "USERPROFILE" } else { "HOME" };

        std::env::var(variable)
            .map(|home| home_dir_spellings(&home))
            .unwrap_or_default()
    });

    redact_home_dir_in(line, spellings)
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

/// The most characters one log entry keeps. A message is usually a sentence. One that carries a
/// child process's output can be megabytes, and a single entry over the rotation size pushed the
/// previous log out whole.
const MAX_MESSAGE_CHARS: usize = 16 * 1024;

/// One log line out of `message`. A line break in it is written as `\n` and any other control
/// character as a space, so the text a process printed cannot start what reads as a new entry with
/// its own timestamp and level, and the entry is cut at [`MAX_MESSAGE_CHARS`].
fn single_line(message: &str) -> String {
    let mut line = String::with_capacity(message.len().min(MAX_MESSAGE_CHARS));

    for (count, ch) in message.chars().enumerate() {
        if count == MAX_MESSAGE_CHARS {
            line.push_str("... (truncated)");
            break;
        }

        match ch {
            '\n' => line.push_str("\\n"),
            '\r' => line.push_str("\\r"),
            ch if ch.is_control() => line.push(' '),
            ch => line.push(ch),
        }
    }

    line
}

fn write(level: &str, scope: &str, message: &str) {
    let line = format!(
        "[{}] [{}] [{}] {}",
        timestamp_string(),
        level,
        scope,
        single_line(&redact_home_dir(message))
    );

    eprintln!("{line}");

    let Some(path) = LOG_PATH.get() else {
        return;
    };

    // The file write (rotation check + append under a mutex) is blocking disk I/O. When this
    // runs inside the async runtime (which is most log calls, since services log from async
    // commands and background tasks), hand it to the blocking pool so a log line never stalls
    // a Tokio worker thread on a slow disk. Fire-and-forget is acceptable. Logging is
    // best-effort and every line carries its own timestamp, so a slight reordering between
    // concurrent writers is harmless. Outside the runtime (Tauri's synchronous setup hook, the
    // app-exit sweep, tests) there is nothing to offload to, so write inline.
    match tokio::runtime::Handle::try_current() {
        Ok(_) => {
            let path = path.clone();
            PENDING_WRITES.fetch_add(1, Ordering::SeqCst);
            // Detach the handle. This is fire-and-forget, and dropping a spawn_blocking handle
            // does not cancel the already-running write.
            drop(tauri::async_runtime::spawn_blocking(move || {
                append_line_locked(&path, &line);
                PENDING_WRITES.fetch_sub(1, Ordering::SeqCst);
            }));
        }
        Err(_) => append_line_locked(path, &line),
    }
}

/// Waits, up to [`FLUSH_TIMEOUT`], for the log lines handed to the blocking pool to reach the file.
///
/// For the code right before a `std::process::exit`, which ends the process without waiting for the
/// pool. The line that says why the process is exiting is the one most likely to be lost otherwise,
/// since it is the last one written.
pub fn flush() {
    let deadline = Instant::now() + FLUSH_TIMEOUT;

    while PENDING_WRITES.load(Ordering::SeqCst) > 0 && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(5));
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
    use super::*;

    fn temp_log(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "kavynex_log_{label}_{}",
            crate::utils::naming::unique_temp_suffix()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir.join("kavynex.log")
    }

    #[test]
    fn timestamp_string_is_a_readable_utc_rfc3339_timestamp() {
        let timestamp = timestamp_string();

        // e.g. "2026-07-06T12:34:56Z". Readable in a bug report, unlike raw epoch seconds.
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
    fn a_log_entry_stays_on_one_line_whatever_the_message_carries() {
        let forged = "download failed\n[2026-10-10T00:00:00Z] [INFO] [app] all good\r\tdone";

        assert_eq!(
            single_line(forged),
            "download failed\\n[2026-10-10T00:00:00Z] [INFO] [app] all good\\r done"
        );
    }

    #[test]
    fn a_huge_log_entry_is_cut_rather_than_rotating_the_log_away() {
        let huge = "x".repeat(MAX_MESSAGE_CHARS * 4);
        let line = single_line(&huge);

        assert!(line.ends_with("... (truncated)"));
        assert_eq!(
            line.chars().count(),
            MAX_MESSAGE_CHARS + "... (truncated)".len()
        );
    }

    #[test]
    fn flush_returns_at_once_with_nothing_pending() {
        let started = Instant::now();
        flush();
        assert!(started.elapsed() < FLUSH_TIMEOUT);
    }

    #[test]
    fn the_home_directory_is_redacted_in_every_spelling_a_message_carries() {
        let spellings = home_dir_spellings(r"C:\Users\Eduardo\");

        let line = concat!(
            r"failed at C:\Users\Eduardo\Videos\a.mp4, ",
            r"c:/users/eduardo/AppData/x.js, ",
            r#"{"path":"C:\\Users\\Eduardo\\b.db"}, "#,
            "http://asset.localhost/C%3A%5CUsers%5CEduardo%5Cthumb.jpg"
        );

        assert_eq!(
            redact_home_dir_in(line, &spellings),
            concat!(
                r"failed at ~\Videos\a.mp4, ",
                r"~/AppData/x.js, ",
                r#"{"path":"~\\b.db"}, "#,
                "http://asset.localhost/~%5Cthumb.jpg"
            )
        );
    }

    #[test]
    fn a_longer_name_that_starts_like_the_home_directory_is_not_cut() {
        let spellings = home_dir_spellings("/home/ed");

        assert_eq!(
            redact_home_dir_in("/home/eduardo/a and /home/ed/b and /home/ed", &spellings),
            "/home/eduardo/a and ~/b and ~"
        );
    }

    #[test]
    fn a_root_or_bare_drive_home_redacts_nothing() {
        assert!(home_dir_spellings("/").is_empty());
        assert!(home_dir_spellings(r"C:\").is_empty());
    }

    #[test]
    fn redact_path_keeps_only_the_final_component() {
        assert_eq!(
            redact_path(Path::new("/home/alice/library/video/clip.mp4")),
            "clip.mp4"
        );
        assert_eq!(redact_path("C:\\Users\\alice\\library"), "library");
    }

    #[test]
    fn redact_path_treats_a_backslash_as_a_separator_even_where_it_is_a_valid_name_character() {
        // The accepted cost of splitting on both separators everywhere, pinned so it reads as a
        // decision rather than as an oversight. On Unix this name is one file, and it is redacted
        // as though it were two segments. Over-redaction is the direction this is allowed to be
        // wrong in, making the split platform-conditional would leave a Windows-synced path whole
        // on Unix, which is the username leak the function exists to prevent. A change that
        // "fixed" this case has to delete this test first.
        assert_eq!(redact_path("/home/alice/my\\clip.mp4"), "clip.mp4");
    }
}
