use std::path::Path;

use crate::utils::path::is_network_path;

fn has_txt_extension(path: &Path) -> bool {
    path.extension()
        .and_then(|value| value.to_str())
        .map(|value| value.eq_ignore_ascii_case("txt"))
        .unwrap_or(false)
}

pub fn normalize_cookies_path(value: Option<&str>) -> Option<String> {
    let normalized = value?.trim();

    if normalized.is_empty() {
        return None;
    }

    // Refuse a UNC / network location before the `is_file()` below touches it. Merely stat'ing
    // one on Windows makes the OS authenticate to `host` over SMB, leaking the user's NTLM hash
    // to whoever controls it - and this value arrives raw over IPC, so the check has to happen
    // here rather than resting on the picker. Same guard, for the same reason, as
    // library::resolve_path_inside_library and thumbnail_temp::validate_source_media_path; this
    // path was the one caller-supplied path left without it. A cookies file kept on a share
    // loses only the ability to be pointed at directly (copy it locally first).
    if is_network_path(normalized) {
        return None;
    }

    let path = Path::new(normalized);

    // Only accept an existing `.txt` file. The cookies file is handed to yt-dlp's
    // `--cookies`, so restricting the extension (mirroring the picker's own check) keeps a
    // compromised frontend from pointing it at an arbitrary file on disk.
    if path.is_file() && has_txt_extension(path) {
        Some(normalized.to_string())
    } else {
        None
    }
}

pub fn append_auth_args(
    args: &mut Vec<String>,
    cookies_browser: Option<&str>,
    cookies_path: Option<&str>,
) {
    if let Some(path) = normalize_cookies_path(cookies_path) {
        args.push("--cookies".to_string());
        args.push(path);
        return;
    }

    if let Some(browser) = normalize_cookies_browser(cookies_browser) {
        args.push("--cookies-from-browser".to_string());
        args.push(browser);
    }
}

