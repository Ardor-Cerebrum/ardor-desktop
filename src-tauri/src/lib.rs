use std::{
    collections::HashMap,
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    process::Command,
    sync::{Mutex, OnceLock},
    thread,
    time::Duration,
};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use minisign_verify::{PublicKey, Signature};
use tauri::{ipc::Channel, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

const AUTH_CALLBACK_ADDR: &str = "127.0.0.1:17631";
const AUTH_CALLBACK_PATH: &str = "/auth/callback";
#[cfg(target_os = "windows")]
const DESKTOP_CALLBACK_URL: &str = "http://tauri.localhost/";
#[cfg(not(target_os = "windows"))]
const DESKTOP_CALLBACK_URL: &str = "tauri://localhost/";
const LOOPBACK_CALLBACK_URL: &str = "http://127.0.0.1:17631/auth/callback";
const PROD_BUNDLE_ID: &str = "cloud.ardor.desktop";
const STAGE1_BUNDLE_ID: &str = "cloud.ardor.desktop.stage1";
const UPDATE_METADATA_SCHEMA: u32 = 1;
const UPDATE_CHECK_TIMEOUT: Duration = Duration::from_secs(30);
const UPDATE_DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(15 * 60);

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct AuthCallbackStatus {
    callback_url: String,
    listening: bool,
    error: Option<String>,
}

#[derive(Clone, serde::Serialize)]
#[serde(tag = "event", content = "data")]
enum DesktopUpdateEvent {
    #[serde(rename_all = "camelCase")]
    Started {
        content_length: Option<u64>,
    },
    #[serde(rename_all = "camelCase")]
    Progress {
        chunk_length: usize,
    },
    Verifying,
    Installing,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "kebab-case")]
enum DesktopUpdateOutcome {
    Installed,
    UpToDate,
}

#[derive(serde::Serialize)]
#[serde(tag = "status", rename_all = "kebab-case")]
enum DesktopUpdateCheckOutcome {
    UpToDate,
    Available { version: String },
}

#[derive(serde::Deserialize)]
struct SignedUpdateEnvelope {
    payload: String,
    signature: String,
}

#[derive(Clone, Debug, PartialEq, serde::Deserialize, serde::Serialize)]
struct SignedUpdatePlatform {
    signature: String,
    url: String,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct SignedUpdatePayload {
    schema: u32,
    channel: String,
    bundle_id: String,
    version: String,
    pub_date: String,
    platforms: HashMap<String, SignedUpdatePlatform>,
}

struct UpdateAnnouncement<'a> {
    current_version: &'a str,
    version: &'a str,
    platform_key: &'a str,
    download_url: &'a str,
    artifact_signature: &'a str,
}

#[derive(Debug)]
struct ValidatedUpdateMetadata {
    version: String,
}

struct ValidatedDesktopUpdate {
    update: Update,
    metadata: ValidatedUpdateMetadata,
}

struct AuthCallbackAttempt {
    expected_state: Option<String>,
    claimed_state: Option<String>,
    recovery_allowed: bool,
}

#[derive(Debug, PartialEq)]
enum AuthCallbackClaim {
    Claimed,
    Duplicate,
    Unexpected,
}

#[derive(Debug, PartialEq)]
enum AuthCallbackHandoff {
    Queued,
    Duplicate,
    Unexpected,
}

impl Default for AuthCallbackAttempt {
    fn default() -> Self {
        Self {
            expected_state: None,
            claimed_state: None,
            recovery_allowed: true,
        }
    }
}

impl AuthCallbackAttempt {
    fn begin(&mut self, expected_state: String) {
        self.expected_state = Some(expected_state);
        self.claimed_state = None;
        self.recovery_allowed = false;
    }

    fn clear(&mut self) {
        self.expected_state = None;
        self.claimed_state = None;
        self.recovery_allowed = false;
    }

    fn claim(&mut self, callback_state: &str) -> AuthCallbackClaim {
        if callback_state.is_empty() {
            return AuthCallbackClaim::Unexpected;
        }
        if let Some(expected_state) = self.expected_state.as_deref() {
            if expected_state != callback_state {
                return AuthCallbackClaim::Unexpected;
            }
        } else if self.recovery_allowed {
            self.expected_state = Some(callback_state.to_string());
            self.recovery_allowed = false;
        } else {
            return AuthCallbackClaim::Unexpected;
        }

        match self.claimed_state.as_deref() {
            Some(claimed_state) if claimed_state == callback_state => AuthCallbackClaim::Duplicate,
            Some(_) => AuthCallbackClaim::Unexpected,
            None => {
                self.claimed_state = Some(callback_state.to_string());
                AuthCallbackClaim::Claimed
            }
        }
    }

    fn release(&mut self, callback_state: &str) {
        if self.claimed_state.as_deref() == Some(callback_state) {
            self.claimed_state = None;
        }
    }
}

static AUTH_CALLBACK_STATUS: OnceLock<Mutex<AuthCallbackStatus>> = OnceLock::new();
static AUTH_CALLBACK_ATTEMPT: OnceLock<Mutex<AuthCallbackAttempt>> = OnceLock::new();
static DESKTOP_UPDATE_OPERATION: OnceLock<tauri::async_runtime::Mutex<()>> = OnceLock::new();

fn auth_callback_status() -> &'static Mutex<AuthCallbackStatus> {
    AUTH_CALLBACK_STATUS.get_or_init(|| {
        Mutex::new(AuthCallbackStatus {
            callback_url: LOOPBACK_CALLBACK_URL.to_string(),
            listening: false,
            error: Some("Desktop auth callback server is starting.".to_string()),
        })
    })
}

fn desktop_update_operation() -> &'static tauri::async_runtime::Mutex<()> {
    DESKTOP_UPDATE_OPERATION.get_or_init(|| tauri::async_runtime::Mutex::new(()))
}

fn auth_callback_attempt() -> &'static Mutex<AuthCallbackAttempt> {
    AUTH_CALLBACK_ATTEMPT.get_or_init(|| Mutex::new(AuthCallbackAttempt::default()))
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

    open_auth_url_with(&url, auth_callback_attempt(), open_external_url)
}

