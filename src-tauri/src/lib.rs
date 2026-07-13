use std::{
    collections::HashMap,
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    process::Command,
    sync::{Mutex, OnceLock},
    thread,
    time::{Duration, Instant},
};

use base64::{
    engine::general_purpose::{STANDARD as BASE64, URL_SAFE_NO_PAD},
    Engine as _,
};
use minisign_verify::{PublicKey, Signature};
use tauri::{ipc::Channel, Emitter, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

const AUTH_CALLBACK_ADDR: &str = "127.0.0.1:17631";
const AUTH_CALLBACK_PATH: &str = "/auth/callback";
const AUTH_FOCUS_PATH: &str = "/auth/focus";
const LOOPBACK_CALLBACK_URL: &str = "http://127.0.0.1:17631/auth/callback";
const PROD_BUNDLE_ID: &str = "cloud.ardor.desktop";
const STAGE1_BUNDLE_ID: &str = "cloud.ardor.desktop.stage1";
const UPDATE_METADATA_SCHEMA: u32 = 1;
const UPDATE_CHECK_TIMEOUT: Duration = Duration::from_secs(30);
const UPDATE_DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(15 * 60);
const AUTH_CALLBACK_ATTEMPT_TTL: Duration = Duration::from_secs(10 * 60);
const AUTH_CALLBACK_IO_TIMEOUT: Duration = Duration::from_secs(5);
const AUTH_CALLBACK_MAX_REQUEST_BYTES: usize = 8 * 1024;
const AUTH_STATE_MAX_LENGTH: usize = 2 * 1024;
const AUTH_CALLBACK_READY_EVENT: &str = "desktop-auth-callback-ready";
const AUTH_FOCUS_TOKEN_BYTES: usize = 32;
const AUTH_FOCUS_MAX_USES: u8 = 3;

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

#[derive(Default)]
struct AuthCallbackAttempt {
    expected_state: Option<String>,
    claimed: bool,
    expires_at: Option<Instant>,
    next_callback_id: u64,
    pending: Option<PendingAuthCallback>,
    prepared_focus_token: Option<String>,
    focus_grant: Option<AuthFocusGrant>,
}

struct AuthFocusGrant {
    token: String,
    expires_at: Instant,
    remaining_uses: u8,
}

#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct PendingAuthCallback {
    id: u64,
    callback_url: String,
}

#[derive(Debug, PartialEq)]
enum AuthCallbackClaim {
    Claimed,
    Duplicate,
    Unexpected,
    Expired,
}

#[derive(Debug, PartialEq)]
enum AuthCallbackHandoff {
    Queued,
    Duplicate,
    Unexpected,
    Expired,
}

impl AuthCallbackAttempt {
    fn begin(&mut self, expected_state: String, focus_token: String, now: Instant) {
        self.clear();
        self.expected_state = Some(expected_state);
        self.claimed = false;
        self.expires_at = Some(now + AUTH_CALLBACK_ATTEMPT_TTL);
        self.prepared_focus_token = Some(focus_token);
    }

    fn clear_active_callback(&mut self) {
        self.expected_state = None;
        self.claimed = false;
        self.expires_at = None;
        self.pending = None;
        self.prepared_focus_token = None;
    }

    fn clear(&mut self) {
        self.clear_active_callback();
        self.focus_grant = None;
    }

    fn claim(&mut self, callback_state: &str, now: Instant) -> AuthCallbackClaim {
        if callback_state.is_empty() || self.expected_state.is_none() {
            return AuthCallbackClaim::Unexpected;
        }

        if self.expires_at.is_none_or(|expires_at| now >= expires_at) {
            self.clear_active_callback();
            return AuthCallbackClaim::Expired;
        }

        if self.expected_state.as_deref() != Some(callback_state) {
            return AuthCallbackClaim::Unexpected;
        }

        if self.claimed {
            AuthCallbackClaim::Duplicate
        } else {
            self.claimed = true;
            AuthCallbackClaim::Claimed
        }
    }

    fn queue_callback(
        &mut self,
        callback_state: &str,
        callback_url: String,
        now: Instant,
    ) -> AuthCallbackClaim {
        let claim = self.claim(callback_state, now);
        if claim == AuthCallbackClaim::Claimed {
            self.next_callback_id = self.next_callback_id.wrapping_add(1).max(1);
            self.pending = Some(PendingAuthCallback {
                id: self.next_callback_id,
                callback_url,
            });
            self.focus_grant = self
                .prepared_focus_token
                .take()
                .map(|token| AuthFocusGrant {
                    token,
                    expires_at: now + AUTH_CALLBACK_ATTEMPT_TTL,
                    remaining_uses: AUTH_FOCUS_MAX_USES,
                });
        }
        claim
    }

    fn complete_callback(&mut self, callback_id: u64) -> bool {
        if self.pending.as_ref().map(|pending| pending.id) != Some(callback_id) {
            return false;
        }
        self.clear_active_callback();
        true
    }

    fn expire(&mut self, now: Instant) {
        if self
            .focus_grant
            .as_ref()
            .is_some_and(|grant| now >= grant.expires_at || grant.remaining_uses == 0)
        {
            self.focus_grant = None;
        }

        if self.expires_at.is_some_and(|expires_at| now >= expires_at) {
            self.clear_active_callback();
        }
    }

    fn consume_focus_token(&mut self, token: &str, now: Instant) -> bool {
        self.expire(now);
        let Some(grant) = self.focus_grant.as_mut() else {
            return false;
        };
        if grant.token != token {
            return false;
        }

        grant.remaining_uses -= 1;
        if grant.remaining_uses == 0 {
            self.focus_grant = None;
        }
        true
    }

