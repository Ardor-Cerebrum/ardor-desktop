use std::{
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    process::Command,
    sync::{Mutex, OnceLock},
    thread,
};

use tauri::{LogicalSize, Manager, Size, WebviewWindow, WebviewWindowBuilder};

const AUTH_CALLBACK_ADDR: &str = "127.0.0.1:17631";
const AUTH_CALLBACK_PATH: &str = "/auth/callback";
const DESKTOP_CALLBACK_URL: &str = "tauri://localhost/";
const LOOPBACK_CALLBACK_URL: &str = "http://127.0.0.1:17631/auth/callback";
const MAIN_WINDOW_LABEL: &str = "main";

type DesktopResult<T> = Result<T, Box<dyn std::error::Error>>;

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
    let host = parsed.host_str().unwrap_or_default();

    if parsed.scheme() != "https" || !matches!(host, "auth-dev.ardor.cloud" | "auth.ardor.cloud") {
        return Err("refusing to open non-Auth0 authorization URL".to_string());
    }

    open_external_url(&url)
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
        let mut command = Command::new("cmd");
        command.args(["/C", "start", "", url]);
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

fn start_auth_callback_server(app: tauri::AppHandle) {
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
            handle_auth_callback(&app, stream);
        }
    });
}

fn handle_auth_callback(app: &tauri::AppHandle, mut stream: TcpStream) {
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
    let callback_url = if query.is_empty() {
        DESKTOP_CALLBACK_URL.to_string()
    } else {
        format!("{DESKTOP_CALLBACK_URL}?{query}")
    };

    match tauri::Url::parse(&callback_url) {
        Ok(url) => {
            let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) else {
                let _ = write_response(
                    &mut stream,
                    500,
                    "Internal Server Error",
                    "Ardor window is unavailable.",
                );
                return;
            };

            let _ = window.navigate(url);
            let _ = write_response(
                &mut stream,
                200,
                "OK",
                "Authentication complete. You can return to Ardor.",
            );
        }
        Err(error) => {
            let _ = write_response(
                &mut stream,
                500,
                "Internal Server Error",
                &error.to_string(),
            );
        }
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

fn ensure_main_window(app: &tauri::AppHandle) -> DesktopResult<WebviewWindow> {
    let window = match app.get_webview_window(MAIN_WINDOW_LABEL) {
        Some(window) => window,
        None => {
            let config = app
                .config()
                .app
                .windows
                .iter()
                .find(|window| window.label == MAIN_WINDOW_LABEL)
                .or_else(|| app.config().app.windows.first())
                .ok_or_else(|| {
                    std::io::Error::new(
                        std::io::ErrorKind::NotFound,
                        "main window config is missing",
                    )
                })?;

            WebviewWindowBuilder::from_config(app, config)?.build()?
        }
    };

    if let Err(error) = window.set_fullscreen(false) {
        eprintln!("failed to leave fullscreen for main window: {error}");
    }

    if let Err(error) = window.unminimize() {
        eprintln!("failed to unminimize main window: {error}");
    }

    if let Err(error) = window.unmaximize() {
        eprintln!("failed to unmaximize main window: {error}");
    }

    if let Err(error) = window.set_size(Size::Logical(LogicalSize {
        width: 1440.0,
        height: 900.0,
    })) {
        eprintln!("failed to resize main window: {error}");
    }

    if let Err(error) = window.center() {
        eprintln!("failed to center main window: {error}");
    }

    if let Err(error) = window.show() {
        eprintln!("failed to show main window: {error}");
    }

    if let Err(error) = window.set_focus() {
        eprintln!("failed to focus main window: {error}");
    }

    if should_open_devtools() {
        window.open_devtools();
    }

    Ok(window)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            get_auth_callback_status,
            open_auth_url
        ])
        .setup(|app| {
            ensure_main_window(app.handle())?;
            start_auth_callback_server(app.handle().clone());

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Ardor Solutions desktop prototype");

    app.run(|app_handle, event| {
        if let tauri::RunEvent::Reopen { .. } = event {
            if let Err(error) = ensure_main_window(app_handle) {
                eprintln!("failed to reopen main window: {error}");
            }
        }
    });
}

fn should_open_devtools() -> bool {
    cfg!(debug_assertions) || std::env::var("ARDOR_DESKTOP_OPEN_DEVTOOLS").as_deref() == Ok("1")
}
