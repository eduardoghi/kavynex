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