fn open_auth_url_with<F>(
    url: &str,
    attempt: &Mutex<AuthCallbackAttempt>,
    open_external: F,
) -> Result<(), String>
where
    F: FnOnce(&str) -> Result<(), String>,
{
    let parsed = tauri::Url::parse(url).map_err(|error| error.to_string())?;
    if !is_auth0_url(&parsed) {
        return Err("refusing to open non-Auth0 authorization URL".to_string());
    }
    let Some(expected_state) = auth_state_from_url(&parsed) else {
        clear_auth_callback_attempt(attempt);
        return Err("Auth0 authorization URL is missing a non-empty state".to_string());
    };

    begin_auth_callback_attempt(attempt, expected_state);
    eprintln!("Desktop auth callback phase=attempt_started");
    if let Err(error) = open_external(url) {
        clear_auth_callback_attempt(attempt);
        eprintln!("Desktop auth callback phase=launch_failed");
        return Err(error);
    }

    Ok(())
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

    eprintln!("Desktop auth callback phase=received");
    let callback_state = auth_state_from_query(query);
    match hand_off_auth_callback(auth_callback_attempt(), callback_state.as_deref(), || {
        let target = desktop_return_url(window, query);
        navigate_auth_callback(window, target)
    }) {
        Ok(AuthCallbackHandoff::Queued) => {
            eprintln!("Desktop auth callback phase=queued");
            let _ = write_response(
                &mut stream,
                200,
                "OK",
                "Sign-in is continuing in Ardor Desktop.",
            );
        }
        Ok(AuthCallbackHandoff::Duplicate) => {
            eprintln!("Desktop auth callback phase=duplicate");
            let _ = write_response(
                &mut stream,
                200,
                "OK",
                "Ardor Desktop already received this sign-in.",
            );
        }
        Ok(AuthCallbackHandoff::Unexpected) => {
            eprintln!("Desktop auth callback phase=rejected");
            let _ = write_response(
                &mut stream,
                400,
                "Bad Request",
                "This sign-in link is no longer valid. Start again from Ardor Desktop.",
            );
        }
        Err(_) => {
            eprintln!("Desktop auth callback phase=dispatch_failed");
            let _ = write_response(
                &mut stream,
                500,
                "Internal Server Error",
                "Ardor couldn't finish sign-in. Try again from the desktop app.",
            );
        }
    }
}

fn auth_state_from_url(url: &tauri::Url) -> Option<String> {
    url.query_pairs()
        .find_map(|(key, value)| (key == "state" && !value.is_empty()).then(|| value.into_owned()))
}

fn auth_state_from_query(query: &str) -> Option<String> {
    let mut url = tauri::Url::parse("http://localhost/").expect("valid query parsing URL");
    url.set_query((!query.is_empty()).then_some(query));
    auth_state_from_url(&url)
}

fn begin_auth_callback_attempt(attempt: &Mutex<AuthCallbackAttempt>, expected_state: String) {
    attempt
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .begin(expected_state);
}

fn clear_auth_callback_attempt(attempt: &Mutex<AuthCallbackAttempt>) {
    attempt
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clear();
}