    fn current_focus_token(&mut self, now: Instant) -> Option<String> {
        self.expire(now);
        self.focus_grant.as_ref().map(|grant| grant.token.clone())
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

fn auth_callback_attempt() -> &'static Mutex<AuthCallbackAttempt> {
    AUTH_CALLBACK_ATTEMPT.get_or_init(|| Mutex::new(AuthCallbackAttempt::default()))
}

fn desktop_update_operation() -> &'static tauri::async_runtime::Mutex<()> {
    DESKTOP_UPDATE_OPERATION.get_or_init(|| tauri::async_runtime::Mutex::new(()))
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
fn get_pending_auth_callback() -> Option<PendingAuthCallback> {
    let mut attempt = auth_callback_attempt()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    attempt.expire(Instant::now());
    attempt.pending.clone()
}

#[tauri::command]
fn complete_auth_callback(callback_id: u64) -> bool {
    auth_callback_attempt()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .complete_callback(callback_id)
}

#[tauri::command]
fn open_auth_url(url: String) -> Result<(), String> {
    let status = get_current_auth_callback_status();
    if !status.listening {
        return Err(status
            .error
            .unwrap_or_else(|| "Desktop auth callback server is not listening.".to_string()));
    }

    open_auth_url_with(
        &url,
        auth_callback_attempt(),
        Instant::now(),
        open_external_url,
    )
}

fn open_auth_url_with<F>(
    url: &str,
    attempt: &Mutex<AuthCallbackAttempt>,
    now: Instant,
    open_external: F,
) -> Result<(), String>
where
    F: FnOnce(&str) -> Result<(), String>,
{
    let parsed = tauri::Url::parse(url).map_err(|error| error.to_string())?;
    if !is_auth0_authorize_url(&parsed) {
        return Err("refusing to open non-Auth0 authorization URL".to_string());
    }
    let Some(expected_state) = auth_state_from_url(&parsed) else {
        return Err("Auth0 authorization URL is missing a non-empty state".to_string());
    };

    prepare_auth_callback_attempt(attempt, expected_state, now)?;
    if let Err(error) = open_external(url) {
        clear_auth_callback_attempt(attempt);
        return Err(error);
    }

    Ok(())
}

fn is_auth0_url(url: &tauri::Url) -> bool {
    url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && url.port_or_known_default() == Some(443)
        && matches!(
            url.host_str().unwrap_or_default(),
            "auth-dev.ardor.cloud" | "auth.ardor.cloud"
        )
}

fn is_auth0_authorize_url(url: &tauri::Url) -> bool {
    is_auth0_url(url) && url.path() == "/authorize"
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
            let window = window.clone();
            thread::spawn(move || handle_auth_callback(&window, stream));
        }
    });
}

fn handle_auth_callback(window: &tauri::WebviewWindow, stream: TcpStream) {
    handle_auth_callback_with(
        stream,
        auth_callback_attempt(),
        Instant::now(),
        || {
            window
                .emit(AUTH_CALLBACK_READY_EVENT, ())
                .map_err(|error| format!("failed to notify WebView about auth callback: {error}"))
        },
        || focus_desktop_window(window),
    );
}

fn handle_auth_callback_with<D, F>(
    mut stream: TcpStream,
    attempt: &Mutex<AuthCallbackAttempt>,
    now: Instant,
    dispatch: F,
    focus: D,
) where
    D: FnOnce() -> Result<(), String>,
    F: FnOnce() -> Result<(), String>,
{
    if stream
        .set_read_timeout(Some(AUTH_CALLBACK_IO_TIMEOUT))
        .and_then(|()| stream.set_write_timeout(Some(AUTH_CALLBACK_IO_TIMEOUT)))
        .is_err()
    {
        return;
    }

    let Ok(path) = read_auth_callback_request_path(&mut stream) else {
        let _ = write_response(
            &mut stream,
            400,
            "Bad Request",
            "Invalid callback request.",
            None,
        );
        return;
    };

    let (request_path, query) = path
        .split_once('?')
        .map_or((path.as_str(), ""), |(path, query)| (path, query));

    if request_path == AUTH_FOCUS_PATH {
        let focus_token = auth_focus_token_from_query(query);
        let authorized =
            focus_token.is_some_and(|token| consume_auth_focus_token(attempt, token.as_str(), now));
        if !authorized {
            let _ = write_response(
                &mut stream,
                404,
                "Not Found",
                "Unknown callback path.",
                None,
            );
            return;
        }

        match focus() {
            Ok(()) => {
                let _ = write_empty_response(&mut stream, 204, "No Content");
            }
            Err(error) => {
                eprintln!("Failed to focus Ardor Desktop from auth callback page: {error}");
                let _ = write_response(
                    &mut stream,
                    500,
                    "Internal Server Error",
                    "Ardor could not be brought to the front. Select it from the taskbar.",
                    None,
                );
            }
        }
        return;
    }

    if request_path != AUTH_CALLBACK_PATH {
        let _ = write_response(
            &mut stream,
            404,
            "Not Found",
            "Unknown callback path.",
            None,
        );
        return;
    }

    let callback_state = auth_state_from_query(query);
    let callback_url = format!("{LOOPBACK_CALLBACK_URL}?{query}");
    match hand_off_auth_callback(attempt, callback_state.as_deref(), callback_url, now) {
        AuthCallbackHandoff::Queued => {
            // The callback remains pending and the UI also polls, so losing
            // this wake-up event must not consume the one-shot Auth0 code.
            let _ = dispatch();
            let focus_token = current_auth_focus_token(attempt, now);
            let _ = write_response(
                &mut stream,
                200,
                "OK",
                "Sign-in is continuing in Ardor Desktop.",
                focus_token.as_deref(),
            );
        }
        AuthCallbackHandoff::Duplicate => {
            let focus_token = current_auth_focus_token(attempt, now);
            let _ = write_response(
                &mut stream,
                200,
                "OK",
                "Ardor Desktop already received this sign-in.",
                focus_token.as_deref(),
            );
        }
        AuthCallbackHandoff::Unexpected | AuthCallbackHandoff::Expired => {
            let _ = write_response(
                &mut stream,
                400,
                "Bad Request",
                "This sign-in link is no longer valid. Start again from Ardor Desktop.",
                None,
            );
        }
    }
}

fn focus_desktop_window(window: &tauri::WebviewWindow) -> Result<(), String> {
    window
        .show()
        .map_err(|error| format!("failed to show desktop window: {error}"))?;
    window
        .unminimize()
        .map_err(|error| format!("failed to restore desktop window: {error}"))?;
    window
        .set_focus()
        .map_err(|error| format!("failed to focus desktop window: {error}"))
}

fn consume_auth_focus_token(
    attempt: &Mutex<AuthCallbackAttempt>,
    token: &str,
    now: Instant,
) -> bool {
    attempt
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .consume_focus_token(token, now)
}

fn current_auth_focus_token(attempt: &Mutex<AuthCallbackAttempt>, now: Instant) -> Option<String> {
    attempt
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .current_focus_token(now)
}

fn auth_state_from_url(url: &tauri::Url) -> Option<String> {
    exactly_one_non_empty_query_value(url, "state", AUTH_STATE_MAX_LENGTH)
}

