fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest()),
    )
    .expect("failed to run tauri-build");

    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let target_env = std::env::var("CARGO_CFG_TARGET_ENV");
    let is_tauri_workspace = std::env::var("__TAURI_WORKSPACE__")
        .map(|value| value == "true")
        .unwrap_or(false);

    if is_tauri_workspace && target_os == "windows" && target_env.as_deref() == Ok("msvc") {
        embed_manifest_for_tests();
    }
}

fn embed_manifest_for_tests() {
    let manifest = std::env::current_dir()
        .expect("failed to resolve current directory")
        .join("windows-app-manifest.xml");

    println!("cargo:rerun-if-changed={}", manifest.display());
    println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
    println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
    println!("cargo:rustc-link-arg=/WX");
}