fn hand_off_auth_callback<F>(
    attempt: &Mutex<AuthCallbackAttempt>,
    callback_state: Option<&str>,
    dispatch: F,
) -> Result<AuthCallbackHandoff, String>
where
    F: FnOnce() -> Result<(), String>,
{
    let Some(callback_state) = callback_state.filter(|state| !state.is_empty()) else {
        return Ok(AuthCallbackHandoff::Unexpected);
    };
    let claim = attempt
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .claim(callback_state);

    match claim {
        AuthCallbackClaim::Duplicate => Ok(AuthCallbackHandoff::Duplicate),
        AuthCallbackClaim::Unexpected => Ok(AuthCallbackHandoff::Unexpected),
        AuthCallbackClaim::Claimed => match dispatch() {
            Ok(()) => Ok(AuthCallbackHandoff::Queued),
            Err(error) => {
                attempt
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .release(callback_state);
                Err(error)
            }
        },
    }
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

fn navigate_auth_callback(window: &tauri::WebviewWindow, target: tauri::Url) -> Result<(), String> {
    dispatch_auth_callback_once(&target, |script| {
        window
            .eval(script)
            .map_err(|error| format!("location replace script failed: {error}"))
    })
}

fn dispatch_auth_callback_once<F>(target: &tauri::Url, dispatch: F) -> Result<(), String>
where
    F: FnOnce(&str) -> Result<(), String>,
{
    // Auth0 callback codes and their PKCE transactions are one-shot. Keep the
    // dispatcher one-shot too so one loopback request can queue only one WebView
    // navigation.
    let script = format!(
        "window.location.replace({});",
        js_string_literal(target.as_str())
    );

    dispatch(&script)
}

fn js_string_literal(value: &str) -> String {
    let mut result = String::with_capacity(value.len() + 2);
    result.push('"');

    for character in value.chars() {
        match character {
            '"' => result.push_str("\\\""),
            '\\' => result.push_str("\\\\"),
            '\n' => result.push_str("\\n"),
            '\r' => result.push_str("\\r"),
            '\t' => result.push_str("\\t"),
            '\u{2028}' => result.push_str("\\u2028"),
            '\u{2029}' => result.push_str("\\u2029"),
            _ => result.push(character),
        }
    }

    result.push('"');
    result
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

fn escape_html(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());

    for character in value.chars() {
        match character {
            '&' => escaped.push_str("&amp;"),
            '<' => escaped.push_str("&lt;"),
            '>' => escaped.push_str("&gt;"),
            '"' => escaped.push_str("&quot;"),
            '\'' => escaped.push_str("&#39;"),
            _ => escaped.push(character),
        }
    }

    escaped
}

fn render_auth_callback_page(status: u16, message: &str) -> String {
    let is_success = (200..300).contains(&status);
    let (state, document_title, title) = if is_success {
        (
            "success",
            "You can close this tab — Ardor",
            "You can close this tab",
        )
    } else {
        ("error", "Sign-in issue — Ardor", "Return to Ardor")
    };

    const TEMPLATE: &str = r##"<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="color-scheme" content="light dark">
    <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Crect width='24' height='24' rx='6' fill='%2309090b'/%3E%3Cpath d='M12 4v16M4 12h16M6.3 6.3l11.4 11.4M17.7 6.3 6.3 17.7' stroke='%23f97316' stroke-width='2.2' stroke-linecap='round'/%3E%3C/svg%3E">
    <title>%%DOCUMENT_TITLE%%</title>
    <style>
      :root {
        color-scheme: light dark;
        --background: #fafafa;
        --card: #ffffff;
        --foreground: #18181b;
        --muted-foreground: #71717a;
        --border: #e4e4e7;
        --shadow: rgba(24, 24, 27, 0.08);
        --success: #22c55e;
        --success-background: #f0fdf4;
        --success-border: #bbf7d0;
        --error: #dc2626;
        --error-background: #fef2f2;
        --error-border: #fecaca;
      }

      * { box-sizing: border-box; }

      html { min-height: 100%; }

      body {
        min-height: 100vh;
        min-height: 100svh;
        margin: 0;
        padding: 32px 20px;
        display: grid;
        place-items: center;
        background: var(--background);
        color: var(--foreground);
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        text-rendering: optimizeLegibility;
      }

      .shell {
        width: min(380px, 100%);
      }

      .brand {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 8px;
        margin-bottom: 16px;
        color: var(--foreground);
      }

      .brand-mark { width: 22px; height: 22px; }

      .brand-name {
        font-size: 12px;
        font-weight: 700;
        letter-spacing: 0.16em;
      }

      .brand-product {
        margin-left: -3px;
        color: var(--muted-foreground);
        font-size: 9px;
        font-weight: 600;
        letter-spacing: 0.18em;
      }

      .card {
        padding: 36px 32px;
        border: 1px solid var(--border);
        border-radius: 16px;
        background: var(--card);
        box-shadow: 0 16px 48px var(--shadow);
        text-align: center;
      }

      .status-icon {
        width: 48px;
        height: 48px;
        display: grid;
        place-items: center;
        margin: 0 auto 24px;
        border: 1px solid var(--state-border);
        border-radius: 50%;
        background: var(--state-background);
        color: var(--state);
      }

      body[data-state="success"] {
        --state: var(--success);
        --state-background: var(--success-background);
        --state-border: var(--success-border);
      }

      body[data-state="error"] {
        --state: var(--error);
        --state-background: var(--error-background);
        --state-border: var(--error-border);
      }

      body[data-state="success"] .error-glyph,
      body[data-state="error"] .success-glyph { display: none; }

      .status-icon svg { width: 22px; height: 22px; }

      h1 {
        margin: 0;
        font-size: clamp(26px, 7vw, 32px);
        font-weight: 650;
        letter-spacing: -0.035em;
        line-height: 1.15;
      }

      .message {
        margin: 12px auto 0;
        max-width: 290px;
        color: var(--muted-foreground);
        font-size: 15px;
        line-height: 1.55;
      }

      @media (prefers-color-scheme: dark) {
        :root {
          --background: #09090b;
          --card: #18181b;
          --foreground: #fafafa;
          --muted-foreground: #a1a1aa;
          --border: #3f3f46;
          --shadow: rgba(0, 0, 0, 0.36);
          --success: #4ade80;
          --success-background: #052e16;
          --success-border: #166534;
          --error: #fb7185;
          --error-background: #2a1115;
          --error-border: #881337;
        }
      }

      @media (max-width: 480px) {
        body { padding: 20px 16px; }
        .card { padding: 32px 24px; }
      }
    </style>
  </head>
  <body data-state="%%STATE%%">
    <main class="shell">
      <div class="brand" aria-label="Ardor Desktop">
        <svg class="brand-mark" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path fill-rule="evenodd" clip-rule="evenodd" d="M16.4479 9.8086L20.6503 5.6038C20.7853 5.46875 20.7853 5.24777 20.6503 5.11273L18.8834 3.34487C18.7485 3.20982 18.5276 3.20982 18.3926 3.34487L14.1902 7.54967C13.9693 7.77065 13.5951 7.61105 13.5951 7.30413V1.34989C13.5951 1.1596 13.4417 1 13.2454 1H10.7485C10.5583 1 10.3988 1.15346 10.3988 1.34989V7.30413C10.3988 7.61719 10.0245 7.77065 9.80369 7.54967L5.59509 3.33873C5.46013 3.20368 5.23927 3.20368 5.1043 3.33873L3.33742 5.10659C3.20246 5.24163 3.20246 5.46261 3.33742 5.59766L7.53988 9.80246C7.76074 10.0234 7.60123 10.3979 7.29448 10.3979H1.34969C1.15951 10.3979 1 10.5513 1 10.7478V13.2461C1 13.4364 1.15337 13.596 1.34969 13.596H4.66871C5.57055 13.596 6.39878 13.1295 6.88344 12.3683C7.29448 11.7238 7.82822 11.159 8.44786 10.7109C8.60123 10.6005 8.75461 10.4961 8.92025 10.404C9.38037 10.1339 9.87117 9.91909 10.3988 9.77791C10.8528 9.65514 11.3313 9.58148 11.8221 9.56306H12.1718C12.6626 9.57534 13.1411 9.649 13.5951 9.77177C14.1227 9.91295 14.6258 10.1278 15.0859 10.3979C15.2454 10.49 15.3988 10.5943 15.5522 10.7048C16.1779 11.1529 16.7117 11.7176 17.1288 12.3683C17.6135 13.1295 18.4417 13.596 19.3436 13.596H22.6503C22.8405 13.596 23 13.4425 23 13.2461V10.7478C23 10.5575 22.8466 10.3979 22.6503 10.3979H16.7055C16.3804 10.404 16.227 10.0296 16.4479 9.8086ZM8.14697 13.6021H8.14108L8.71777 13.0251C8.90182 12.798 9.11041 12.5893 9.3374 12.4051C9.48464 12.2824 9.64415 12.1719 9.80366 12.0736C9.80479 12.073 9.80593 12.0723 9.80706 12.0716L9.80321 12.0677C9.99339 11.9511 10.1897 11.8529 10.3983 11.7669C10.8891 11.5644 11.429 11.4539 11.9934 11.4539C12.5578 11.4539 13.0977 11.5644 13.5885 11.7669C13.7971 11.8529 13.9934 11.9511 14.1836 12.0677C14.3492 12.1659 14.5026 12.2764 14.656 12.3992L14.6867 12.4299C14.8919 12.5996 15.0817 12.7895 15.2513 12.9948L15.2756 13.0192L15.8523 13.5962L18.0732 15.8183L20.656 18.4025C20.7848 18.5376 20.7848 18.7586 20.6498 18.8936L18.883 20.6615C18.748 20.7965 18.5271 20.7965 18.3922 20.6615L16.9259 19.1944L15.6008 17.8685L13.5947 15.8613V23.0002H10.3984V15.8632L7.07316 19.1944L5.60077 20.6676C5.4658 20.8026 5.24494 20.8026 5.10997 20.6676L3.3431 18.8997C3.20813 18.7647 3.20813 18.5437 3.3431 18.4087L5.93206 15.8183L8.14065 13.6084L8.14697 13.6021Z" fill="url(#brand-gradient)"/>
          <defs><linearGradient id="brand-gradient" x1="12" y1="2" x2="12" y2="22" gradientUnits="userSpaceOnUse"><stop stop-color="#FF9700"/><stop offset="1" stop-color="#9000AF"/></linearGradient></defs>
        </svg>
        <span class="brand-name">ARDOR</span>
        <span class="brand-product">DESKTOP</span>
      </div>

      <section class="card" aria-labelledby="page-title">
        <div class="status-icon" aria-hidden="true">
          <svg class="success-glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 4.2 4.2L19 6.5"/></svg>
          <svg class="error-glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 7v6"/><path d="M12 17.2h.01"/><circle cx="12" cy="12" r="9"/></svg>
        </div>

        <h1 id="page-title">%%TITLE%%</h1>
        <p class="message">%%MESSAGE%%</p>
      </section>
    </main>
  </body>
</html>"##;

    TEMPLATE
        .replace("%%DOCUMENT_TITLE%%", document_title)
        .replace("%%STATE%%", state)
        .replace("%%TITLE%%", title)
        .replace("%%MESSAGE%%", &escape_html(message))
}

fn write_response(
    stream: &mut TcpStream,
    status: u16,
    reason: &str,
    message: &str,
) -> std::io::Result<()> {
    let body = render_auth_callback_page(status, message);

    write!(
        stream,
        "HTTP/1.1 {status} {reason}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store, max-age=0\r\nPragma: no-cache\r\nContent-Security-Policy: default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'none'\r\nReferrer-Policy: no-referrer\r\nX-Content-Type-Options: nosniff\r\nX-Frame-Options: DENY\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
}

fn update_channel(bundle_id: &str) -> Result<&'static str, String> {
    match bundle_id {
        PROD_BUNDLE_ID => Ok("prod"),
        STAGE1_BUNDLE_ID => Ok("stage1"),
        _ => Err(format!(
            "desktop updater is not configured for bundle identifier {bundle_id}"
        )),
    }
}

fn updater_public_key(app: &tauri::AppHandle) -> Result<String, String> {
    app.config()
        .plugins
        .0
        .get("updater")
        .and_then(|config| config.get("pubkey"))
        .and_then(serde_json::Value::as_str)
        .filter(|key| !key.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| "updater public key is missing from the effective Tauri config".to_string())
}

fn verify_minisign_payload(payload: &str, signature: &str, public_key: &str) -> Result<(), String> {
    let public_key = BASE64
        .decode(public_key)
        .map_err(|error| format!("invalid updater public-key encoding: {error}"))?;
    let public_key = String::from_utf8(public_key)
        .map_err(|error| format!("updater public key is not UTF-8: {error}"))?;
    let public_key = PublicKey::decode(&public_key)
        .map_err(|error| format!("invalid updater public key: {error}"))?;

    let signature = BASE64
        .decode(signature)
        .map_err(|error| format!("invalid metadata-signature encoding: {error}"))?;
    let signature = String::from_utf8(signature)
        .map_err(|error| format!("metadata signature is not UTF-8: {error}"))?;
    let signature = Signature::decode(&signature)
        .map_err(|error| format!("invalid metadata signature: {error}"))?;

    public_key
        .verify(payload.as_bytes(), &signature, true)
        .map_err(|error| format!("update metadata signature verification failed: {error}"))
}

fn validate_update_metadata(
    raw_manifest: &serde_json::Value,
    announcement: &UpdateAnnouncement<'_>,
    expected_channel: &str,
    expected_bundle_id: &str,
    public_key: &str,
) -> Result<ValidatedUpdateMetadata, String> {
    let envelope: SignedUpdateEnvelope =
        serde_json::from_value(raw_manifest.get("ardor").cloned().ok_or_else(|| {
            "update manifest is missing the signed Ardor metadata envelope".to_string()
        })?)
        .map_err(|error| format!("invalid signed Ardor metadata envelope: {error}"))?;

    verify_minisign_payload(&envelope.payload, &envelope.signature, public_key)?;

    let payload: SignedUpdatePayload = serde_json::from_str(&envelope.payload)
        .map_err(|error| format!("invalid signed update metadata payload: {error}"))?;

    if payload.schema != UPDATE_METADATA_SCHEMA {
        return Err(format!(
            "unsupported signed update metadata schema {}",
            payload.schema
        ));
    }
    if payload.channel != expected_channel {
        return Err(format!(
            "signed update channel {} does not match {expected_channel}",
            payload.channel
        ));
    }
    if payload.bundle_id != expected_bundle_id {
        return Err(format!(
            "signed update bundle identifier {} does not match {expected_bundle_id}",
            payload.bundle_id
        ));
    }

    let signed_version = semver::Version::parse(&payload.version)
        .map_err(|error| format!("invalid signed update version: {error}"))?;
    let current_version = semver::Version::parse(announcement.current_version)
        .map_err(|error| format!("invalid current application version: {error}"))?;
    if signed_version <= current_version {
        return Err(format!(
            "signed update version {signed_version} is not newer than {current_version}"
        ));
    }
    if payload.version != announcement.version {
        return Err("manifest version does not match signed update metadata".to_string());
    }

    let top_level_version = raw_manifest
        .get("version")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| "update manifest is missing version".to_string())?;
    if top_level_version != payload.version {
        return Err("top-level manifest version does not match signed metadata".to_string());
    }

    let top_level_pub_date = raw_manifest
        .get("pub_date")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| "update manifest is missing pub_date".to_string())?;
    if top_level_pub_date != payload.pub_date {
        return Err("top-level manifest pub_date does not match signed metadata".to_string());
    }

    let top_level_platforms: HashMap<String, SignedUpdatePlatform> = serde_json::from_value(
        raw_manifest
            .get("platforms")
            .cloned()
            .ok_or_else(|| "update manifest is missing platforms".to_string())?,
    )
    .map_err(|error| format!("invalid top-level update platforms: {error}"))?;
    if top_level_platforms != payload.platforms {
        return Err("top-level update platforms do not match signed metadata".to_string());
    }

    let platform = payload
        .platforms
        .get(announcement.platform_key)
        .ok_or_else(|| {
            format!(
                "signed update metadata has no {} platform",
                announcement.platform_key
            )
        })?;
    if platform.url != announcement.download_url {
        return Err("selected update URL does not match signed metadata".to_string());
    }
    if platform.signature != announcement.artifact_signature {
        return Err("selected artifact signature does not match signed metadata".to_string());
    }

    Ok(ValidatedUpdateMetadata {
        version: payload.version,
    })
}