fn auth_state_from_query(query: &str) -> Option<String> {
    if query.len() > AUTH_CALLBACK_MAX_REQUEST_BYTES {
        return None;
    }

    let mut url = tauri::Url::parse("http://localhost/").expect("valid query parsing URL");
    url.set_query((!query.is_empty()).then_some(query));
    let state = auth_state_from_url(&url)?;
    let code_count = url.query_pairs().filter(|(key, _)| key == "code").count();
    let error_count = url.query_pairs().filter(|(key, _)| key == "error").count();
    let result_key = match (code_count, error_count) {
        (1, 0) => "code",
        (0, 1) => "error",
        _ => return None,
    };
    exactly_one_non_empty_query_value(&url, result_key, AUTH_CALLBACK_MAX_REQUEST_BYTES)?;
    Some(state)
}

fn auth_focus_token_from_query(query: &str) -> Option<String> {
    if query.len() > AUTH_CALLBACK_MAX_REQUEST_BYTES {
        return None;
    }

    let mut url = tauri::Url::parse("http://localhost/").expect("valid query parsing URL");
    url.set_query((!query.is_empty()).then_some(query));
    if url.query_pairs().count() != 1 {
        return None;
    }
    exactly_one_non_empty_query_value(&url, "token", AUTH_STATE_MAX_LENGTH)
}

