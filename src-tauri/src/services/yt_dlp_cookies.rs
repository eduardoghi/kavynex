pub fn normalize_cookies_browser(value: Option<&str>) -> Option<String> {
    let normalized = value?.trim().to_lowercase();

    match normalized.as_str() {
        "brave" | "chrome" | "chromium" | "edge" | "firefox" | "opera" | "safari" | "vivaldi"
        | "whale" => Some(normalized),
        _ => None,
    }
}