async fn find_validated_desktop_update(
    app: &tauri::AppHandle,
) -> Result<Option<ValidatedDesktopUpdate>, String> {
    let bundle_id = app.config().identifier.clone();
    let channel = update_channel(&bundle_id)?;
    let public_key = updater_public_key(app)?;
    let updater = app
        .updater_builder()
        .timeout(UPDATE_CHECK_TIMEOUT)
        .build()
        .map_err(|error| format!("failed to initialize desktop updater: {error}"))?;
    let Some(update) = updater
        .check()
        .await
        .map_err(|error| format!("failed to check for desktop updates: {error}"))?
    else {
        return Ok(None);
    };

    let platform_key = format!("{}-{}", update.target, std::env::consts::ARCH);
    let metadata = validate_update_metadata(
        &update.raw_json,
        &UpdateAnnouncement {
            current_version: &update.current_version,
            version: &update.version,
            platform_key: &platform_key,
            download_url: update.download_url.as_str(),
            artifact_signature: &update.signature,
        },
        channel,
        &bundle_id,
        &public_key,
    )?;

    Ok(Some(ValidatedDesktopUpdate { update, metadata }))
}

#[tauri::command]
async fn check_desktop_update(app: tauri::AppHandle) -> Result<DesktopUpdateCheckOutcome, String> {
    let _operation_guard = desktop_update_operation()
        .try_lock()
        .map_err(|_| "another desktop update operation is already in progress".to_string())?;

    match find_validated_desktop_update(&app).await? {
        Some(update) => Ok(DesktopUpdateCheckOutcome::Available {
            version: update.metadata.version,
        }),
        None => Ok(DesktopUpdateCheckOutcome::UpToDate),
    }
}

