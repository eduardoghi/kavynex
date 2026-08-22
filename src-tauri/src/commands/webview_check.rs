//! The startup self-check that runs *inside* the webview.
//!
//! `--smoke-test` (see `crate::is_smoke_test_run`) proves the process loads, every plugin
//! registers and `setup()` completes, and then exits before the event loop starts. Everything
//! after that point is unverified by any gate in the pipeline: `cargo test` links the `rlib` and
//! never initializes the runtime or the webview, and `pnpm build` only emits the frontend bundle.
//! Three things live in that gap, and each has a failure mode that reaches the user as an app that
//! opens to a blank window or a feature that silently rejects:
//!
//! - **The renderer loads at all.** A bundle the webview refuses, or a CSP that blocks the entry
//!   script, is invisible until someone opens the app.
//! - **The Tauri ACL.** `src-tauri/capabilities/` gates what the *renderer* may call, and it is
//!   evaluated at runtime only. A permission that is missing from the grant list fails on the first
//!   call the user makes, not at build time. This is the reason the module exists: the grant list
//!   was narrowed from the scaffolded `core:default` to the exact set the seam uses, which is the
//!   right thing to have done and also exactly the change where a miss is silent.
//! - **The packaged CSP.** Tauri injects `tauri.conf.json`'s `csp` only in a bundled app. `pnpm
//!   tauri dev` serves the page from the Vite origin with no CSP header at all (see `docs/THREAT-MODEL.md`).
//!   So `img-src`'s `asset:` / `http://asset.localhost` tokens (without which every thumbnail and
//!   every video silently fails to load) are exercised by a packaged build and nothing else.
//!
//! `--webview-check` covers all three: the window opens normally, the frontend
//! (`src/lib/webview-check.ts`) drives one call of each family and reports the outcome back
//! through [`report_webview_check`], and the process exits 0 or 1. A frontend that never loads
//! reports nothing, which the watchdog in `lib.rs` turns into a non-zero exit rather than a hang.
//!
//! **What it does not cover, stated plainly:** the plugin grants that cannot be exercised without a
//! human or a side effect. `dialog:allow-open`/`allow-save` (would open a file picker),
//! `opener:allow-open-url` (would launch a browser), `updater:default` (would reach the network)
//! and `process:allow-restart` (would restart the app). Those four are checked by hand instead, once
//! per release, against the installed artifact: `docs/RELEASING.md` step 6 names the click that
//! exercises each one. Worth reading before assuming a grant here is unverified, because two of them
//! are cheaper to confirm than they look (`process:allow-restart` is reached by the database import,
//! not only by an update). What is covered here is the renderer booting, the two `core:*` grants,
//! IPC into this crate's own commands, and the asset protocol end to end.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Runtime};

use crate::commands::logging::sanitize_log_text;
use crate::services::logger;
use crate::services::temp_paths::thumbs_temp_dir;
use crate::utils::naming::unique_temp_suffix;
use crate::AppResult;

/// The flag that turns a launch into a webview self-check. See the module docs.
pub const WEBVIEW_CHECK_FLAG: &str = "--webview-check";

/// How many frontend-reported failure lines are kept, and how long each one may be.
///
/// The report crosses the IPC boundary from the renderer, so it is caller-controlled text and gets
/// the same treatment `log_frontend_error` already gives a crash report: bounded in both dimensions
/// so a runaway (or hostile) frontend cannot flood the log or forge lines through embedded
/// newlines. The caps are generous. A real report carries at most a handful of short strings.
const MAX_REPORTED_FAILURES: usize = 16;
const MAX_FAILURE_CHARS: usize = 512;

