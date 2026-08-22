use std::io::Read;
use std::path::Path;

use crate::utils::path::is_network_path;

fn has_txt_extension(path: &Path) -> bool {
    path.extension()
        .and_then(|value| value.to_str())
        .map(|value| value.eq_ignore_ascii_case("txt"))
        .unwrap_or(false)
}

/// The two first-line prefixes a Netscape cookie file may carry.
///
/// Taken from what yt-dlp actually accepts rather than from the spec: it loads the file through
/// Python's `http.cookiejar.MozillaCookieJar`, whose magic is `#( Netscape)? HTTP Cookie File`
/// matched at the start of the first line. Verified against yt-dlp 2026.07.04, which accepts these
/// two (and anything appended after them on the same line) and rejects `#Netscape...` without the
/// space, a lowercased spelling, a leading blank line, and a header preceded by another comment.
const COOKIE_FILE_HEADERS: [&str; 2] = ["# Netscape HTTP Cookie File", "# HTTP Cookie File"];

/// How many bytes are read to answer [`has_cookie_file_header`]. Only the first line matters, and
/// the longest header is 27 bytes, so this is generous while keeping the check a single small read
/// rather than a load of a file whose size the caller chose.
const COOKIE_HEADER_PROBE_BYTES: usize = 64;

/// True when the file starts with a Netscape cookie-file header.
///
/// This exists because yt-dlp does not only *read* the path given to `--cookies`, it **rewrites the
/// whole file** at the end of a run with the cookies it acquired (verified against yt-dlp
/// 2026.07.04). So the extension gate alone left the "an arbitrary file is not destroyed" property
/// resting on yt-dlp's own format check refusing to load it first. That is a guarantee owned by an
/// external tool whose version this app does not control and whose output format it already treats
/// as unstable elsewhere, which is the same reasoning `services::binaries` uses to refuse `.bat`
/// shims outright instead of trusting the compiler's BatBadBut fix to hold across every build.
///
/// Reading the header here moves the guarantee back to this side of the boundary: a `.txt` that is
/// not a cookie jar is refused before its path can reach an argv, so nothing can overwrite it. A
/// real cookie file is unaffected, because this is the same header yt-dlp itself requires.
fn has_cookie_file_header(path: &Path) -> bool {
    let Ok(mut file) = std::fs::File::open(path) else {
        return false;
    };

    let mut probe = [0u8; COOKIE_HEADER_PROBE_BYTES];
    let mut filled = 0;

    // `read` is allowed to return fewer bytes than asked for without being at EOF, so loop until
    // the buffer is full or the file ends. A single read would otherwise reject a valid file on a
    // short read, which is rare enough to never show up in testing and would surface as "my cookies
    // file is sometimes ignored".
    while filled < probe.len() {
        match file.read(&mut probe[filled..]) {
            Ok(0) => break,
            Ok(read) => filled += read,
            Err(_) => return false,
        }
    }

    let head = String::from_utf8_lossy(&probe[..filled]);

    COOKIE_FILE_HEADERS
        .iter()
        .any(|header| head.starts_with(header))
}

