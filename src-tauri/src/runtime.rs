pub(crate) type DesktopRuntime = tauri::Cef;

pub(crate) type DesktopAppHandle = tauri::AppHandle<DesktopRuntime>;
pub(crate) type DesktopWebview = tauri::Webview<DesktopRuntime>;
pub(crate) type DesktopWindow = tauri::Window<DesktopRuntime>;