/// A 1x1 GIF, written into the granted cache directory so the frontend has something real to load
/// through `convertFileSrc`.
///
/// The container is deliberately the simplest one that is unambiguously a valid image: what the
/// probe proves is that the asset protocol serves a file out of an authorized directory and that
/// the CSP's `img-src` permits the resulting URL, and neither of those depends on the encoding.
/// Forty-three well-known bytes beat hand-rolling a JPEG header that nothing here can verify.
const PROBE_IMAGE_GIF: [u8; 43] = [
    0x47, 0x49, 0x46, 0x38, 0x39, 0x61, // "GIF89a"
    0x01, 0x00, 0x01, 0x00, // 1x1
    0x80, 0x00, 0x00, // a two-entry global color table, background 0, no aspect ratio
    0x00, 0x00, 0x00, // color 0: black
    0xFF, 0xFF, 0xFF, // color 1: white
    0x21, 0xF9, 0x04, 0x01, 0x00, 0x00, 0x00, 0x00, // graphic control extension
    0x2C, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, // image descriptor
    0x02, 0x02, 0x44, 0x01, 0x00, // the single pixel, LZW-compressed
    0x3B, // trailer
];

/// True when this process was launched to check the webview rather than to be used.
///
/// A pure function over an iterator, like [`crate::is_smoke_test_run`] next to it, so the matching
/// can be unit-tested. The caller passes the real arguments. Matched by equality rather than by
/// prefix, so neither flag can be triggered by a near miss.
pub fn is_webview_check_run(args: impl IntoIterator<Item = String>) -> bool {
    args.into_iter().any(|arg| arg == WEBVIEW_CHECK_FLAG)
}

/// What the frontend needs in order to run the check: the absolute path of a real file inside a
/// directory the asset-protocol scope has authorized, for the `convertFileSrc` probe.
#[derive(Debug, Clone, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/types/generated/")]
pub struct WebviewCheckPlan {
    pub asset_path: String,
}

/// What the frontend observed. Every field is one probe. `failures` carries the frontend's own
/// description of anything that threw, which is what turns "the asset did not load" into a line
/// naming the URL that was refused.
#[derive(Debug, Clone, Default, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/types/generated/")]
pub struct WebviewCheckReport {
    /// `getVersion()`'s result, or `None` when the call was refused. Probes
    /// `core:app:allow-version`.
    pub app_version: Option<String>,
    /// Whether `listen` and its unsubscribe both resolved. Probes `core:event:allow-listen` and
    /// `core:event:allow-unlisten`.
    pub event_listen_ok: bool,
    /// Whether an `<img>` pointed at `convertFileSrc(plan.assetPath)` fired `load`. Probes the
    /// asset-protocol scope grant on the cache directory *and* the CSP's `img-src` tokens. The
    /// only part of the CSP that a bundled build alone exercises.
    pub asset_load_ok: bool,
    /// Free-form detail from the renderer, bounded on the way in.
    #[serde(default)]
    pub failures: Vec<String>,
}

/// The reasons this report is a failure, or an empty vector when every probe passed.
///
/// Pure, and separate from the command, for the reason every extraction in this codebase is: the
/// command needs an `AppHandle` and terminates the process, so nothing about the pass/fail decision
/// could be asserted through it. Here both directions are one call from a test.
///
/// The frontend's own `failures` are appended rather than replacing the derived lines: a probe can
/// fail without throwing anything worth reporting (an `<img>` that simply never fires `load`), so
/// the derived line is what guarantees a failure is always named.
pub(crate) fn webview_check_failures(report: &WebviewCheckReport) -> Vec<String> {
    let mut failures = Vec::new();

    let version = report
        .app_version
        .as_deref()
        .map(str::trim)
        .unwrap_or_default();

    if version.is_empty() {
        failures.push(
            "getVersion() returned no version. Check the core:app:allow-version grant".to_string(),
        );
    }

    if !report.event_listen_ok {
        failures.push(
            "listen()/unlisten() did not both resolve. Check the core:event:allow-listen and \
             core:event:allow-unlisten grants"
                .to_string(),
        );
    }

    if !report.asset_load_ok {
        failures.push(
            "an image served through convertFileSrc did not load. Check the asset-protocol scope \
             grant on the cache directory and the img-src asset:/http://asset.localhost tokens in \
             the CSP"
                .to_string(),
        );
    }

    failures.extend(
        report
            .failures
            .iter()
            .take(MAX_REPORTED_FAILURES)
            .map(|failure| sanitize_log_text(failure, MAX_FAILURE_CHARS))
            .filter(|failure| !failure.is_empty()),
    );

    failures
}

