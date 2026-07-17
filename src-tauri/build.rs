fn main() {
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