pub fn normalize_cookies_path(value: Option<&str>) -> Option<String> {
    let normalized = value?.trim();

    if normalized.is_empty() {
        return None;
    }

    // Refuse a UNC / network location before the `is_file()` below touches it. Merely stat'ing
    // one on Windows makes the OS authenticate to `host` over SMB, leaking the user's NTLM hash
    // to whoever controls it, and this value arrives raw over IPC, so the check has to happen
    // here rather than resting on the picker. Same guard, for the same reason, as
    // library::resolve_path_inside_library and thumbnail::temp::validate_source_media_path; this
    // path was the one caller-supplied path left without it. A cookies file kept on a share
    // loses only the ability to be pointed at directly (copy it locally first).
    if is_network_path(normalized) {
        return None;
    }

    let path = Path::new(normalized);

    // Only accept an existing `.txt` file that really is a cookie jar. The extension mirrors the
    // picker's own filter and turns a mistyped path into a clean refusal; the header check is what
    // makes the refusal a property of this app rather than of yt-dlp's parser, which matters
    // because `--cookies` is a path yt-dlp *writes back to* (see `has_cookie_file_header`).
    if path.is_file() && has_txt_extension(path) && has_cookie_file_header(path) {
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

/// The browsers yt-dlp's `--cookies-from-browser` can read, spelled the way yt-dlp spells them.
const SUPPORTED_BROWSERS: [&str; 9] = [
    "brave", "chrome", "chromium", "edge", "firefox", "opera", "safari", "vivaldi", "whale",
];

/// The keyrings yt-dlp accepts after `+` on a Chromium-based browser (Linux only, for the cookie
/// decryption backend). yt-dlp compares them case-insensitively, so the lowercase spelling is the
/// one stored.
const SUPPORTED_KEYRINGS: [&str; 5] = [
    "basictext",
    "gnomekeyring",
    "kwallet",
    "kwallet5",
    "kwallet6",
];

/// Upper bound on the whole selector. A profile can be a path, so it is generous, but a value
/// arriving over IPC still gets a ceiling before anything is split or handed to an argv.
const MAX_COOKIES_BROWSER_SELECTOR_CHARS: usize = 512;

/// A parsed `--cookies-from-browser` value, `BROWSER[+KEYRING][:PROFILE][::CONTAINER]`.
///
/// Only the browser used to be accepted, as a bare name, which left anyone with more than one
/// Firefox profile (or a Chromium whose keyring yt-dlp does not guess right) unable to use the
/// option at all: yt-dlp would read the default profile, find no session, and the download failed
/// with nothing saying why. The grammar here is yt-dlp's own (`--cookies-from-browser` in its
/// README), validated part by part so the value that reaches the argv is still one this side chose
/// to allow. The browser and the keyring are allow-listed; the profile and the container are free
/// text (a profile is often a path) bounded to what an argument may safely carry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CookiesBrowserSelector {
    browser: String,
    keyring: Option<String>,
    profile: Option<String>,
    container: Option<String>,
}

impl CookiesBrowserSelector {
    /// The value handed to yt-dlp: browser and keyring lowercased, whitespace around the separators
    /// dropped, profile and container exactly as typed (profile names are case-sensitive on Linux).
    pub(crate) fn to_argument(&self) -> String {
        let mut value = self.browser.clone();

        if let Some(keyring) = &self.keyring {
            value.push('+');
            value.push_str(keyring);
        }

        if let Some(profile) = &self.profile {
            value.push(':');
            value.push_str(profile);
        }

        if let Some(container) = &self.container {
            value.push_str("::");
            value.push_str(container);
        }

        value
    }

    /// The form a log line or the in-app terminal may show. The browser and the keyring say which
    /// tool was used and reveal nothing; the profile can be a path under the user's home directory
    /// (so it carries the OS username) and the container a name the user chose, so both are
    /// replaced. The separators are kept so the line still says *that* a profile was set.
    pub(crate) fn to_redacted(&self) -> String {
        let mut value = self.browser.clone();

        if let Some(keyring) = &self.keyring {
            value.push('+');
            value.push_str(keyring);
        }

        if self.profile.is_some() {
            value.push_str(":<redacted>");
        }

        if self.container.is_some() {
            value.push_str("::<redacted>");
        }

        value
    }
}

/// True for a profile or container value that may travel as part of one argv element: non-empty,
/// not something yt-dlp's option parser could read as a flag, and free of control characters (a
/// newline would also forge a line in the file log, where the redacted form is written).
fn is_safe_selector_component(value: &str) -> bool {
    !value.is_empty() && !value.starts_with('-') && !value.chars().any(char::is_control)
}

/// Parses `BROWSER[+KEYRING][:PROFILE][::CONTAINER]`, or `None` for anything that is not a
/// selector this app will hand to yt-dlp.
///
/// The split order mirrors yt-dlp's own regex: the container comes after the first `::`, the
/// profile after the first `:` before it (a Windows path in the profile keeps its drive colon,
/// since only the first one separates), and the keyring after a `+` in the browser part.
/// Whitespace around each separator is dropped, as yt-dlp does.
pub(crate) fn parse_cookies_browser_selector(value: &str) -> Option<CookiesBrowserSelector> {
    let trimmed = value.trim();

    if trimmed.is_empty()
        || trimmed.chars().count() > MAX_COOKIES_BROWSER_SELECTOR_CHARS
        || trimmed.chars().any(char::is_control)
    {
        return None;
    }

    let (head, container) = match trimmed.split_once("::") {
        Some((head, container)) => (head, Some(container.trim())),
        None => (trimmed, None),
    };

    let (browser_and_keyring, profile) = match head.split_once(':') {
        Some((browser_and_keyring, profile)) => (browser_and_keyring, Some(profile.trim())),
        None => (head, None),
    };

    let (browser, keyring) = match browser_and_keyring.split_once('+') {
        Some((browser, keyring)) => (browser, Some(keyring.trim())),
        None => (browser_and_keyring, None),
    };

    let browser = browser.trim().to_lowercase();

    if !SUPPORTED_BROWSERS.contains(&browser.as_str()) {
        return None;
    }

    let keyring = match keyring {
        Some(keyring) => {
            let keyring = keyring.to_lowercase();

            if !SUPPORTED_KEYRINGS.contains(&keyring.as_str()) {
                return None;
            }

            Some(keyring)
        }
        None => None,
    };

    if let Some(profile) = profile {
        if !is_safe_selector_component(profile) {
            return None;
        }
    }

    if let Some(container) = container {
        // A container that itself starts with `:` is the `firefox:::x` shape: yt-dlp parses it, as
        // a container literally named `:x`, but nothing a user means is spelled that way, and
        // accepting it would make the selector's meaning depend on how many colons were typed.
        if !is_safe_selector_component(container) || container.starts_with(':') {
            return None;
        }
    }

    Some(CookiesBrowserSelector {
        browser,
        keyring,
        profile: profile.map(str::to_string),
        container: container.map(str::to_string),
    })
}

/// Normalizes a caller-supplied `--cookies-from-browser` value to the form handed to yt-dlp, or
/// `None` when it is not one this app allows (see [`parse_cookies_browser_selector`]). An invalid
/// value is dropped rather than raised, matching [`normalize_cookies_path`]: the run proceeds
/// without cookies, and the frontend validates the same grammar before the round trip so a user
/// typing an unusable profile is told there rather than here.
pub fn normalize_cookies_browser(value: Option<&str>) -> Option<String> {
    parse_cookies_browser_selector(value?).map(|selector| selector.to_argument())
}

/// The form of a `--cookies-from-browser` value that may be written to a log or shown in the
/// in-app terminal: the browser and keyring kept, the profile and container replaced. A value
/// that does not parse is fully replaced, since nothing about it is known to be safe to show.
pub fn redact_cookies_browser_selector(value: &str) -> String {
    match parse_cookies_browser_selector(value) {
        Some(selector) => selector.to_redacted(),
        None => "<redacted>".to_string(),
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

    /// Writes a file that passes the header check, for the tests whose subject is something else
    /// (the extension gate, the precedence between file and browser). They would otherwise all be
    /// passing for the wrong reason once the header is required.
    fn write_cookie_jar(path: &std::path::Path) {
        fs::write(path, b"# Netscape HTTP Cookie File\n").unwrap();
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

        for browser in SUPPORTED_BROWSERS {
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
    fn normalize_cookies_browser_matches_the_shared_fixture() {
        // The frontend composes the selector from the browser combo and the profile field and
        // validates it with its own copy of this grammar (src/constants/cookies-browsers.ts), so
        // both sides assert the same cases: a value the frontend lets through must be one the
        // backend hands to yt-dlp, and in the exact same spelling, or the user is silently
        // downloading without cookies after being told the profile was accepted.
        let raw = include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../shared/cookies-browser-selector-cases.json"
        ));
        let cases: serde_json::Value =
            serde_json::from_str(raw).expect("the shared fixture must be valid JSON");

        for case in cases["valid"].as_array().expect("valid must be an array") {
            let input = case["input"].as_str().expect("input must be a string");
            let normalized = case["normalized"]
                .as_str()
                .expect("normalized must be a string");

            assert_eq!(
                normalize_cookies_browser(Some(input)).as_deref(),
                Some(normalized),
                "the shared fixture marks {input:?} valid with normalized form {normalized:?}"
            );
        }

        for value in cases["invalid"]
            .as_array()
            .expect("invalid must be an array")
        {
            let value = value.as_str().expect("each case must be a string");

            assert_eq!(
                normalize_cookies_browser(Some(value)),
                None,
                "the shared fixture marks {value:?} invalid but Rust accepts it"
            );
        }
    }

    #[test]
    fn the_selector_parts_land_where_yt_dlp_reads_them() {
        // Each part pinned individually, not only through the round-tripped string, so a swapped
        // split (profile and container traded, say) cannot hide behind an argument that happens to
        // read back the same.
        let selector =
            parse_cookies_browser_selector(" Chromium + KWallet5 : Work Profile :: Work ")
                .expect("a full selector must parse");

        assert_eq!(selector.browser, "chromium");
        assert_eq!(selector.keyring.as_deref(), Some("kwallet5"));
        assert_eq!(selector.profile.as_deref(), Some("Work Profile"));
        assert_eq!(selector.container.as_deref(), Some("Work"));
        assert_eq!(
            selector.to_argument(),
            "chromium+kwallet5:Work Profile::Work"
        );

        // The first colon separates; the drive colon of a Windows path stays inside the profile.
        let windows = parse_cookies_browser_selector(
            r"chrome:C:\Users\me\AppData\Local\Google\Chrome\User Data\Default",
        )
        .expect("a Windows profile path must parse");
        assert_eq!(
            windows.profile.as_deref(),
            Some(r"C:\Users\me\AppData\Local\Google\Chrome\User Data\Default")
        );
        assert_eq!(windows.container, None);
    }

    #[test]
    fn normalize_cookies_browser_bounds_the_selector_length() {
        let long_profile = "a".repeat(MAX_COOKIES_BROWSER_SELECTOR_CHARS);

        assert_eq!(
            normalize_cookies_browser(Some(&format!("firefox:{long_profile}"))),
            None,
            "a selector past the ceiling must be refused"
        );

        let fitting_profile = "a".repeat(MAX_COOKIES_BROWSER_SELECTOR_CHARS - "firefox:".len());

        assert!(
            normalize_cookies_browser(Some(&format!("firefox:{fitting_profile}"))).is_some(),
            "a selector exactly at the ceiling is still accepted"
        );
    }

    #[test]
    fn redact_cookies_browser_selector_keeps_the_tool_and_hides_the_profile() {
        // A bare browser (the common case) reads back unchanged: it names a tool and nothing about
        // the user. A profile is a path or a name the user chose, so it goes, with the separator
        // kept so the line still says a profile was set. The keyring is a backend name and stays.
        assert_eq!(redact_cookies_browser_selector("firefox"), "firefox");
        assert_eq!(
            redact_cookies_browser_selector("firefox:/home/alice/.mozilla/firefox/abc.default"),
            "firefox:<redacted>"
        );
        assert_eq!(
            redact_cookies_browser_selector("firefox::Personal"),
            "firefox::<redacted>"
        );
        assert_eq!(
            redact_cookies_browser_selector("chromium+gnomekeyring:Default::Work"),
            "chromium+gnomekeyring:<redacted>::<redacted>"
        );

        // A value that does not parse has nothing known to be safe, so all of it goes.
        assert_eq!(redact_cookies_browser_selector("netscape:x"), "<redacted>");
        assert_eq!(redact_cookies_browser_selector(""), "<redacted>");
    }

    #[test]
    fn append_auth_args_passes_a_full_selector_through_normalized() {
        // The whole point of the grammar: the profile the user typed has to reach yt-dlp, in the
        // spelling yt-dlp reads, as the single argument after the flag.
        let mut args: Vec<String> = Vec::new();
        append_auth_args(&mut args, Some(" Firefox : default-release :: Work "), None);

        assert_eq!(
            args,
            vec![
                "--cookies-from-browser".to_string(),
                "firefox:default-release::Work".to_string()
            ]
        );

        // And a selector the grammar refuses adds nothing, rather than a bare browser it was not
        // asked for: reading the wrong profile is the failure this exists to prevent.
        let mut refused: Vec<String> = Vec::new();
        append_auth_args(&mut refused, Some("firefox:-x"), None);
        assert!(refused.is_empty());
    }

    #[test]
    fn normalize_cookies_path_accepts_existing_file_only() {
        let file = unique_temp_path("cookies.txt");
        write_cookie_jar(&file);

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
        write_cookie_jar(&file);

        assert_eq!(normalize_cookies_path(Some(file.to_str().unwrap())), None);

        let _ = fs::remove_file(&file);
    }

    #[test]
    fn normalize_cookies_path_rejects_a_txt_that_is_not_a_cookie_jar() {
        // The point of the header check, and the reason the extension gate is not enough on its
        // own: yt-dlp rewrites the whole file it is handed through `--cookies`, so accepting any
        // `.txt` left "this note is not destroyed" resting on yt-dlp's parser refusing it first.
        // The file's content is what must decide, and it must decide before the path can reach an
        // argv.
        for content in [
            &b"MY IMPORTANT NOTES\nline two\n"[..],
            // A cookie *data* line with no header: this is the near-miss most likely to appear by
            // hand, and yt-dlp refuses it too.
            b".youtube.com\tTRUE\t/\tTRUE\t0\tPREF\thl=en\n",
            // Header present but not first: a comment ahead of it is refused by yt-dlp, so
            // accepting it here would hand over a path that then fails to load anyway.
            b"# Exported by some extension\n# Netscape HTTP Cookie File\n",
            // Header spellings yt-dlp rejects: no space after the hash, and a lowercased form.
            b"#Netscape HTTP Cookie File\n",
            b"# netscape http cookie file\n",
            // Empty file: nothing to match, and nothing worth overwriting either, but the answer
            // must be the same refusal rather than an accidental accept on an empty prefix.
            b"",
        ] {
            let file = unique_temp_path("not-a-jar.txt");
            fs::write(&file, content).unwrap();

            assert_eq!(
                normalize_cookies_path(Some(file.to_str().unwrap())),
                None,
                "a .txt that is not a cookie jar must be refused: {:?}",
                String::from_utf8_lossy(content)
            );

            let _ = fs::remove_file(&file);
        }
    }

    #[test]
    fn normalize_cookies_path_accepts_every_header_yt_dlp_accepts() {
        // The other direction, and the one that keeps this check from being a regression for a
        // user with a real cookies file. These are the spellings yt-dlp 2026.07.04 loads:
        // both magic forms, and either one with anything appended on the same line. Rejecting a
        // legitimate export would surface as "the cookies option silently does nothing".
        for content in [
            &b"# Netscape HTTP Cookie File\n"[..],
            b"# HTTP Cookie File\n",
            b"# Netscape HTTP Cookie File\n# This file is generated by yt-dlp.  Do not edit.\n",
            b"# Netscape HTTP Cookie File extra words here\n",
            // No trailing newline at all: the header is the whole file.
            b"# Netscape HTTP Cookie File",
        ] {
            let file = unique_temp_path("real-jar.txt");
            fs::write(&file, content).unwrap();

            assert_eq!(
                normalize_cookies_path(Some(file.to_str().unwrap())).as_deref(),
                Some(file.to_str().unwrap()),
                "a real cookie jar must be accepted: {:?}",
                String::from_utf8_lossy(content)
            );

            let _ = fs::remove_file(&file);
        }
    }

    #[test]
    fn the_header_check_reads_only_the_head_of_a_large_file() {
        // A cookies file the caller chose the size of must not be loaded to answer a question the
        // first line settles. Written far past the probe size so a change to reading the whole file
        // would still pass functionally but is pinned here by intent.
        let file = unique_temp_path("large-jar.txt");
        let mut content = b"# Netscape HTTP Cookie File\n".to_vec();
        content.extend(std::iter::repeat_n(b'x', 512 * 1024));
        fs::write(&file, &content).unwrap();

        assert!(content.len() > COOKIE_HEADER_PROBE_BYTES * 100);
        assert_eq!(
            normalize_cookies_path(Some(file.to_str().unwrap())).as_deref(),
            Some(file.to_str().unwrap())
        );

        let _ = fs::remove_file(&file);
    }

    #[test]
    fn append_auth_args_drops_a_txt_that_is_not_a_cookie_jar() {
        // The refusal has to reach the argv builder, not just the normalizer: what must never
        // happen is `--cookies <path to the user's notes>` being spawned, because that is the
        // moment the file gets overwritten.
        let file = unique_temp_path("notes.txt");
        fs::write(&file, b"MY IMPORTANT NOTES\n").unwrap();

        let mut args: Vec<String> = Vec::new();
        append_auth_args(&mut args, Some("firefox"), Some(file.to_str().unwrap()));

        assert_eq!(
            args,
            vec!["--cookies-from-browser".to_string(), "firefox".to_string()],
            "a rejected cookies file must fall back to the browser, never pass the path through"
        );

        let mut only_notes: Vec<String> = Vec::new();
        append_auth_args(&mut only_notes, None, Some(file.to_str().unwrap()));
        assert!(only_notes.is_empty());

        // The file is still there, untouched: nothing in this flow could have handed it over.
        assert_eq!(fs::read(&file).unwrap(), b"MY IMPORTANT NOTES\n");

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
        write_cookie_jar(&file);

        assert_eq!(
            normalize_cookies_path(Some(file.to_str().unwrap())).as_deref(),
            Some(file.to_str().unwrap())
        );

        let _ = fs::remove_file(&file);
    }

    #[test]
    fn append_auth_args_prefers_cookies_file_over_browser() {
        let file = unique_temp_path("cookies-precedence.txt");
        write_cookie_jar(&file);

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