pub fn normalize_cookies_browser(value: Option<&str>) -> Option<String> {
    let normalized = value?.trim().to_lowercase();

    match normalized.as_str() {
        "brave" | "chrome" | "chromium" | "edge" | "firefox" | "opera" | "safari" | "vivaldi"
        | "whale" => Some(normalized),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// `file_name` goes last, and has to: callers pass a real file name (`cookies.txt`,
    /// `cookies.dat`, `cookies.TXT`) because the function under test gates on the `.txt`
    /// extension, so anything appended after it would strip the extension the assertion depends on.
    fn unique_temp_path(file_name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "kavynex-cookies-test-{}-{file_name}",
            crate::utils::naming::unique_temp_suffix()
        ))
    }

    #[test]
    fn normalize_cookies_browser_accepts_known_browsers_case_insensitively() {
        assert_eq!(
            normalize_cookies_browser(Some("Firefox")).as_deref(),
            Some("firefox")
        );
        assert_eq!(
            normalize_cookies_browser(Some("  CHROME ")).as_deref(),
            Some("chrome")
        );

        for browser in [
            "brave", "chrome", "chromium", "edge", "firefox", "opera", "safari", "vivaldi", "whale",
        ] {
            assert_eq!(
                normalize_cookies_browser(Some(browser)).as_deref(),
                Some(browser)
            );
        }
    }

    #[test]
    fn normalize_cookies_browser_rejects_unknown_and_empty() {
        assert_eq!(normalize_cookies_browser(Some("netscape")), None);
        assert_eq!(normalize_cookies_browser(Some("")), None);
        assert_eq!(normalize_cookies_browser(Some("   ")), None);
        assert_eq!(normalize_cookies_browser(None), None);
    }

    #[test]
    fn normalize_cookies_path_accepts_existing_file_only() {
        let file = unique_temp_path("cookies.txt");
        fs::write(&file, b"# cookies").unwrap();

        assert_eq!(
            normalize_cookies_path(Some(file.to_str().unwrap())).as_deref(),
            Some(file.to_str().unwrap())
        );

        let _ = fs::remove_file(&file);
    }

    #[test]
    fn normalize_cookies_path_rejects_missing_empty_and_directory() {
        assert_eq!(normalize_cookies_path(None), None);
        assert_eq!(normalize_cookies_path(Some("")), None);
        assert_eq!(normalize_cookies_path(Some("   ")), None);
        assert_eq!(
            normalize_cookies_path(Some("/nonexistent/kavynex/cookies.txt")),
            None
        );

        let dir = unique_temp_path("dir");
        fs::create_dir_all(&dir).unwrap();
        assert_eq!(normalize_cookies_path(Some(dir.to_str().unwrap())), None);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn normalize_cookies_path_rejects_non_txt_file() {
        let file = unique_temp_path("cookies.dat");
        fs::write(&file, b"# cookies").unwrap();

        assert_eq!(normalize_cookies_path(Some(file.to_str().unwrap())), None);

        let _ = fs::remove_file(&file);
    }

    #[test]
    fn normalize_cookies_path_rejects_a_network_location() {
        // A UNC path must be refused before `is_file()` stats it: on Windows that alone
        // authenticates to the host over SMB and leaks the user's NTLM hash. Every spelling
        // Windows resolves to a share is covered, including the mixed separators a literal
        // `\\` prefix match would miss. The `.txt` extension is deliberately correct on each
        // one, so only the network check can be what rejects them.
        for value in [
            r"\\evil\share\cookies.txt",
            "//evil/share/cookies.txt",
            r"/\evil\share\cookies.txt",
            r"\/evil\share\cookies.txt",
            r"\\?\UNC\evil\share\cookies.txt",
            "   \\\\evil\\share\\cookies.txt   ",
        ] {
            assert_eq!(
                normalize_cookies_path(Some(value)),
                None,
                "a network cookies path should be refused: {value}"
            );
        }
    }

    #[test]
    fn append_auth_args_drops_a_network_cookies_path_and_falls_back_to_the_browser() {
        // The refusal above must reach the argv builder: a rejected cookies file leaves
        // `--cookies` off entirely rather than passing the UNC through to yt-dlp, and the
        // browser source (which normally loses the precedence contest) takes over.
        let mut args: Vec<String> = Vec::new();
        append_auth_args(
            &mut args,
            Some("firefox"),
            Some(r"\\evil\share\cookies.txt"),
        );

        assert_eq!(
            args,
            vec!["--cookies-from-browser".to_string(), "firefox".to_string()]
        );

        // With no browser to fall back to, nothing is appended at all.
        let mut only_unc: Vec<String> = Vec::new();
        append_auth_args(&mut only_unc, None, Some(r"\\evil\share\cookies.txt"));
        assert!(only_unc.is_empty());
    }

    #[test]
    fn normalize_cookies_path_accepts_txt_case_insensitively() {
        let file = unique_temp_path("cookies.TXT");
        fs::write(&file, b"# cookies").unwrap();

        assert_eq!(
            normalize_cookies_path(Some(file.to_str().unwrap())).as_deref(),
            Some(file.to_str().unwrap())
        );

        let _ = fs::remove_file(&file);
    }

    #[test]
    fn append_auth_args_prefers_cookies_file_over_browser() {
        let file = unique_temp_path("cookies-precedence.txt");
        fs::write(&file, b"# cookies").unwrap();

        let mut args: Vec<String> = Vec::new();
        append_auth_args(&mut args, Some("firefox"), Some(file.to_str().unwrap()));

        assert_eq!(
            args,
            vec!["--cookies".to_string(), file.to_string_lossy().to_string()]
        );

        let _ = fs::remove_file(&file);
    }

    #[test]
    fn append_auth_args_uses_browser_when_no_cookies_file() {
        let mut args: Vec<String> = Vec::new();
        append_auth_args(&mut args, Some("firefox"), None);
        assert_eq!(
            args,
            vec!["--cookies-from-browser".to_string(), "firefox".to_string()]
        );
    }

    #[test]
    fn append_auth_args_ignores_invalid_browser_and_missing_file() {
        let mut args: Vec<String> = Vec::new();
        append_auth_args(
            &mut args,
            Some("netscape"),
            Some("/nonexistent/cookies.txt"),
        );
        assert!(args.is_empty());

        let mut empty: Vec<String> = Vec::new();
        append_auth_args(&mut empty, None, None);
        assert!(empty.is_empty());
    }
}
