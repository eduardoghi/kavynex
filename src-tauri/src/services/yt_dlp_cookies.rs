use std::path::Path;

pub fn normalize_cookies_path(value: Option<&str>) -> Option<String> {
    let normalized = value?.trim();

    if normalized.is_empty() {
        return None;
    }

    let path = Path::new(normalized);

    if path.exists() && path.is_file() {
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
    use std::time::{SystemTime, UNIX_EPOCH};

    fn unique_temp_path(suffix: &str) -> std::path::PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|value| value.as_nanos())
            .unwrap_or(0);

        std::env::temp_dir().join(format!(
            "kavynex-cookies-test-{}-{}-{}",
            std::process::id(),
            nanos,
            suffix
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
