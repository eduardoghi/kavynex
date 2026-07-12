fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest()),
    )
    .expect("failed to run tauri-build");

    // Tauri's default app manifest is disabled above (new_without_app_manifest), so the app
    // must embed the checked-in windows-app-manifest.xml itself. Do it for every Windows MSVC
    // artifact - the app binary and the test binaries alike - so both declare the
    // Common-Controls v6 dependency. Without a manifest the loader falls back to comctl32
    // v5.82, which does not export TaskDialogIndirect, and the process aborts with
    // STATUS_ENTRYPOINT_NOT_FOUND the moment a native task dialog is shown. Embedding it here
    // unconditionally is what makes normal `cargo run`/`tauri build`/`cargo test` produce a
    // manifested binary; an earlier version gated this on an env var and so shipped test
    // binaries with no manifest at all.
    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let target_env = std::env::var("CARGO_CFG_TARGET_ENV");

    if target_os == "windows" && target_env.as_deref() == Ok("msvc") {
        embed_windows_app_manifest();
    }
}

fn embed_windows_app_manifest() {
    let manifest = std::env::current_dir()
        .expect("failed to resolve current directory")
        .join("windows-app-manifest.xml");

    println!("cargo:rerun-if-changed={}", manifest.display());
    println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
    println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
    println!("cargo:rustc-link-arg=/WX");
}
