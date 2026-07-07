use std::{
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    process::Command,
    sync::{Mutex, OnceLock},
    thread,
};

use tauri::Manager;

const AUTH_CALLBACK_ADDR: &str = "127.0.0.1:17631";
const AUTH_CALLBACK_PATH: &str = "/auth/callback";
#[cfg(target_os = "windows")]
const DESKTOP_CALLBACK_URL: &str = "http://tauri.localhost/";
#[cfg(not(target_os = "windows"))]
const DESKTOP_CALLBACK_URL: &str = "tauri://localhost/";
const LOOPBACK_CALLBACK_URL: &str = "http://127.0.0.1:17631/auth/callback";

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct AuthCallbackStatus {
    callback_url: String,
    listening: bool,
    error: Option<String>,
}

static AUTH_CALLBACK_STATUS: OnceLock<Mutex<AuthCallbackStatus>> = OnceLock::new();

fn auth_callback_status() -> &'static Mutex<AuthCallbackStatus> {
    AUTH_CALLBACK_STATUS.get_or_init(|| {
        Mutex::new(AuthCallbackStatus {
            callback_url: LOOPBACK_CALLBACK_URL.to_string(),
            listening: false,
            error: Some("Desktop auth callback server is starting.".to_string()),
        })
    })
}

fn get_current_auth_callback_status() -> AuthCallbackStatus {
    auth_callback_status()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone()
}

fn set_auth_callback_status(listening: bool, error: Option<String>) {
    let mut status = auth_callback_status()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());

    status.listening = listening;
    status.error = error;
}

#[tauri::command]
fn get_auth_callback_status() -> AuthCallbackStatus {
    get_current_auth_callback_status()
}

#[tauri::command]
fn open_auth_url(url: String) -> Result<(), String> {
    let status = get_current_auth_callback_status();
    if !status.listening {
        return Err(status
            .error
            .unwrap_or_else(|| "Desktop auth callback server is not listening.".to_string()));
    }

    let parsed = tauri::Url::parse(&url).map_err(|error| error.to_string())?;
    if !is_auth0_url(&parsed) {
        return Err("refusing to open non-Auth0 authorization URL".to_string());
    }

    open_external_url(&url)
}

fn is_auth0_url(url: &tauri::Url) -> bool {
    url.scheme() == "https"
        && matches!(
            url.host_str().unwrap_or_default(),
            "auth-dev.ardor.cloud" | "auth.ardor.cloud"
        )
}

fn open_external_url(url: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = Command::new("open");
        command.arg(url);
        command
    };

    #[cfg(target_os = "windows")]
    let mut command = {
        let mut command = Command::new("rundll32");
        command.args(["url.dll,FileProtocolHandler", url]);
        command
    };

    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    let mut command = {
        let mut command = Command::new("xdg-open");
        command.arg(url);
        command
    };

    command.spawn().map_err(|error| error.to_string())?;
    Ok(())
}

fn start_auth_callback_server(window: tauri::WebviewWindow) {
    thread::spawn(move || {
        let listener = match TcpListener::bind(AUTH_CALLBACK_ADDR) {
            Ok(listener) => {
                set_auth_callback_status(true, None);
                listener
            }
            Err(error) => {
                let message = format!(
                    "Failed to bind desktop auth callback server on {AUTH_CALLBACK_ADDR}: {error}"
                );
                eprintln!("{message}");
                set_auth_callback_status(false, Some(message));
                return;
            }
        };

        for stream in listener.incoming().flatten() {
            handle_auth_callback(&window, stream);
        }
    });
}

fn handle_auth_callback(window: &tauri::WebviewWindow, mut stream: TcpStream) {
    let mut buffer = [0; 8192];
    let Ok(bytes_read) = stream.read(&mut buffer) else {
        return;
    };

    let request = String::from_utf8_lossy(&buffer[..bytes_read]);
    let Some(path) = request.lines().next().and_then(parse_request_path) else {
        let _ = write_response(&mut stream, 400, "Bad Request", "Invalid callback request.");
        return;
    };

    if path != AUTH_CALLBACK_PATH && !path.starts_with(&format!("{AUTH_CALLBACK_PATH}?")) {
        let _ = write_response(&mut stream, 404, "Not Found", "Unknown callback path.");
        return;
    }

    let query = path
        .split_once('?')
        .map(|(_, query)| query)
        .unwrap_or_default();

    let target = desktop_return_url(window, query);
    let _ = window.navigate(target);
    let _ = write_response(
        &mut stream,
        200,
        "OK",
        "Authentication complete. You can return to Ardor.",
    );
}

fn desktop_return_url(window: &tauri::WebviewWindow, query: &str) -> tauri::Url {
    // Return to the WebView's own origin. Tauri serves the app from a
    // platform-specific origin (macOS/Linux: `tauri://localhost`, Windows
    // WebView2: `http://tauri.localhost`), so derive it from the live window
    // instead of hardcoding a scheme. The live URL is only trusted when it is
    // on a known app origin — the Auth0 code/state must never be appended to a
    // foreign origin the WebView may have navigated to. Otherwise fall back to
    // the platform default origin.
    let mut url = window
        .url()
        .ok()
        .filter(is_allowed_return_origin)
        .unwrap_or_else(|| {
            tauri::Url::parse(DESKTOP_CALLBACK_URL).expect("valid fallback return URL")
        });

    url.set_path("/");
    url.set_query((!query.is_empty()).then_some(query));
    url
}

fn is_allowed_return_origin(url: &tauri::Url) -> bool {
    match (url.scheme(), url.host_str(), url.port()) {
        ("tauri", Some("localhost"), _) => true,
        ("http", Some("tauri.localhost"), _) => true,
        // Vite dev server (tauri.conf.json `devUrl`), dev builds only.
        #[cfg(debug_assertions)]
        ("http", Some("localhost"), Some(3000)) => true,
        _ => false,
    }
}

fn parse_request_path(request_line: &str) -> Option<&str> {
    let mut parts = request_line.split_whitespace();
    match (parts.next(), parts.next()) {
        (Some("GET"), Some(path)) => Some(path),
        _ => None,
    }
}

fn write_response(
    stream: &mut TcpStream,
    status: u16,
    reason: &str,
    message: &str,
) -> std::io::Result<()> {
    let body = format!(
        r#"<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>Ardor</title></head>
  <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; padding: 32px;">
    <h1>{message}</h1>
    <p>This tab can be closed.</p>
    <script>window.close();</script>
  </body>
</html>"#
    );

    write!(
        stream,
        "HTTP/1.1 {status} {reason}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            get_auth_callback_status,
            open_auth_url
        ])
        // Keep the WebView on trusted origins: the app itself, plus the Auth0
        // domain the SPA's logout flow navigates through before bouncing back.
        // Anything else opens no window for the auth callback to leak into.
        .plugin(
            tauri::plugin::Builder::<tauri::Wry>::new("navigation-guard")
                .on_navigation(|_webview, url| {
                    let allowed = is_allowed_return_origin(url) || is_auth0_url(url);
                    if !allowed {
                        eprintln!("Blocked webview navigation to untrusted URL: {url}");
                    }
                    allowed
                })
                .build(),
        )
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                start_auth_callback_server(window.clone());

                #[cfg(debug_assertions)]
                window.open_devtools();
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Ardor Solutions desktop prototype");
}