#[tauri::command]
async fn install_desktop_update(
    app: tauri::AppHandle,
    on_event: Channel<DesktopUpdateEvent>,
) -> Result<DesktopUpdateOutcome, String> {
    let _operation_guard = desktop_update_operation().lock().await;
    let Some(ValidatedDesktopUpdate { mut update, .. }) =
        find_validated_desktop_update(&app).await?
    else {
        return Ok(DesktopUpdateOutcome::UpToDate);
    };
    // tauri-plugin-updater 2.10.1 does not carry the builder timeout into Update::download.
    update.timeout = Some(UPDATE_DOWNLOAD_TIMEOUT);

    let mut first_chunk = true;
    let bytes = update
        .download(
            |chunk_length, content_length| {
                if first_chunk {
                    first_chunk = false;
                    let _ = on_event.send(DesktopUpdateEvent::Started { content_length });
                }
                let _ = on_event.send(DesktopUpdateEvent::Progress { chunk_length });
            },
            || {
                let _ = on_event.send(DesktopUpdateEvent::Verifying);
            },
        )
        .await
        .map_err(|error| format!("failed to download desktop update: {error}"))?;

    let _ = on_event.send(DesktopUpdateEvent::Installing);
    update
        .install(bytes)
        .map_err(|error| format!("failed to install desktop update: {error}"))?;
    Ok(DesktopUpdateOutcome::Installed)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![
            check_desktop_update,
            get_auth_callback_status,
            open_auth_url,
            install_desktop_update
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

#[cfg(test)]
mod tests {
    use super::{
        auth_state_from_query, auth_state_from_url, begin_auth_callback_attempt,
        dispatch_auth_callback_once, escape_html, hand_off_auth_callback, js_string_literal,
        open_auth_url_with, render_auth_callback_page, validate_update_metadata,
        AuthCallbackAttempt, AuthCallbackHandoff, DesktopUpdateCheckOutcome, DesktopUpdateEvent,
        UpdateAnnouncement,
    };
    use serde_json::json;
    use std::{cell::Cell, sync::Mutex};

    const TEST_UPDATE_PUBLIC_KEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDcwN0MxNjc3RTkyMTI4QUYKUldTdktDSHBkeFo4Y09kTlFnL1FoM3BQKzBJb1FXTGllUWdDUUdEdjN0KzAvSkpROTdmc01PaVUK";
    const TEST_UPDATE_SIGNATURE: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVTdktDSHBkeFo4Y0lrNTlmN3RxSWoyaUVvU1oxQTFwYTdRdldHbTRlYTZXWW03VitDekRmSEc4MjVwUXlaUjJsYVdaNkV4L3k1M2ZHNCtCTTZkdk5vVGQwOVFRZkx0SFFVPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzgzNzAxNTEyCWZpbGU6cHJvZC5qc29uClRwcUN1K2dpQUZnUkZzWlU2WXhPMGVnSDZoZ1RhcDhXYmtFSUdHMG9TR09xNHBNWVJpTGJSZk4wbnk1allnMFUvQ2hHZklRTVgxTmtYZ0xVZHErWEFBPT0K";
    const TEST_UPDATE_PAYLOAD: &str = r#"{"schema":1,"channel":"prod","bundleId":"cloud.ardor.desktop","version":"1.2.3","pubDate":"2026-07-10T00:00:00.000Z","platforms":{"darwin-aarch64":{"signature":"artifact-signature","url":"https://example.invalid/Ardor-v1.2.3.app.tar.gz"}}}"#;
    const TEST_STAGE1_UPDATE_SIGNATURE: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVTdktDSHBkeFo4Y0RReGlyVEp5bUppOHlNNlYvREpiMWlaUTBFVXpsbmZFdFZhRDRNV0MrMXJNTmpCMVAxTDY2ekJERmpCN0YzcXk5TDdrR3lVN3RydVJQVnBQZEhrbFFVPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzgzNzAxNTEyCWZpbGU6c3RhZ2UxLmpzb24KRkpXVkhDU3FGem9Qb255Vk5vVVlZMmpqVmp5WFVPZWZqajlmUmxjTW9NaXdteThtajUyQmlYcTIyNHNoZUlJb0owMWs2disxaEVIRkhRNlZuOUxKQ1E9PQo=";
    const TEST_STAGE1_UPDATE_PAYLOAD: &str = r#"{"schema":1,"channel":"stage1","bundleId":"cloud.ardor.desktop.stage1","version":"1.2.3","pubDate":"2026-07-10T00:00:00.000Z","platforms":{"windows-x86_64":{"signature":"stage1-artifact-signature","url":"https://example.invalid/Ardor-Dev-v1.2.3-setup.exe"}}}"#;

    fn valid_update_manifest() -> serde_json::Value {
        json!({
            "version": "1.2.3",
            "pub_date": "2026-07-10T00:00:00.000Z",
            "platforms": {
                "darwin-aarch64": {
                    "signature": "artifact-signature",
                    "url": "https://example.invalid/Ardor-v1.2.3.app.tar.gz"
                }
            },
            "ardor": {
                "payload": TEST_UPDATE_PAYLOAD,
                "signature": TEST_UPDATE_SIGNATURE
            }
        })
    }

    fn valid_stage1_update_manifest() -> serde_json::Value {
        json!({
            "version": "1.2.3",
            "pub_date": "2026-07-10T00:00:00.000Z",
            "platforms": {
                "windows-x86_64": {
                    "signature": "stage1-artifact-signature",
                    "url": "https://example.invalid/Ardor-Dev-v1.2.3-setup.exe"
                }
            },
            "ardor": {
                "payload": TEST_STAGE1_UPDATE_PAYLOAD,
                "signature": TEST_STAGE1_UPDATE_SIGNATURE
            }
        })
    }

    fn update_announcement<'a>(
        current_version: &'a str,
        version: &'a str,
        download_url: &'a str,
    ) -> UpdateAnnouncement<'a> {
        UpdateAnnouncement {
            current_version,
            version,
            platform_key: "darwin-aarch64",
            download_url,
            artifact_signature: "artifact-signature",
        }
    }

    #[test]
    fn js_string_literal_escapes_script_sensitive_characters() {
        assert_eq!(
            js_string_literal("tauri://localhost/?code=a\"b\\c\n&state=x\r\t\u{2028}\u{2029}"),
            "\"tauri://localhost/?code=a\\\"b\\\\c\\n&state=x\\r\\t\\u2028\\u2029\""
        );
    }

    #[test]
    fn auth_callback_dispatches_exactly_one_location_replace() {
        let target = tauri::Url::parse("tauri://localhost/?code=code-1&state=state-1")
            .expect("valid callback target");
        let mut scripts = Vec::new();

        dispatch_auth_callback_once(&target, |script| {
            scripts.push(script.to_string());
            Ok(())
        })
        .expect("callback dispatch should succeed");

        assert_eq!(
            scripts,
            ["window.location.replace(\"tauri://localhost/?code=code-1&state=state-1\");"]
        );
    }

    #[test]
    fn auth_callback_does_not_retry_a_failed_location_replace() {
        let target = tauri::Url::parse("tauri://localhost/?code=code-1&state=state-1")
            .expect("valid callback target");
        let attempts = Cell::new(0);

        let error = dispatch_auth_callback_once(&target, |_| {
            attempts.set(attempts.get() + 1);
            Err("eval rejected".to_string())
        })
        .expect_err("failed callback dispatch should be returned");

        assert_eq!(attempts.get(), 1);
        assert_eq!(error, "eval rejected");
    }

    #[test]
    fn auth_callback_state_uses_the_same_percent_decoding_for_authorize_and_callback_urls() {
        let authorize_url = tauri::Url::parse(
            "https://auth-dev.ardor.cloud/authorize?client_id=test&state=state%2Fone",
        )
        .expect("valid authorize URL");

        assert_eq!(
            auth_state_from_url(&authorize_url).as_deref(),
            Some("state/one")
        );
        assert_eq!(
            auth_state_from_query("code=code-1&state=state%2Fone").as_deref(),
            Some("state/one")
        );
    }

    #[test]
    fn auth_url_without_state_fails_closed_before_launch() {
        let attempt = Mutex::new(AuthCallbackAttempt::default());
        let launches = Cell::new(0);
        let dispatches = Cell::new(0);

        let error = open_auth_url_with(
            "https://auth-dev.ardor.cloud/authorize?client_id=test",
            &attempt,
            |_| {
                launches.set(launches.get() + 1);
                Ok(())
            },
        )
        .expect_err("authorization URL without state must be rejected");
        let callback = hand_off_auth_callback(&attempt, Some("untracked-state"), || {
            dispatches.set(dispatches.get() + 1);
            Ok(())
        })
        .expect("rejected callback should return an explicit outcome");

        assert_eq!(
            error,
            "Auth0 authorization URL is missing a non-empty state"
        );
        assert_eq!(launches.get(), 0);
        assert_eq!(callback, AuthCallbackHandoff::Unexpected);
        assert_eq!(dispatches.get(), 0);
    }

    #[test]
    fn failed_auth_url_launch_clears_the_prepared_attempt() {
        let attempt = Mutex::new(AuthCallbackAttempt::default());
        let dispatches = Cell::new(0);

        let error = open_auth_url_with(
            "https://auth-dev.ardor.cloud/authorize?client_id=test&state=state-1",
            &attempt,
            |_| Err("browser launch failed".to_string()),
        )
        .expect_err("failed browser launch should be returned");
        let callback = hand_off_auth_callback(&attempt, Some("state-1"), || {
            dispatches.set(dispatches.get() + 1);
            Ok(())
        })
        .expect("cleared callback should return an explicit outcome");

        assert_eq!(error, "browser launch failed");
        assert_eq!(callback, AuthCallbackHandoff::Unexpected);
        assert_eq!(dispatches.get(), 0);
    }

    #[test]
    fn repeated_auth_callback_dispatches_only_once() {
        let attempt = Mutex::new(AuthCallbackAttempt::default());
        begin_auth_callback_attempt(&attempt, "state-1".to_string());
        let dispatches = Cell::new(0);

        let first = hand_off_auth_callback(&attempt, Some("state-1"), || {
            dispatches.set(dispatches.get() + 1);
            Ok(())
        })
        .expect("first callback should be handled");
        let duplicate = hand_off_auth_callback(&attempt, Some("state-1"), || {
            dispatches.set(dispatches.get() + 1);
            Ok(())
        })
        .expect("duplicate callback should be handled idempotently");

        assert_eq!(first, AuthCallbackHandoff::Queued);
        assert_eq!(duplicate, AuthCallbackHandoff::Duplicate);
        assert_eq!(dispatches.get(), 1);
    }

    #[test]
    fn new_auth_attempt_resets_the_expected_and_claimed_state() {
        let attempt = Mutex::new(AuthCallbackAttempt::default());
        let dispatches = Cell::new(0);
        open_auth_url_with(
            "https://auth-dev.ardor.cloud/authorize?client_id=test&state=state-1",
            &attempt,
            |_| Ok(()),
        )
        .expect("first authorization URL should open");
        assert_eq!(
            hand_off_auth_callback(&attempt, Some("state-1"), || {
                dispatches.set(dispatches.get() + 1);
                Ok(())
            }),
            Ok(AuthCallbackHandoff::Queued)
        );

        open_auth_url_with(
            "https://auth-dev.ardor.cloud/authorize?client_id=test&state=state-2",
            &attempt,
            |_| Ok(()),
        )
        .expect("second authorization URL should reset the attempt");
        assert_eq!(
            hand_off_auth_callback(&attempt, Some("state-1"), || {
                dispatches.set(dispatches.get() + 1);
                Ok(())
            }),
            Ok(AuthCallbackHandoff::Unexpected)
        );
        assert_eq!(
            hand_off_auth_callback(&attempt, Some("state-2"), || {
                dispatches.set(dispatches.get() + 1);
                Ok(())
            }),
            Ok(AuthCallbackHandoff::Queued)
        );
        assert_eq!(dispatches.get(), 2);
    }

    #[test]
    fn unexpected_auth_callback_state_is_rejected_without_consuming_the_attempt() {
        let attempt = Mutex::new(AuthCallbackAttempt::default());
        begin_auth_callback_attempt(&attempt, "expected-state".to_string());
        let dispatches = Cell::new(0);

        assert_eq!(
            hand_off_auth_callback(&attempt, None, || {
                dispatches.set(dispatches.get() + 1);
                Ok(())
            }),
            Ok(AuthCallbackHandoff::Unexpected)
        );
        assert_eq!(
            hand_off_auth_callback(&attempt, Some("wrong-state"), || {
                dispatches.set(dispatches.get() + 1);
                Ok(())
            }),
            Ok(AuthCallbackHandoff::Unexpected)
        );
        assert_eq!(
            hand_off_auth_callback(&attempt, Some("expected-state"), || {
                dispatches.set(dispatches.get() + 1);
                Ok(())
            }),
            Ok(AuthCallbackHandoff::Queued)
        );
        assert_eq!(dispatches.get(), 1);
    }

    #[test]
    fn failed_auth_callback_dispatch_releases_the_claim_for_retry() {
        let attempt = Mutex::new(AuthCallbackAttempt::default());
        begin_auth_callback_attempt(&attempt, "state-1".to_string());
        let dispatches = Cell::new(0);

        let error = hand_off_auth_callback(&attempt, Some("state-1"), || {
            dispatches.set(dispatches.get() + 1);
            Err("eval rejected".to_string())
        })
        .expect_err("dispatch error should be returned");
        let retry = hand_off_auth_callback(&attempt, Some("state-1"), || {
            dispatches.set(dispatches.get() + 1);
            Ok(())
        })
        .expect("retry should be allowed after dispatch failure");

        assert_eq!(error, "eval rejected");
        assert_eq!(retry, AuthCallbackHandoff::Queued);
        assert_eq!(dispatches.get(), 2);
    }

    #[test]
    fn callback_after_process_restart_can_claim_an_unknown_attempt_once() {
        let attempt = Mutex::new(AuthCallbackAttempt::default());
        let dispatches = Cell::new(0);

        let first = hand_off_auth_callback(&attempt, Some("recovered-state"), || {
            dispatches.set(dispatches.get() + 1);
            Ok(())
        })
        .expect("first callback after restart should be recoverable");
        let duplicate = hand_off_auth_callback(&attempt, Some("recovered-state"), || {
            dispatches.set(dispatches.get() + 1);
            Ok(())
        })
        .expect("recovered callback duplicate should be idempotent");

        assert_eq!(first, AuthCallbackHandoff::Queued);
        assert_eq!(duplicate, AuthCallbackHandoff::Duplicate);
        assert_eq!(dispatches.get(), 1);
    }

    #[test]
    fn auth_callback_page_prioritizes_closing_the_tab() {
        let page = render_auth_callback_page(200, "Sign-in is continuing in Ardor Desktop.");

        assert!(page.contains("data-state=\"success\""));
        assert!(page.contains("You can close this tab"));
        assert!(page.contains("Sign-in is continuing in Ardor Desktop."));
        assert!(page.contains("ARDOR"));
        assert!(!page.contains("Secure sign-in handoff"));
        assert!(!page.contains("<strong>Return to Ardor</strong>"));
        assert!(!page.contains("Handled locally by Ardor Desktop"));
        assert!(!page.contains("<script>"));
        assert!(!page.contains("window.close()"));
        assert!(page.contains("color-scheme: light dark"));
        assert!(page.contains("prefers-color-scheme: dark"));
    }

    #[test]
    fn auth_callback_page_renders_safe_error_state() {
        let page = render_auth_callback_page(500, "Try <again> & don't panic.");

        assert!(page.contains("data-state=\"error\""));
        assert!(page.contains("Return to Ardor"));
        assert!(page.contains("Try &lt;again&gt; &amp; don&#39;t panic."));
        assert!(!page.contains("Try <again>"));
        assert!(!page.contains("window.close()"));
    }

    #[test]
    fn html_escaping_covers_attribute_and_element_boundaries() {
        assert_eq!(escape_html("<&>\"'"), "&lt;&amp;&gt;&quot;&#39;");
    }

    #[test]
    fn signed_update_metadata_accepts_an_exact_newer_release() {
        let result = validate_update_metadata(
            &valid_update_manifest(),
            &update_announcement(
                "1.2.2",
                "1.2.3",
                "https://example.invalid/Ardor-v1.2.3.app.tar.gz",
            ),
            "prod",
            "cloud.ardor.desktop",
            TEST_UPDATE_PUBLIC_KEY,
        );

        assert_eq!(
            result
                .expect("valid signed metadata should be accepted")
                .version,
            "1.2.3"
        );
    }

    #[test]
    fn signed_update_metadata_accepts_stage1_windows() {
        let result = validate_update_metadata(
            &valid_stage1_update_manifest(),
            &UpdateAnnouncement {
                current_version: "1.2.2",
                version: "1.2.3",
                platform_key: "windows-x86_64",
                download_url: "https://example.invalid/Ardor-Dev-v1.2.3-setup.exe",
                artifact_signature: "stage1-artifact-signature",
            },
            "stage1",
            "cloud.ardor.desktop.stage1",
            TEST_UPDATE_PUBLIC_KEY,
        );

        assert_eq!(
            result
                .expect("valid stage1 metadata should be accepted")
                .version,
            "1.2.3"
        );
    }

    #[test]
    fn desktop_update_check_outcome_uses_a_discriminated_contract() {
        assert_eq!(
            serde_json::to_value(DesktopUpdateCheckOutcome::UpToDate).unwrap(),
            json!({ "status": "up-to-date" })
        );
        assert_eq!(
            serde_json::to_value(DesktopUpdateCheckOutcome::Available {
                version: "1.2.3".to_string(),
            })
            .unwrap(),
            json!({ "status": "available", "version": "1.2.3" })
        );
    }

    #[test]
    fn desktop_update_events_distinguish_verification_from_installation() {
        assert_eq!(
            serde_json::to_value(DesktopUpdateEvent::Verifying).unwrap(),
            json!({ "event": "Verifying" })
        );
        assert_eq!(
            serde_json::to_value(DesktopUpdateEvent::Installing).unwrap(),
            json!({ "event": "Installing" })
        );
    }

    #[test]
    fn signed_update_metadata_rejects_a_forged_top_level_version() {
        let mut manifest = valid_update_manifest();
        manifest["version"] = json!("999.0.0");

        let error = validate_update_metadata(
            &manifest,
            &update_announcement(
                "1.2.2",
                "999.0.0",
                "https://example.invalid/Ardor-v1.2.3.app.tar.gz",
            ),
            "prod",
            "cloud.ardor.desktop",
            TEST_UPDATE_PUBLIC_KEY,
        )
        .expect_err("forged version must be rejected");

        assert!(error.contains("version does not match signed update metadata"));
    }

    #[test]
    fn signed_update_metadata_rejects_the_wrong_channel_or_bundle() {
        for (channel, bundle_id) in [
            ("stage1", "cloud.ardor.desktop"),
            ("prod", "cloud.ardor.desktop.stage1"),
        ] {
            assert!(validate_update_metadata(
                &valid_update_manifest(),
                &update_announcement(
                    "1.2.2",
                    "1.2.3",
                    "https://example.invalid/Ardor-v1.2.3.app.tar.gz",
                ),
                channel,
                bundle_id,
                TEST_UPDATE_PUBLIC_KEY,
            )
            .is_err());
        }
    }

    #[test]
    fn signed_update_metadata_rejects_tampered_artifact_selection() {
        let error = validate_update_metadata(
            &valid_update_manifest(),
            &update_announcement(
                "1.2.2",
                "1.2.3",
                "https://example.invalid/Ardor-v1.2.2.app.tar.gz",
            ),
            "prod",
            "cloud.ardor.desktop",
            TEST_UPDATE_PUBLIC_KEY,
        )
        .expect_err("tampered artifact URL must be rejected");

        assert!(error.contains("URL does not match signed metadata"));

        let signature_error = validate_update_metadata(
            &valid_update_manifest(),
            &UpdateAnnouncement {
                current_version: "1.2.2",
                version: "1.2.3",
                platform_key: "darwin-aarch64",
                download_url: "https://example.invalid/Ardor-v1.2.3.app.tar.gz",
                artifact_signature: "forged-artifact-signature",
            },
            "prod",
            "cloud.ardor.desktop",
            TEST_UPDATE_PUBLIC_KEY,
        )
        .expect_err("tampered artifact signature must be rejected");

        assert!(signature_error.contains("artifact signature does not match signed metadata"));
    }

    #[test]
    fn signed_update_metadata_rejects_equal_or_older_versions() {
        for current_version in ["1.2.3", "1.2.4"] {
            let error = validate_update_metadata(
                &valid_update_manifest(),
                &update_announcement(
                    current_version,
                    "1.2.3",
                    "https://example.invalid/Ardor-v1.2.3.app.tar.gz",
                ),
                "prod",
                "cloud.ardor.desktop",
                TEST_UPDATE_PUBLIC_KEY,
            )
            .expect_err("equal or older version must not install");

            assert!(error.contains("is not newer"));
        }
    }

    #[test]
    fn signed_update_metadata_rejects_unsigned_top_level_fields() {
        let cases = [
            ("pub_date", json!("2099-01-01T00:00:00.000Z")),
            (
                "platforms",
                json!({
                    "darwin-aarch64": {
                        "signature": "forged-artifact-signature",
                        "url": "https://example.invalid/Ardor-v1.2.3.app.tar.gz"
                    }
                }),
            ),
        ];

        for (field, value) in cases {
            let mut manifest = valid_update_manifest();
            manifest[field] = value;
            assert!(validate_update_metadata(
                &manifest,
                &update_announcement(
                    "1.2.2",
                    "1.2.3",
                    "https://example.invalid/Ardor-v1.2.3.app.tar.gz",
                ),
                "prod",
                "cloud.ardor.desktop",
                TEST_UPDATE_PUBLIC_KEY,
            )
            .is_err());
        }
    }

    #[test]
    fn signed_update_metadata_fails_closed_without_a_valid_envelope() {
        let mut missing = valid_update_manifest();
        missing.as_object_mut().unwrap().remove("ardor");
        assert!(validate_update_metadata(
            &missing,
            &update_announcement(
                "1.2.2",
                "1.2.3",
                "https://example.invalid/Ardor-v1.2.3.app.tar.gz",
            ),
            "prod",
            "cloud.ardor.desktop",
            TEST_UPDATE_PUBLIC_KEY,
        )
        .is_err());

        let mut invalid_signature = valid_update_manifest();
        invalid_signature["ardor"]["signature"] = json!("not-a-signature");
        assert!(validate_update_metadata(
            &invalid_signature,
            &update_announcement(
                "1.2.2",
                "1.2.3",
                "https://example.invalid/Ardor-v1.2.3.app.tar.gz",
            ),
            "prod",
            "cloud.ardor.desktop",
            TEST_UPDATE_PUBLIC_KEY,
        )
        .is_err());
    }
}
