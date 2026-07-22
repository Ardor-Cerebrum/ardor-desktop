#![cfg_attr(
    all(not(debug_assertions), not(windows)),
    windows_subsystem = "windows"
)]

#[cfg(not(windows))]
#[tauri::cef_entry_point]
fn main() {
    ardor_solutions_desktop_lib::run();
}

#[cfg(windows)]
fn main() {
    panic!(
        "the Windows CEF application must be launched through its packaged bootstrap executable"
    );
}