/// Writes the probe image into `thumbs-temp/`, which `register_cache_asset_scope` authorized in
/// `setup()`, and returns its absolute path.
///
/// That directory rather than a fresh one precisely *because* it is already granted: pointing the
/// probe at a directory this check authorized for itself would prove nothing about the grants the
/// app actually ships with. The name carries the shared unique suffix so a file left behind by a
/// killed run is never reused, and the directory's own seven-day sweep reclaims it.
fn write_probe_asset<R: Runtime>(app: &AppHandle<R>) -> AppResult<PathBuf> {
    let dir = thumbs_temp_dir(app)?;
    let path = dir.join(format!("webview-check-{}.gif", unique_temp_suffix()));

    std::fs::write(&path, PROBE_IMAGE_GIF).map_err(|error| {
        crate::AppError::fs_error(
            crate::AppErrorCode::FileOpenFailed,
            "failed to write the webview check probe image",
            &path,
            &error,
        )
    })?;

    Ok(path)
}

/// Tells the frontend whether this launch is a webview check and, if it is, hands it the probe
/// asset to load.
///
/// Returns `None` on every normal launch, which is what makes this safe to call unconditionally
/// from `main.tsx`: the frontend asks once at boot and does nothing further. That one round trip is
/// the price of the binary being able to self-check without a second build, and it is also itself a
/// probe, if IPC into this crate's own commands were broken, this call is what would fail.
#[tauri::command]
pub async fn begin_webview_check<R: Runtime>(
    app: AppHandle<R>,
) -> AppResult<Option<WebviewCheckPlan>> {
    if !is_webview_check_run(std::env::args()) {
        return Ok(None);
    }

    let asset = crate::utils::task::run_blocking({
        let app = app.clone();
        move || write_probe_asset(&app)
    })
    .await?;

    Ok(Some(WebviewCheckPlan {
        asset_path: asset.to_string_lossy().to_string(),
    }))
}

/// Receives the frontend's report, logs every probe, and terminates the process with 0 or 1.
///
/// `std::process::exit` rather than `AppHandle::exit`, matching `is_smoke_test_run` and
/// `fail_startup`: the outcome of a check has to be unambiguous, and an unconditional exit is what
/// makes it so. The invoke never gets a response, which does not matter. The process it would have
/// answered is gone, and the frontend has nothing left to do either way.
///
/// Outside a check run this is a no-op rather than an error. It cannot be reached in normal use
/// (the frontend only calls it after [`begin_webview_check`] returned a plan), and refusing here
/// would mean a command whose failure mode is "kill the app" is one compromised-renderer call away
/// from being reachable.
#[tauri::command]
pub async fn report_webview_check<R: Runtime>(
    app: AppHandle<R>,
    report: WebviewCheckReport,
) -> AppResult<()> {
    if !is_webview_check_run(std::env::args()) {
        logger::warn(
            "webview_check",
            "a webview check report arrived outside a check run, ignoring it",
        );

        return Ok(());
    }

    // Best effort, and before the exit below: the probe image is a leftover of this run and the
    // directory it sits in is swept by age anyway, so a failure to remove it is not worth reporting.
    if let Ok(plan_dir) = thumbs_temp_dir(&app) {
        remove_probe_assets(&plan_dir);
    }

    let failures = webview_check_failures(&report);

    logger::info(
        "webview_check",
        format!(
            "probes: version={}, event_listen={}, asset_load={}",
            report.app_version.as_deref().unwrap_or("<none>"),
            report.event_listen_ok,
            report.asset_load_ok
        ),
    );

    if failures.is_empty() {
        logger::info("webview_check", "webview check passed");
        std::process::exit(0);
    }

    for failure in &failures {
        logger::error("webview_check", failure.clone());
    }

    logger::error(
        "webview_check",
        format!("webview check failed with {} problem(s)", failures.len()),
    );

    std::process::exit(1);
}

