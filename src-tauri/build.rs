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

    // Gated to the MSVC toolchain deliberately, not by oversight: the linker args below
    // (/MANIFEST:EMBED, /MANIFESTINPUT, /WX) are MSVC link.exe flags. The GNU toolchain
    // (x86_64-pc-windows-gnu) uses a different linker that does not understand them, and would
    // need its own way to embed the manifest (e.g. a windres/.rc resource). The project only
    // ships the MSVC target, so that path is not implemented. If a windows-gnu target is ever
    // added, it must embed the manifest some other way or it will reproduce the
    // STATUS_ENTRYPOINT_NOT_FOUND crash described above (a manifest-less binary falls back to
    // comctl32 v5.82, which lacks TaskDialogIndirect).
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
    // /WX is load-bearing, not incidental strictness: a failure to embed the manifest surfaces as
    // a linker *warning*, and link.exe would otherwise still produce a manifest-less binary that
    // then aborts at runtime with STATUS_ENTRYPOINT_NOT_FOUND (see the block comment in main).
    // /WX turns that silent warning into a hard build failure, which is far preferable to shipping
    // the crash. The cost is that /WX is all-or-nothing - it cannot be scoped to just the manifest
    // warnings, so any unrelated linker warning (e.g. LNK4098/LNK4099) also fails the MSVC build.
    // That is an accepted, deliberate tradeoff: a clean link is a reasonable bar, and a silent
    // manifest-embed failure is the worse outcome. Do not drop /WX to quiet an unrelated warning -
    // fix the warning, or the manifest guarantee goes with it.
    println!("cargo:rustc-link-arg=/WX");
}