fn generate_auth_focus_token() -> Result<String, String> {
    let mut bytes = [0_u8; AUTH_FOCUS_TOKEN_BYTES];
    getrandom::fill(&mut bytes)
        .map_err(|error| format!("failed to generate return-to-app token: {error}"))?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

fn exactly_one_non_empty_query_value(
    url: &tauri::Url,
    expected_key: &str,
    max_length: usize,
) -> Option<String> {
    let mut values = url
        .query_pairs()
        .filter_map(|(key, value)| (key == expected_key).then(|| value.into_owned()));
    let value = values.next()?;
    if value.is_empty() || value.len() > max_length || values.next().is_some() {
        return None;
    }
    Some(value)
}

#[cfg(test)]
fn begin_auth_callback_attempt(
    attempt: &Mutex<AuthCallbackAttempt>,
    expected_state: String,
    now: Instant,
) {
    let focus_token = format!("focus-{expected_state}");
    attempt
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .begin(expected_state, focus_token, now);
}

fn prepare_auth_callback_attempt(
    attempt: &Mutex<AuthCallbackAttempt>,
    expected_state: String,
    now: Instant,
) -> Result<(), String> {
    let mut attempt = attempt
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    attempt.expire(now);
    if attempt.pending.is_some() {
        return Err("a desktop authentication callback is still pending".to_string());
    }
    let focus_token = generate_auth_focus_token()?;
    attempt.begin(expected_state, focus_token, now);
    Ok(())
}

fn clear_auth_callback_attempt(attempt: &Mutex<AuthCallbackAttempt>) {
    attempt
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clear();
}

fn hand_off_auth_callback(
    attempt: &Mutex<AuthCallbackAttempt>,
    callback_state: Option<&str>,
    callback_url: String,
    now: Instant,
) -> AuthCallbackHandoff {
    let Some(callback_state) = callback_state.filter(|state| !state.is_empty()) else {
        return AuthCallbackHandoff::Unexpected;
    };
    let claim = attempt
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .queue_callback(callback_state, callback_url, now);

    match claim {
        AuthCallbackClaim::Duplicate => AuthCallbackHandoff::Duplicate,
        AuthCallbackClaim::Unexpected => AuthCallbackHandoff::Unexpected,
        AuthCallbackClaim::Expired => AuthCallbackHandoff::Expired,
        AuthCallbackClaim::Claimed => AuthCallbackHandoff::Queued,
    }
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
    match (parts.next(), parts.next(), parts.next(), parts.next()) {
        (Some("GET"), Some(path), Some("HTTP/1.1"), None) => Some(path),
        _ => None,
    }
}

fn read_auth_callback_request_path(stream: &mut TcpStream) -> Result<String, String> {
    let mut request = Vec::with_capacity(1024);
    let mut chunk = [0; 1024];

    loop {
        if request.len() == AUTH_CALLBACK_MAX_REQUEST_BYTES {
            return Err("callback request headers exceed the allowed size".to_string());
        }

        let remaining = AUTH_CALLBACK_MAX_REQUEST_BYTES - request.len();
        let read_length = remaining.min(chunk.len());
        let bytes_read = stream
            .read(&mut chunk[..read_length])
            .map_err(|error| format!("failed to read callback request: {error}"))?;
        if bytes_read == 0 {
            return Err("callback request ended before its headers were complete".to_string());
        }
        request.extend_from_slice(&chunk[..bytes_read]);

        if request.windows(4).any(|window| window == b"\r\n\r\n")
            || request.windows(2).any(|window| window == b"\n\n")
        {
            break;
        }
    }

    let request = std::str::from_utf8(&request)
        .map_err(|_| "callback request headers are not valid UTF-8".to_string())?;
    let mut lines = request.lines();
    let path = lines
        .next()
        .and_then(parse_request_path)
        .map(ToOwned::to_owned)
        .ok_or_else(|| "callback request line is invalid".to_string())?;
    let mut hosts = lines.filter_map(|line| {
        let (name, value) = line.split_once(':')?;
        name.eq_ignore_ascii_case("host").then(|| value.trim())
    });
    if hosts.next() != Some(AUTH_CALLBACK_ADDR) || hosts.next().is_some() {
        return Err("callback request host is invalid".to_string());
    }
    Ok(path)
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

fn render_auth_callback_page(status: u16, message: &str, focus_token: Option<&str>) -> String {
    let is_success = (200..300).contains(&status);
    let (state, document_title, eyebrow, title, action_detail, close_note) = if is_success {
        (
            "success",
            "Sign-in continuing — Ardor",
            "Secure sign-in received",
            "Return to Ardor",
            "Ardor Desktop is still finishing authentication.",
            "Keep Ardor open until the app shows the next step.",
        )
    } else {
        (
            "error",
            "Sign-in issue — Ardor",
            "Sign-in needs attention",
            "We couldn't complete sign-in",
            "Try signing in again from the desktop app.",
            "Keep Ardor open while you retry.",
        )
    };
    let (handoff_open, handoff_close) = if let Some(token) = focus_token.filter(|_| is_success) {
        (
            format!(
                "<form class=\"handoff-form\" method=\"get\" action=\"{AUTH_FOCUS_PATH}\"><input type=\"hidden\" name=\"token\" value=\"{}\"><button class=\"handoff\" type=\"submit\" aria-label=\"Return to Ardor Desktop\">",
                escape_html(token)
            ),
            "</button></form>",
        )
    } else {
        (
            "<div class=\"handoff\" aria-disabled=\"true\">".to_string(),
            "</div>",
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
        color: inherit;
        font: inherit;
        text-align: left;
        text-decoration: none;
        width: 100%;
      }

      .handoff-form { margin: 0; }

      button.handoff {
        appearance: none;
        cursor: pointer;
        transition: border-color 160ms ease, background-color 160ms ease, transform 160ms ease;
      }

      button.handoff:hover {
        border-color: color-mix(in srgb, var(--orange) 42%, var(--line));
        background: color-mix(in srgb, var(--card-strong) 88%, var(--orange));
        transform: translateY(-1px);
      }

      button.handoff:focus-visible {
        outline: 2px solid var(--orange);
        outline-offset: 3px;
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
        button.handoff { transition: none; }
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

        %%HANDOFF_OPEN%%
          <div class="handoff-mark" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 7h6M9 11h6M9 15h3"/></svg>
          </div>
          <div>
            <strong>Return to Ardor</strong>
            <span>%%ACTION_DETAIL%%</span>
          </div>
          <svg class="handoff-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>
        %%HANDOFF_CLOSE%%

        <p class="close-note">%%CLOSE_NOTE%%</p>
      </section>

      <p class="local-note">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>
        Handled locally by Ardor Desktop
      </p>
    </main>
  </body>
</html>"##;

    TEMPLATE
        .replace("%%DOCUMENT_TITLE%%", document_title)
        .replace("%%STATE%%", state)
        .replace("%%EYEBROW%%", eyebrow)
        .replace("%%TITLE%%", title)
        .replace("%%HANDOFF_OPEN%%", &handoff_open)
        .replace("%%HANDOFF_CLOSE%%", handoff_close)
        .replace("%%ACTION_DETAIL%%", action_detail)
        .replace("%%CLOSE_NOTE%%", close_note)
        .replace("%%MESSAGE%%", &escape_html(message))
}

fn write_response(
    stream: &mut TcpStream,
    status: u16,
    reason: &str,
    message: &str,
    focus_token: Option<&str>,
) -> std::io::Result<()> {
    let body = render_auth_callback_page(status, message, focus_token);

    write!(
        stream,
        "HTTP/1.1 {status} {reason}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store, max-age=0\r\nPragma: no-cache\r\nContent-Security-Policy: default-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'none'\r\nReferrer-Policy: no-referrer\r\nX-Content-Type-Options: nosniff\r\nX-Frame-Options: DENY\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
}

fn write_empty_response(stream: &mut TcpStream, status: u16, reason: &str) -> std::io::Result<()> {
    write!(
        stream,
        "HTTP/1.1 {status} {reason}\r\nContent-Length: 0\r\nCache-Control: no-store, max-age=0\r\nPragma: no-cache\r\nReferrer-Policy: no-referrer\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n\r\n"
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
            complete_auth_callback,
            get_auth_callback_status,
            get_pending_auth_callback,
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
        auth_state_from_query, auth_state_from_url, begin_auth_callback_attempt, escape_html,
        generate_auth_focus_token, hand_off_auth_callback, handle_auth_callback_with,
        is_allowed_return_origin, open_auth_url_with, prepare_auth_callback_attempt,
        read_auth_callback_request_path, render_auth_callback_page, validate_update_metadata,
        AuthCallbackAttempt, AuthCallbackHandoff, DesktopUpdateCheckOutcome, DesktopUpdateEvent,
        UpdateAnnouncement, AUTH_CALLBACK_ATTEMPT_TTL, AUTH_FOCUS_MAX_USES,
    };
    use serde_json::json;
    use std::{
        cell::Cell,
        io::{Read, Write},
        net::{Shutdown, TcpListener, TcpStream},
        sync::Mutex,
        thread,
        time::{Duration, Instant},
    };

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

    fn run_loopback_request<D, F>(
        request: &'static str,
        attempt: &Mutex<AuthCallbackAttempt>,
        now: Instant,
        dispatch: F,
        focus: D,
    ) -> String
    where
        D: FnOnce() -> Result<(), String>,
        F: FnOnce() -> Result<(), String>,
    {
        let listener = TcpListener::bind("127.0.0.1:0").expect("test listener should bind");
        let address = listener
            .local_addr()
            .expect("test listener should have an address");
        let client = thread::spawn(move || {
            let mut stream = TcpStream::connect(address).expect("test client should connect");
            stream
                .write_all(request.as_bytes())
                .expect("test request should write");
            stream
                .shutdown(Shutdown::Write)
                .expect("test request should finish");
            let mut response = String::new();
            stream
                .read_to_string(&mut response)
                .expect("test response should read");
            response
        });
        let (stream, _) = listener.accept().expect("test server should accept");
        handle_auth_callback_with(stream, attempt, now, dispatch, focus);
        client.join().expect("test client should finish")
    }

    #[test]
    fn loopback_callback_dispatches_once_and_duplicate_is_idempotent() {
        const REQUEST: &str =
            "GET /auth/callback?code=code-1&state=state-1 HTTP/1.1\r\nHost: 127.0.0.1:17631\r\n\r\n";
        let attempt = Mutex::new(AuthCallbackAttempt::default());
        let now = Instant::now();
        begin_auth_callback_attempt(&attempt, "state-1".to_string(), now);
        let dispatches = Cell::new(0);

        let first = run_loopback_request(
            REQUEST,
            &attempt,
            now,
            || {
                dispatches.set(dispatches.get() + 1);
                Ok(())
            },
            || Ok(()),
        );
        let duplicate = run_loopback_request(
            REQUEST,
            &attempt,
            now,
            || {
                dispatches.set(dispatches.get() + 1);
                Ok(())
            },
            || Ok(()),
        );

        assert!(first.starts_with("HTTP/1.1 200 OK\r\n"));
        assert!(first.contains("Sign-in is continuing in Ardor Desktop."));
        assert!(duplicate.starts_with("HTTP/1.1 200 OK\r\n"));
        assert!(duplicate.contains("Ardor Desktop already received this sign-in."));
        assert_eq!(dispatches.get(), 1);
        assert_eq!(
            attempt
                .lock()
                .expect("attempt should lock")
                .pending
                .as_ref()
                .map(|pending| pending.callback_url.as_str()),
            Some("http://127.0.0.1:17631/auth/callback?code=code-1&state=state-1")
        );
    }

    #[test]
    fn return_to_app_request_focuses_after_callback_completion() {
        const CALLBACK_REQUEST: &str =
            "GET /auth/callback?code=code-1&state=state-1 HTTP/1.1\r\nHost: 127.0.0.1:17631\r\n\r\n";
        const FOCUS_REQUEST: &str =
            "GET /auth/focus?token=focus-state-1 HTTP/1.1\r\nHost: 127.0.0.1:17631\r\n\r\n";
        let attempt = Mutex::new(AuthCallbackAttempt::default());
        let started_at = Instant::now();
        let callback_at = started_at + AUTH_CALLBACK_ATTEMPT_TTL - Duration::from_millis(1);
        begin_auth_callback_attempt(&attempt, "state-1".to_string(), started_at);

        let callback_response = run_loopback_request(
            CALLBACK_REQUEST,
            &attempt,
            callback_at,
            || Ok(()),
            || Ok(()),
        );
        let callback_id = attempt
            .lock()
            .expect("attempt should lock")
            .pending
            .as_ref()
            .expect("callback should be pending")
            .id;
        assert!(attempt
            .lock()
            .expect("attempt should lock")
            .complete_callback(callback_id));

        let focuses = Cell::new(0);
        let focus_response = run_loopback_request(
            FOCUS_REQUEST,
            &attempt,
            started_at + AUTH_CALLBACK_ATTEMPT_TTL + Duration::from_millis(1),
            || Ok(()),
            || {
                focuses.set(focuses.get() + 1);
                Ok(())
            },
        );

        assert!(callback_response.contains("method=\"get\" action=\"/auth/focus\""));
        assert!(callback_response.contains("name=\"token\" value=\"focus-state-1\""));
        assert!(callback_response.contains(
            "Content-Security-Policy: default-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
        ));
        assert!(callback_response.contains("Cache-Control: no-store, max-age=0\r\n"));
        assert!(callback_response.contains("Referrer-Policy: no-referrer\r\n"));
        assert!(focus_response.starts_with("HTTP/1.1 204 No Content\r\n"));
        assert!(focus_response.contains("Content-Length: 0\r\n"));
        assert!(focus_response.ends_with("\r\n\r\n"));
        assert_eq!(focuses.get(), 1);
    }

    #[test]
    fn expired_auth_attempt_does_not_clear_a_newer_focus_grant() {
        const CALLBACK_REQUEST: &str =
            "GET /auth/callback?code=code-1&state=state-1 HTTP/1.1\r\nHost: 127.0.0.1:17631\r\n\r\n";
        const FOCUS_REQUEST: &str =
            "GET /auth/focus?token=focus-state-1 HTTP/1.1\r\nHost: 127.0.0.1:17631\r\n\r\n";
        let attempt = Mutex::new(AuthCallbackAttempt::default());
        let started_at = Instant::now();
        let callback_at = started_at + AUTH_CALLBACK_ATTEMPT_TTL - Duration::from_millis(1);
        begin_auth_callback_attempt(&attempt, "state-1".to_string(), started_at);
        run_loopback_request(
            CALLBACK_REQUEST,
            &attempt,
            callback_at,
            || Ok(()),
            || Ok(()),
        );

        let duplicate_response = run_loopback_request(
            CALLBACK_REQUEST,
            &attempt,
            started_at + AUTH_CALLBACK_ATTEMPT_TTL,
            || Ok(()),
            || Ok(()),
        );
        let focuses = Cell::new(0);
        let focus_response = run_loopback_request(
            FOCUS_REQUEST,
            &attempt,
            started_at + AUTH_CALLBACK_ATTEMPT_TTL + Duration::from_millis(1),
            || Ok(()),
            || {
                focuses.set(focuses.get() + 1);
                Ok(())
            },
        );

        assert!(duplicate_response.starts_with("HTTP/1.1 400 Bad Request\r\n"));
        assert!(focus_response.starts_with("HTTP/1.1 204 No Content\r\n"));
        assert_eq!(focuses.get(), 1);
    }

    #[test]
    fn return_to_app_tokens_are_independent_url_safe_nonces() {
        let first = generate_auth_focus_token().expect("first focus token should generate");
        let second = generate_auth_focus_token().expect("second focus token should generate");

        assert_ne!(first, second);
        assert_eq!(first.len(), 43);
        assert!(first
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_')));
    }

    #[test]
    fn return_to_app_request_rejects_wrong_or_expired_tokens() {
        const CALLBACK_REQUEST: &str =
            "GET /auth/callback?code=code-1&state=state-1 HTTP/1.1\r\nHost: 127.0.0.1:17631\r\n\r\n";
        const WRONG_FOCUS_REQUEST: &str =
            "GET /auth/focus?token=wrong-state HTTP/1.1\r\nHost: 127.0.0.1:17631\r\n\r\n";
        const VALID_FOCUS_REQUEST: &str =
            "GET /auth/focus?token=focus-state-1 HTTP/1.1\r\nHost: 127.0.0.1:17631\r\n\r\n";
        let attempt = Mutex::new(AuthCallbackAttempt::default());
        let now = Instant::now();
        begin_auth_callback_attempt(&attempt, "state-1".to_string(), now);
        run_loopback_request(CALLBACK_REQUEST, &attempt, now, || Ok(()), || Ok(()));
        let focuses = Cell::new(0);

        let wrong_response = run_loopback_request(
            WRONG_FOCUS_REQUEST,
            &attempt,
            now,
            || Ok(()),
            || {
                focuses.set(focuses.get() + 1);
                Ok(())
            },
        );
        let expired_response = run_loopback_request(
            VALID_FOCUS_REQUEST,
            &attempt,
            now + AUTH_CALLBACK_ATTEMPT_TTL,
            || Ok(()),
            || {
                focuses.set(focuses.get() + 1);
                Ok(())
            },
        );

        assert!(wrong_response.starts_with("HTTP/1.1 404 Not Found\r\n"));
        assert!(expired_response.starts_with("HTTP/1.1 404 Not Found\r\n"));
        assert_eq!(focuses.get(), 0);
    }

    #[test]
    fn return_to_app_grant_is_rotated_and_limited_to_three_uses() {
        const FIRST_CALLBACK: &str =
            "GET /auth/callback?code=code-1&state=state-1 HTTP/1.1\r\nHost: 127.0.0.1:17631\r\n\r\n";
        const SECOND_CALLBACK: &str =
            "GET /auth/callback?code=code-2&state=state-2 HTTP/1.1\r\nHost: 127.0.0.1:17631\r\n\r\n";
        const FIRST_FOCUS: &str =
            "GET /auth/focus?token=focus-state-1 HTTP/1.1\r\nHost: 127.0.0.1:17631\r\n\r\n";
        const SECOND_FOCUS: &str =
            "GET /auth/focus?token=focus-state-2 HTTP/1.1\r\nHost: 127.0.0.1:17631\r\n\r\n";
        let attempt = Mutex::new(AuthCallbackAttempt::default());
        let now = Instant::now();
        begin_auth_callback_attempt(&attempt, "state-1".to_string(), now);
        run_loopback_request(FIRST_CALLBACK, &attempt, now, || Ok(()), || Ok(()));
        let callback_id = attempt
            .lock()
            .expect("attempt should lock")
            .pending
            .as_ref()
            .expect("callback should be pending")
            .id;
        assert!(attempt
            .lock()
            .expect("attempt should lock")
            .complete_callback(callback_id));

        begin_auth_callback_attempt(&attempt, "state-2".to_string(), now);
        run_loopback_request(SECOND_CALLBACK, &attempt, now, || Ok(()), || Ok(()));
        let focuses = Cell::new(0);
        let stale_response = run_loopback_request(
            FIRST_FOCUS,
            &attempt,
            now,
            || Ok(()),
            || {
                focuses.set(focuses.get() + 1);
                Ok(())
            },
        );
        assert!(stale_response.starts_with("HTTP/1.1 404 Not Found\r\n"));

        for _ in 0..AUTH_FOCUS_MAX_USES {
            let response = run_loopback_request(
                SECOND_FOCUS,
                &attempt,
                now,
                || Ok(()),
                || {
                    focuses.set(focuses.get() + 1);
                    Ok(())
                },
            );
            assert!(response.starts_with("HTTP/1.1 204 No Content\r\n"));
        }
        let exhausted_response = run_loopback_request(
            SECOND_FOCUS,
            &attempt,
            now,
            || Ok(()),
            || {
                focuses.set(focuses.get() + 1);
                Ok(())
            },
        );

        assert!(exhausted_response.starts_with("HTTP/1.1 404 Not Found\r\n"));
        assert_eq!(focuses.get(), usize::from(AUTH_FOCUS_MAX_USES));
    }

    #[test]
    fn return_to_app_request_rejects_malformed_query_or_host() {
        const CALLBACK_REQUEST: &str =
            "GET /auth/callback?code=code-1&state=state-1 HTTP/1.1\r\nHost: 127.0.0.1:17631\r\n\r\n";
        const MISSING_TOKEN: &str = "GET /auth/focus HTTP/1.1\r\nHost: 127.0.0.1:17631\r\n\r\n";
        const DUPLICATE_TOKEN: &str =
            "GET /auth/focus?token=focus-state-1&token=focus-state-1 HTTP/1.1\r\nHost: 127.0.0.1:17631\r\n\r\n";
        const WRONG_HOST: &str =
            "GET /auth/focus?token=focus-state-1 HTTP/1.1\r\nHost: localhost:17631\r\n\r\n";
        let attempt = Mutex::new(AuthCallbackAttempt::default());
        let now = Instant::now();
        begin_auth_callback_attempt(&attempt, "state-1".to_string(), now);
        run_loopback_request(CALLBACK_REQUEST, &attempt, now, || Ok(()), || Ok(()));
        let focuses = Cell::new(0);

        for request in [MISSING_TOKEN, DUPLICATE_TOKEN, WRONG_HOST] {
            let response = run_loopback_request(
                request,
                &attempt,
                now,
                || Ok(()),
                || {
                    focuses.set(focuses.get() + 1);
                    Ok(())
                },
            );
            assert!(!response.starts_with("HTTP/1.1 204 No Content\r\n"));
        }
        assert_eq!(focuses.get(), 0);
    }

    #[test]
    fn return_to_app_request_reports_native_focus_failure() {
        const CALLBACK_REQUEST: &str =
            "GET /auth/callback?code=code-1&state=state-1 HTTP/1.1\r\nHost: 127.0.0.1:17631\r\n\r\n";
        const FOCUS_REQUEST: &str =
            "GET /auth/focus?token=focus-state-1 HTTP/1.1\r\nHost: 127.0.0.1:17631\r\n\r\n";
        let attempt = Mutex::new(AuthCallbackAttempt::default());
        let now = Instant::now();
        begin_auth_callback_attempt(&attempt, "state-1".to_string(), now);
        run_loopback_request(CALLBACK_REQUEST, &attempt, now, || Ok(()), || Ok(()));

        let response = run_loopback_request(
            FOCUS_REQUEST,
            &attempt,
            now,
            || Ok(()),
            || Err("window manager rejected focus".to_string()),
        );

        assert!(response.starts_with("HTTP/1.1 500 Internal Server Error\r\n"));
        assert!(response.contains("Select it from the taskbar."));
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
        assert_eq!(
            auth_state_from_query("error=access_denied&state=state%2Fone").as_deref(),
            Some("state/one")
        );
        assert_eq!(auth_state_from_query("state=state%2Fone"), None);
    }

    #[test]
    fn auth_callback_query_rejects_ambiguous_or_duplicate_parameters() {
        for query in [
            "code=code-1&error=access_denied&state=state-1",
            "code=code-1&state=state-1&state=state-1",
            "code=code-1&code=code-2&state=state-1",
            "error=access_denied&error=server_error&state=state-1",
            "code=code-1&error=&state=state-1",
            "code=&error=access_denied&state=state-1",
            "code=&state=state-1",
            "error=&state=state-1",
            "code=code-1&state=",
        ] {
            assert_eq!(auth_state_from_query(query), None, "accepted {query}");
        }
    }

    #[test]
    fn auth_authorize_url_rejects_duplicate_state_before_launch() {
        let attempt = Mutex::new(AuthCallbackAttempt::default());
        let launches = Cell::new(0);

        let error = open_auth_url_with(
            "https://auth-dev.ardor.cloud/authorize?state=first&state=second",
            &attempt,
            Instant::now(),
            |_| {
                launches.set(launches.get() + 1);
                Ok(())
            },
        )
        .expect_err("duplicate state must be rejected");

        assert_eq!(
            error,
            "Auth0 authorization URL is missing a non-empty state"
        );
        assert_eq!(launches.get(), 0);
    }

    #[test]
    fn auth_url_requires_the_expected_https_authorize_endpoint() {
        for url in [
            "http://auth-dev.ardor.cloud/authorize?state=state-1",
            "https://auth-dev.ardor.cloud:444/authorize?state=state-1",
            "https://user@auth-dev.ardor.cloud/authorize?state=state-1",
            "https://auth-dev.ardor.cloud/oauth/authorize?state=state-1",
        ] {
            let attempt = Mutex::new(AuthCallbackAttempt::default());
            let launches = Cell::new(0);
            let error = open_auth_url_with(url, &attempt, Instant::now(), |_| {
                launches.set(launches.get() + 1);
                Ok(())
            })
            .expect_err("unexpected authorization endpoint must be rejected");

            assert_eq!(error, "refusing to open non-Auth0 authorization URL");
            assert_eq!(launches.get(), 0);
        }
    }

    #[test]
    fn auth_callback_return_origin_is_restricted_to_the_application() {
        for allowed in [
            "tauri://localhost/?code=code-1&state=state-1",
            "http://tauri.localhost/?code=code-1&state=state-1",
        ] {
            assert!(is_allowed_return_origin(
                &tauri::Url::parse(allowed).expect("valid allowed URL")
            ));
        }

        for rejected in [
            "https://evil.example/?code=code-1&state=state-1",
            "tauri://evil.example/?code=code-1&state=state-1",
            "http://tauri.localhost.evil.example/?code=code-1&state=state-1",
        ] {
            assert!(!is_allowed_return_origin(
                &tauri::Url::parse(rejected).expect("valid rejected URL")
            ));
        }
    }

    #[test]
    fn callback_request_reader_accepts_split_headers_and_times_out_when_idle() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("test listener should bind");
        let address = listener
            .local_addr()
            .expect("test listener should have an address");
        let client = thread::spawn(move || {
            let mut stream = TcpStream::connect(address).expect("test client should connect");
            stream
                .write_all(b"GET /auth/callback?code=code-1")
                .expect("first request fragment should write");
            stream
                .write_all(b"&state=state-1 HTTP/1.1\r\nHost: 127.0.0.1:17631\r\n\r\n")
                .expect("second request fragment should write");
        });
        let (mut stream, _) = listener.accept().expect("test server should accept");
        stream
            .set_read_timeout(Some(Duration::from_millis(100)))
            .expect("test timeout should configure");

        assert_eq!(
            read_auth_callback_request_path(&mut stream).as_deref(),
            Ok("/auth/callback?code=code-1&state=state-1")
        );
        client.join().expect("test client should finish");

        let idle_listener = TcpListener::bind("127.0.0.1:0").expect("idle listener should bind");
        let idle_address = idle_listener
            .local_addr()
            .expect("idle listener should have an address");
        let idle_client = TcpStream::connect(idle_address).expect("idle client should connect");
        let (mut idle_stream, _) = idle_listener.accept().expect("idle server should accept");
        idle_stream
            .set_read_timeout(Some(Duration::from_millis(25)))
            .expect("idle timeout should configure");

        let error = read_auth_callback_request_path(&mut idle_stream)
            .expect_err("idle callback connection must time out");
        assert!(error.contains("failed to read callback request"));
        drop(idle_client);
    }

    #[test]
    fn auth_url_without_state_fails_closed_before_launch() {
        let attempt = Mutex::new(AuthCallbackAttempt::default());
        let launches = Cell::new(0);
        let now = Instant::now();

        let error = open_auth_url_with(
            "https://auth-dev.ardor.cloud/authorize?client_id=test",
            &attempt,
            now,
            |_| {
                launches.set(launches.get() + 1);
                Ok(())
            },
        )
        .expect_err("authorization URL without state must be rejected");
        let callback = hand_off_auth_callback(
            &attempt,
            Some("untracked-state"),
            "http://127.0.0.1/callback?code=code-1&state=untracked-state".to_string(),
            now,
        );

        assert_eq!(
            error,
            "Auth0 authorization URL is missing a non-empty state"
        );
        assert_eq!(launches.get(), 0);
        assert_eq!(callback, AuthCallbackHandoff::Unexpected);
    }

    #[test]
    fn failed_auth_url_launch_clears_the_prepared_attempt() {
        let attempt = Mutex::new(AuthCallbackAttempt::default());
        let now = Instant::now();

        let error = open_auth_url_with(
            "https://auth-dev.ardor.cloud/authorize?client_id=test&state=state-1",
            &attempt,
            now,
            |_| Err("browser launch failed".to_string()),
        )
        .expect_err("failed browser launch should be returned");
        let callback = hand_off_auth_callback(
            &attempt,
            Some("state-1"),
            "http://127.0.0.1/callback?code=code-1&state=state-1".to_string(),
            now,
        );

        assert_eq!(error, "browser launch failed");
        assert_eq!(callback, AuthCallbackHandoff::Unexpected);
    }

    #[test]
    fn pending_callback_is_retained_until_explicit_completion() {
        let attempt = Mutex::new(AuthCallbackAttempt::default());
        let now = Instant::now();
        begin_auth_callback_attempt(&attempt, "state-1".to_string(), now);
        let callback_url = "http://127.0.0.1/callback?code=code-1&state=state-1";

        let first =
            hand_off_auth_callback(&attempt, Some("state-1"), callback_url.to_string(), now);
        let duplicate =
            hand_off_auth_callback(&attempt, Some("state-1"), callback_url.to_string(), now);
        let pending = attempt
            .lock()
            .expect("attempt should lock")
            .pending
            .clone()
            .expect("callback should remain pending");

        assert_eq!(first, AuthCallbackHandoff::Queued);
        assert_eq!(duplicate, AuthCallbackHandoff::Duplicate);
        assert_eq!(pending.callback_url, callback_url);
        assert!(attempt
            .lock()
            .expect("attempt should lock")
            .complete_callback(pending.id));
        assert!(attempt
            .lock()
            .expect("attempt should lock")
            .pending
            .is_none());
    }

    #[test]
    fn new_auth_attempt_cannot_replace_a_pending_callback() {
        let attempt = Mutex::new(AuthCallbackAttempt::default());
        let now = Instant::now();
        begin_auth_callback_attempt(&attempt, "state-1".to_string(), now);
        assert_eq!(
            hand_off_auth_callback(
                &attempt,
                Some("state-1"),
                "http://127.0.0.1/callback?code=code-1&state=state-1".to_string(),
                now,
            ),
            AuthCallbackHandoff::Queued
        );

        let error = prepare_auth_callback_attempt(&attempt, "state-2".to_string(), now)
            .expect_err("pending callback must not be replaced");
        assert_eq!(error, "a desktop authentication callback is still pending");
    }

    #[test]
    fn expired_pending_callback_is_cleared_before_a_new_attempt() {
        let attempt = Mutex::new(AuthCallbackAttempt::default());
        let started_at = Instant::now();
        begin_auth_callback_attempt(&attempt, "state-1".to_string(), started_at);
        assert_eq!(
            hand_off_auth_callback(
                &attempt,
                Some("state-1"),
                "http://127.0.0.1/callback?code=code-1&state=state-1".to_string(),
                started_at,
            ),
            AuthCallbackHandoff::Queued
        );

        let after_expiry = started_at + AUTH_CALLBACK_ATTEMPT_TTL + Duration::from_millis(1);
        prepare_auth_callback_attempt(&attempt, "state-2".to_string(), after_expiry)
            .expect("expired pending callback must not block a new attempt");

        let attempt = attempt.lock().expect("attempt should lock");
        assert!(attempt.pending.is_none());
        assert_eq!(attempt.expected_state.as_deref(), Some("state-2"));
    }

    #[test]
    fn wrong_state_is_rejected_without_consuming_the_expected_attempt() {
        let attempt = Mutex::new(AuthCallbackAttempt::default());
        let now = Instant::now();
        begin_auth_callback_attempt(&attempt, "expected-state".to_string(), now);

        assert_eq!(
            hand_off_auth_callback(
                &attempt,
                Some("wrong-state"),
                "http://127.0.0.1/callback?code=code-1&state=wrong-state".to_string(),
                now,
            ),
            AuthCallbackHandoff::Unexpected
        );
        assert_eq!(
            hand_off_auth_callback(
                &attempt,
                Some("expected-state"),
                "http://127.0.0.1/callback?code=code-1&state=expected-state".to_string(),
                now,
            ),
            AuthCallbackHandoff::Queued
        );
    }

    #[test]
    fn failed_wakeup_does_not_discard_the_pending_callback() {
        const REQUEST: &str =
            "GET /auth/callback?code=code-1&state=state-1 HTTP/1.1\r\nHost: 127.0.0.1:17631\r\n\r\n";
        let attempt = Mutex::new(AuthCallbackAttempt::default());
        let now = Instant::now();
        begin_auth_callback_attempt(&attempt, "state-1".to_string(), now);

        let response = run_loopback_request(
            REQUEST,
            &attempt,
            now,
            || Err("event delivery failed".to_string()),
            || Ok(()),
        );

        assert!(response.starts_with("HTTP/1.1 200 OK\r\n"));
        assert!(attempt
            .lock()
            .expect("attempt should lock")
            .pending
            .is_some());
    }

    #[test]
    fn callback_without_an_in_process_attempt_is_rejected() {
        let attempt = Mutex::new(AuthCallbackAttempt::default());
        let outcome = hand_off_auth_callback(
            &attempt,
            Some("restart-state"),
            "http://127.0.0.1/callback?code=code-1&state=restart-state".to_string(),
            Instant::now(),
        );

        assert_eq!(outcome, AuthCallbackHandoff::Unexpected);
    }

    #[test]
    fn expired_auth_attempt_is_cleared_and_requires_a_new_sign_in() {
        let attempt = Mutex::new(AuthCallbackAttempt::default());
        let started_at = Instant::now();
        begin_auth_callback_attempt(&attempt, "state-1".to_string(), started_at);
        let expired_at =
            started_at + AUTH_CALLBACK_ATTEMPT_TTL + std::time::Duration::from_millis(1);

        assert_eq!(
            hand_off_auth_callback(
                &attempt,
                Some("state-1"),
                "http://127.0.0.1/callback?code=code-1&state=state-1".to_string(),
                expired_at,
            ),
            AuthCallbackHandoff::Expired
        );
        assert_eq!(
            hand_off_auth_callback(
                &attempt,
                Some("state-1"),
                "http://127.0.0.1/callback?code=code-1&state=state-1".to_string(),
                expired_at,
            ),
            AuthCallbackHandoff::Unexpected
        );

        begin_auth_callback_attempt(&attempt, "state-2".to_string(), expired_at);
        assert_eq!(
            hand_off_auth_callback(
                &attempt,
                Some("state-2"),
                "http://127.0.0.1/callback?code=code-2&state=state-2".to_string(),
                expired_at,
            ),
            AuthCallbackHandoff::Queued
        );
    }

    #[test]
    fn auth_callback_page_does_not_claim_authentication_is_complete() {
        let page = render_auth_callback_page(
            200,
            "Sign-in is continuing in Ardor Desktop.",
            Some("state/one+two"),
        );

        assert!(page.contains("data-state=\"success\""));
        assert!(page.contains("Sign-in continuing"));
        assert!(page.contains("Ardor Desktop is still finishing authentication."));
        assert!(page.contains("Sign-in is continuing in Ardor Desktop."));
        assert!(page.contains("ARDOR"));
        assert!(page.contains("Handled locally by Ardor Desktop"));
        assert!(page.contains("method=\"get\" action=\"/auth/focus\""));
        assert!(page.contains("name=\"token\" value=\"state/one+two\""));
        assert!(page.contains("type=\"submit\""));
        assert!(page.contains("aria-label=\"Return to Ardor Desktop\""));
        assert!(!page.contains("Authentication complete"));
        assert!(!page.contains("<script>"));
        assert!(!page.contains("window.close()"));
    }

    #[test]
    fn auth_callback_page_renders_safe_error_state() {
        let page = render_auth_callback_page(500, "Try <again> & don't panic.", None);

        assert!(page.contains("data-state=\"error\""));
        assert!(page.contains("We couldn't complete sign-in"));
        assert!(page.contains("Try &lt;again&gt; &amp; don&#39;t panic."));
        assert!(page.contains("aria-disabled=\"true\""));
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