/// Removes any probe image left in `dir`. Matches on the name this module writes so a real
/// thumbnail preview sitting in the same directory is never touched.
fn remove_probe_assets(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };

    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };

        if name.starts_with("webview-check-") && name.ends_with(".gif") {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| value.to_string()).collect()
    }

    fn passing_report() -> WebviewCheckReport {
        WebviewCheckReport {
            app_version: Some("1.2.0".to_string()),
            event_listen_ok: true,
            asset_load_ok: true,
            failures: Vec::new(),
        }
    }

    #[test]
    fn the_flag_is_recognized_anywhere_in_the_argument_list() {
        // argv[0] is the executable path and a launcher may append its own arguments, so the flag
        // has to match positionally-independently. The same property is_smoke_test_run needs.
        assert!(is_webview_check_run(args(&["kavynex", WEBVIEW_CHECK_FLAG])));
        assert!(is_webview_check_run(args(&[
            "/usr/bin/kavynex",
            "--other",
            WEBVIEW_CHECK_FLAG,
        ])));
    }

    #[test]
    fn a_normal_launch_is_not_a_webview_check() {
        // A false positive here is an app that exits instead of staying open, so a near miss must
        // not match: no prefix, no substring, no bare word, and not the sibling flag either.
        assert!(!is_webview_check_run(args(&["kavynex"])));
        assert!(!is_webview_check_run(args(&["kavynex", "--webview"])));
        assert!(!is_webview_check_run(args(&["kavynex", "webview-check"])));
        assert!(!is_webview_check_run(args(&[
            "kavynex",
            "--webview-checks"
        ])));
        assert!(!is_webview_check_run(args(&["kavynex", "--smoke-test"])));
        assert!(!is_webview_check_run(Vec::new()));
    }

    #[test]
    fn a_report_where_every_probe_passed_has_no_failures() {
        assert!(webview_check_failures(&passing_report()).is_empty());
    }

    #[test]
    fn a_missing_app_version_fails_the_check() {
        // Both spellings of "no version": the field absent, and present but blank. A grant that is
        // missing surfaces as the call throwing, which the frontend reports as `None`. A whitespace
        // string would otherwise pass a bare `is_some()` check.
        for app_version in [None, Some(String::new()), Some("   ".to_string())] {
            let report = WebviewCheckReport {
                app_version,
                ..passing_report()
            };

            let failures = webview_check_failures(&report);

            assert_eq!(failures.len(), 1);
            assert!(
                failures[0].contains("core:app:allow-version"),
                "the failure must name the grant to check: {}",
                failures[0]
            );
        }
    }

    #[test]
    fn a_refused_event_subscription_fails_the_check() {
        let report = WebviewCheckReport {
            event_listen_ok: false,
            ..passing_report()
        };

        let failures = webview_check_failures(&report);

        assert_eq!(failures.len(), 1);
        assert!(failures[0].contains("core:event:allow-listen"));
    }

    #[test]
    fn an_asset_that_does_not_load_fails_the_check() {
        // The probe this whole module exists for: it is the only automated exercise of the CSP,
        // which a bundled build alone applies. The message has to point at both places the failure
        // can live, since neither is visible from the other.
        let report = WebviewCheckReport {
            asset_load_ok: false,
            ..passing_report()
        };

        let failures = webview_check_failures(&report);

        assert_eq!(failures.len(), 1);
        assert!(failures[0].contains("asset-protocol scope"));
        assert!(failures[0].contains("img-src"));
    }

    #[test]
    fn every_failing_probe_is_reported_not_just_the_first() {
        // A run against a badly narrowed capability list fails several probes at once, and fixing
        // them one release at a time is not an option. The report has to name all of them.
        let report = WebviewCheckReport {
            app_version: None,
            event_listen_ok: false,
            asset_load_ok: false,
            failures: Vec::new(),
        };

        assert_eq!(webview_check_failures(&report).len(), 3);
    }

    #[test]
    fn the_frontends_own_failure_lines_are_appended_to_the_derived_ones() {
        let report = WebviewCheckReport {
            asset_load_ok: false,
            failures: vec!["img onerror for asset://localhost/probe.gif".to_string()],
            ..passing_report()
        };

        let failures = webview_check_failures(&report);

        assert_eq!(failures.len(), 2, "the derived line must not be replaced");
        assert!(failures[1].contains("img onerror"));
    }

    #[test]
    fn a_frontend_failure_line_is_bounded_and_stripped_of_control_characters() {
        // The report is caller-controlled text from the renderer, so it gets the same treatment a
        // frontend crash report already gets: an embedded newline must not be able to forge a
        // second log line, and a runaway string must not flood the file.
        let report = WebviewCheckReport {
            failures: vec![format!(
                "boom\nforged line{}",
                "x".repeat(MAX_FAILURE_CHARS)
            )],
            ..passing_report()
        };

        let failures = webview_check_failures(&report);

        assert_eq!(failures.len(), 1);
        assert!(!failures[0].contains('\n'));
        assert!(failures[0].chars().count() <= MAX_FAILURE_CHARS);
    }

    #[test]
    fn the_number_of_reported_failure_lines_is_capped() {
        let report = WebviewCheckReport {
            failures: (0..MAX_REPORTED_FAILURES * 4)
                .map(|index| format!("failure {index}"))
                .collect(),
            ..passing_report()
        };

        // Every probe passed, so the only lines are the frontend's own, capped.
        assert_eq!(webview_check_failures(&report).len(), MAX_REPORTED_FAILURES);
    }

    #[test]
    fn a_blank_frontend_failure_line_is_dropped_rather_than_logged_empty() {
        let report = WebviewCheckReport {
            failures: vec!["   ".to_string(), "real".to_string()],
            ..passing_report()
        };

        let failures = webview_check_failures(&report);

        assert_eq!(failures, vec!["real".to_string()]);
    }

    #[test]
    fn the_probe_image_is_a_valid_gif_header_and_trailer() {
        // The bytes are hand-written, and a malformed image would fail the asset probe for a reason
        // that has nothing to do with the grants under test. The worst possible false negative,
        // since it would look exactly like a CSP problem.
        assert_eq!(&PROBE_IMAGE_GIF[..6], b"GIF89a");
        assert_eq!(
            PROBE_IMAGE_GIF[PROBE_IMAGE_GIF.len() - 1],
            0x3B,
            "a GIF must end with the trailer byte"
        );
        // Width and height, little-endian, immediately after the signature.
        assert_eq!(&PROBE_IMAGE_GIF[6..10], &[0x01, 0x00, 0x01, 0x00]);
    }

    #[test]
    fn probe_assets_are_removed_and_nothing_else_is() {
        let dir = std::env::temp_dir().join(format!(
            "kavynex-webview-check-{}",
            crate::utils::naming::unique_temp_suffix()
        ));
        std::fs::create_dir_all(&dir).unwrap();

        let probe = dir.join("webview-check-abc.gif");
        // A real thumbnail preview shares this directory, and the app may be running while a check
        // build is exercised on the same machine, so the sweep has to match the probe's own name
        // rather than the directory's contents.
        let preview = dir.join("thumb_abc.jpg");
        let unrelated = dir.join("webview-check-notes.txt");

        for path in [&probe, &preview, &unrelated] {
            std::fs::write(path, b"x").unwrap();
        }

        remove_probe_assets(&dir);

        assert!(!probe.exists(), "the probe image should be removed");
        assert!(preview.exists(), "a thumbnail preview must be kept");
        assert!(unrelated.exists(), "a non-gif must be kept");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn sweeping_a_directory_that_is_not_there_is_a_no_op() {
        // The command calls this before exiting, so it must not panic when the cache directory has
        // been removed underneath it.
        remove_probe_assets(Path::new("/no/such/kavynex/dir"));
    }
}
