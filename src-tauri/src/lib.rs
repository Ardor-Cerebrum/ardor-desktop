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
    match navigate_auth_callback(window, target) {
        Ok(()) => {
            let _ = write_response(
                &mut stream,
                200,
                "OK",
                "Your session is ready. Return to Ardor to continue.",
            );
        }
        Err(error) => {
            eprintln!("Failed to hand off desktop auth callback to WebView: {error}");
            let _ = write_response(
                &mut stream,
                500,
                "Internal Server Error",
                "Authentication callback failed. Return to Ardor and try again.",
            );
        }
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
    let script = format!(
        "window.location.replace({});",
        js_string_literal(target.as_str())
    );
    let eval_result = window
        .eval(&script)
        .map_err(|error| format!("location replace script failed: {error}"));
    let navigate_result = window
        .navigate(target)
        .map_err(|error| format!("window navigate failed: {error}"));

    if eval_result.is_ok() || navigate_result.is_ok() {
        if let Err(error) = eval_result {
            eprintln!(
                "Desktop auth callback JS handoff failed; native navigation was queued: {error}"
            );
        }
        if let Err(error) = navigate_result {
            eprintln!(
                "Desktop auth callback native navigation failed; JS handoff was queued: {error}"
            );
        }

        return Ok(());
    }

    Err(format!(
        "{}; {}",
        eval_result.expect_err("checked failed eval result"),
        navigate_result.expect_err("checked failed navigate result")
    ))
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
    let (state, document_title, eyebrow, title, action_detail, close_note, close_script) =
        if is_success {
            (
                "success",
                "Authentication complete — Ardor",
                "Secure sign-in complete",
                "Authentication complete",
                "Your sign-in is already continuing there.",
                "You can close this tab safely.",
                "window.setTimeout(function () { window.close(); }, 700);",
            )
        } else {
            (
                "error",
                "Sign-in issue — Ardor",
                "Sign-in needs attention",
                "We couldn't complete sign-in",
                "Try signing in again from the desktop app.",
                "Keep Ardor open while you retry.",
                "",
            )
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
        color-scheme: dark;
        --page: #09090b;
        --card: rgba(24, 24, 27, 0.82);
        --card-strong: rgba(39, 39, 42, 0.72);
        --text: #fafafa;
        --muted: #a1a1aa;
        --line: rgba(255, 255, 255, 0.1);
        --line-soft: rgba(255, 255, 255, 0.06);
        --orange: #f97316;
        --purple: #9000af;
        --success: #22c55e;
        --success-soft: rgba(34, 197, 94, 0.14);
        --error: #fb7185;
        --error-soft: rgba(251, 113, 133, 0.14);
      }

      * { box-sizing: border-box; }

      html { min-height: 100%; }

      body {
        min-height: 100vh;
        min-height: 100svh;
        margin: 0;
        display: grid;
        place-items: center;
        overflow: hidden;
        background:
          radial-gradient(circle at 16% 12%, rgba(249, 115, 22, 0.16), transparent 34%),
          radial-gradient(circle at 86% 84%, rgba(144, 0, 175, 0.13), transparent 31%),
          var(--page);
        color: var(--text);
        font-family: "Segoe UI Variable", "Aptos", -apple-system, BlinkMacSystemFont, sans-serif;
        text-rendering: optimizeLegibility;
      }

      body::before {
        content: "";
        position: fixed;
        inset: 0;
        pointer-events: none;
        opacity: 0.28;
        background-image: radial-gradient(rgba(255, 255, 255, 0.22) 0.65px, transparent 0.65px);
        background-size: 22px 22px;
        mask-image: linear-gradient(to bottom, black, transparent 78%);
      }

      .shell {
        position: relative;
        width: min(420px, calc(100vw - 32px));
        animation: arrive 540ms cubic-bezier(0.22, 1, 0.36, 1) both;
      }

      .brand {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 9px;
        margin-bottom: 18px;
        color: var(--text);
      }

      .brand-mark { width: 25px; height: 25px; }

      .brand-name {
        font-size: 13px;
        font-weight: 720;
        letter-spacing: 0.16em;
      }

      .brand-product {
        margin-left: -3px;
        color: var(--muted);
        font-size: 10px;
        font-weight: 650;
        letter-spacing: 0.18em;
      }

      .card {
        position: relative;
        overflow: hidden;
        padding: 34px;
        border: 1px solid var(--line);
        border-radius: 14px;
        background: var(--card);
        box-shadow: 0 28px 90px rgba(0, 0, 0, 0.38), inset 0 1px 0 rgba(255, 255, 255, 0.04);
        backdrop-filter: blur(24px) saturate(130%);
      }

      .card::before {
        content: "";
        position: absolute;
        inset: 0 0 auto;
        height: 2px;
        background: linear-gradient(90deg, transparent, var(--orange) 28%, #ffb547 52%, var(--purple) 78%, transparent);
        opacity: 0.9;
      }

      .status-icon {
        width: 54px;
        height: 54px;
        display: grid;
        place-items: center;
        margin-bottom: 25px;
        border: 1px solid color-mix(in srgb, var(--state) 36%, transparent);
        border-radius: 50%;
        background: var(--state-soft);
        color: var(--state);
        box-shadow: 0 0 0 7px color-mix(in srgb, var(--state) 5%, transparent);
        animation: status-pop 500ms 160ms cubic-bezier(0.34, 1.56, 0.64, 1) both;
      }

      body[data-state="success"] { --state: var(--success); --state-soft: var(--success-soft); }
      body[data-state="error"] { --state: var(--error); --state-soft: var(--error-soft); }
      body[data-state="success"] .error-glyph,
      body[data-state="error"] .success-glyph { display: none; }

      .status-icon svg { width: 25px; height: 25px; }

      .eyebrow {
        display: flex;
        align-items: center;
        gap: 8px;
        margin: 0 0 10px;
        color: var(--muted);
        font-family: "Cascadia Mono", "SFMono-Regular", Consolas, monospace;
        font-size: 10px;
        font-weight: 650;
        letter-spacing: 0.13em;
        text-transform: uppercase;
      }

      .status-dot {
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: var(--state);
        box-shadow: 0 0 12px color-mix(in srgb, var(--state) 75%, transparent);
      }

      h1 {
        margin: 0;
        max-width: 330px;
        font-size: clamp(29px, 7vw, 36px);
        font-weight: 650;
        letter-spacing: -0.045em;
        line-height: 1.08;
      }

      .message {
        margin: 15px 0 25px;
        color: var(--muted);
        font-size: 15px;
        line-height: 1.6;
      }

      .handoff {
        display: grid;
        grid-template-columns: 34px 1fr 18px;
        align-items: center;
        gap: 12px;
        padding: 14px;
        border: 1px solid var(--line-soft);
        border-radius: 9px;
        background: var(--card-strong);
      }

      .handoff-mark {
        width: 34px;
        height: 34px;
        display: grid;
        place-items: center;
        border: 1px solid var(--line);
        border-radius: 8px;
        color: var(--orange);
        background: rgba(249, 115, 22, 0.08);
      }

      .handoff-mark svg,
      .handoff-arrow { width: 17px; height: 17px; }

      .handoff strong,
      .handoff span { display: block; }

      .handoff strong {
        margin-bottom: 3px;
        font-size: 13px;
        font-weight: 650;
      }

      .handoff span {
        color: var(--muted);
        font-size: 11px;
        line-height: 1.4;
      }

      .handoff-arrow { color: var(--muted); }

      .close-note {
        margin: 18px 0 0;
        color: var(--muted);
        font-size: 11px;
        text-align: center;
      }

      .local-note {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 7px;
        margin: 16px 0 0;
        color: var(--muted);
        font-family: "Cascadia Mono", "SFMono-Regular", Consolas, monospace;
        font-size: 9px;
        letter-spacing: 0.06em;
        opacity: 0.72;
      }

      .local-note svg { width: 12px; height: 12px; }

      @keyframes arrive {
        from { opacity: 0; transform: translateY(14px) scale(0.985); }
        to { opacity: 1; transform: translateY(0) scale(1); }
      }

      @keyframes status-pop {
        from { opacity: 0; transform: scale(0.72) rotate(-8deg); }
        to { opacity: 1; transform: scale(1) rotate(0); }
      }

      @media (prefers-color-scheme: light) {
        :root {
          color-scheme: light;
          --page: #f7f7f8;
          --card: rgba(255, 255, 255, 0.86);
          --card-strong: rgba(244, 244, 245, 0.72);
          --text: #09090b;
          --muted: #71717a;
          --line: rgba(24, 24, 27, 0.12);
          --line-soft: rgba(24, 24, 27, 0.07);
          --success: #16a34a;
          --success-soft: rgba(22, 163, 74, 0.1);
          --error: #dc2626;
          --error-soft: rgba(220, 38, 38, 0.09);
        }

        body::before {
          opacity: 0.17;
          background-image: radial-gradient(rgba(24, 24, 27, 0.32) 0.6px, transparent 0.6px);
        }

        .card {
          box-shadow: 0 28px 80px rgba(24, 24, 27, 0.13), inset 0 1px 0 rgba(255, 255, 255, 0.8);
        }
      }

      @media (max-width: 480px) {
        .card { padding: 28px 24px; }
        .brand { margin-bottom: 14px; }
      }

      @media (prefers-reduced-motion: reduce) {
        .shell,
        .status-icon { animation: none; }
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

      <section class="card" aria-labelledby="page-title" aria-live="polite">
        <div class="status-icon" aria-hidden="true">
          <svg class="success-glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 4.2 4.2L19 6.5"/></svg>
          <svg class="error-glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 7v6"/><path d="M12 17.2h.01"/><circle cx="12" cy="12" r="9"/></svg>
        </div>

        <p class="eyebrow"><span class="status-dot"></span>%%EYEBROW%%</p>
        <h1 id="page-title">%%TITLE%%</h1>
        <p class="message">%%MESSAGE%%</p>

        <div class="handoff">
          <div class="handoff-mark" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 7h6M9 11h6M9 15h3"/></svg>
          </div>
          <div>
            <strong>Return to Ardor</strong>
            <span>%%ACTION_DETAIL%%</span>
          </div>
          <svg class="handoff-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>
        </div>

        <p class="close-note">%%CLOSE_NOTE%%</p>
      </section>

      <p class="local-note">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>
        Handled locally by Ardor Desktop
      </p>
    </main>

    <script>%%CLOSE_SCRIPT%%</script>
  </body>
</html>"##;

    TEMPLATE
        .replace("%%DOCUMENT_TITLE%%", document_title)
        .replace("%%STATE%%", state)
        .replace("%%EYEBROW%%", eyebrow)
        .replace("%%TITLE%%", title)
        .replace("%%ACTION_DETAIL%%", action_detail)
        .replace("%%CLOSE_NOTE%%", close_note)
        .replace("%%CLOSE_SCRIPT%%", close_script)
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
        "HTTP/1.1 {status} {reason}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store, max-age=0\r\nPragma: no-cache\r\nContent-Security-Policy: default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'\r\nReferrer-Policy: no-referrer\r\nX-Content-Type-Options: nosniff\r\nX-Frame-Options: DENY\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
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

#[cfg(test)]
mod tests {
    use super::{escape_html, js_string_literal, render_auth_callback_page};

    #[test]
    fn js_string_literal_escapes_script_sensitive_characters() {
        assert_eq!(
            js_string_literal("tauri://localhost/?code=a\"b\\c\n&state=x\r\t\u{2028}\u{2029}"),
            "\"tauri://localhost/?code=a\\\"b\\\\c\\n&state=x\\r\\t\\u2028\\u2029\""
        );
    }

    #[test]
    fn auth_callback_page_renders_branded_success_state() {
        let page = render_auth_callback_page(200, "Return to Ardor.");

        assert!(page.contains("data-state=\"success\""));
        assert!(page.contains("Authentication complete"));
        assert!(page.contains("ARDOR"));
        assert!(page.contains("Handled locally by Ardor Desktop"));
        assert!(page.contains("window.close()"));
    }

    #[test]
    fn auth_callback_page_renders_safe_error_state() {
        let page = render_auth_callback_page(500, "Try <again> & don't panic.");

        assert!(page.contains("data-state=\"error\""));
        assert!(page.contains("We couldn't complete sign-in"));
        assert!(page.contains("Try &lt;again&gt; &amp; don&#39;t panic."));
        assert!(!page.contains("Try <again>"));
        assert!(!page.contains("window.close()"));
    }

    #[test]
    fn html_escaping_covers_attribute_and_element_boundaries() {
        assert_eq!(escape_html("<&>\"'"), "&lt;&amp;&gt;&quot;&#39;");
    }
}
