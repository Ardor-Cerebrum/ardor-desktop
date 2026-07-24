fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        let generated = std::path::Path::new("generated/ardor-solutions-desktop.dll");
        if !generated.exists() {
            std::fs::create_dir_all("generated")
                .expect("failed to create the Windows bootstrap staging directory");
            std::fs::write(
                generated,
                b"bootstrap client is populated before bundling\n",
            )
            .expect("failed to stage the Windows bootstrap resource placeholder");
        }
    }
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "check_desktop_update",
            "close_sidebar_browser",
            "complete_auth_callback",
            "control_sidebar_browser",
            "get_auth_callback_status",
            "get_pending_auth_callback",
            "input_sidebar_browser",
            "install_desktop_update",
            "layout_sidebar_browser",
            "open_auth_url",
            "open_sidebar_browser",
        ]),
    ))
    .expect("failed to prepare Tauri build metadata")
}
