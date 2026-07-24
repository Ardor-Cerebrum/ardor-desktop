use std::{
    collections::{HashMap, VecDeque},
    ffi::OsStr,
    fs,
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    path::PathBuf,
    process::Command,
    sync::{Mutex, OnceLock},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use base64::{
    engine::general_purpose::{STANDARD as BASE64, URL_SAFE_NO_PAD},
    Engine as _,
};
use minisign_verify::{PublicKey, Signature};
use tauri::{ipc::Channel, Emitter, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

mod runtime;
mod sidebar_browser;
#[cfg(all(
    target_os = "macos",
    target_arch = "aarch64",
    any(test, feature = "metal-integration-tests")
))]
pub use sidebar_browser::gpu_compositor::test_support;
#[cfg(windows)]
mod windows_crash_diagnostics;

use runtime::{DesktopAppHandle, DesktopRuntime, DesktopWebview, DesktopWindow};
use sidebar_browser::{
    close_sidebar_browser, control_sidebar_browser, describe_navigation, input_sidebar_browser,
    is_allowed_sidebar_navigation, is_privileged_shell_label, is_sidebar_browser_label,
    layout_sidebar_browser, open_sidebar_browser, SidebarBrowserState,
};

const AUTH_CALLBACK_ADDR: &str = "127.0.0.1:17631";
const AUTH_CALLBACK_PATH: &str = "/auth/callback";
const AUTH_FOCUS_PATH: &str = "/auth/focus";
const LOOPBACK_CALLBACK_URL: &str = "http://127.0.0.1:17631/auth/callback";
const PROD_BUNDLE_ID: &str = "cloud.ardor.desktop";
const STAGE1_BUNDLE_ID: &str = "cloud.ardor.desktop.stage1";
const BROWSER_DEVTOOLS_OPT_IN_ENV: &str = "ARDOR_ENABLE_BROWSER_DEVTOOLS";
const CEF_DEVTOOLS_ENABLED_ENV: &str = "ARDOR_CEF_DEVTOOLS_ENABLED";
const UPDATE_METADATA_SCHEMA: u32 = 1;
const UPDATE_CHECK_TIMEOUT: Duration = Duration::from_secs(30);
const UPDATE_DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(15 * 60);
const AUTH_CALLBACK_ATTEMPT_TTL: Duration = Duration::from_secs(10 * 60);
const AUTH_CALLBACK_IO_TIMEOUT: Duration = Duration::from_secs(5);
const AUTH_CALLBACK_MAX_REQUEST_BYTES: usize = 8 * 1024;
const AUTH_STATE_MAX_LENGTH: usize = 2 * 1024;
const AUTH_CALLBACK_READY_EVENT: &str = "desktop-auth-callback-ready";
const AUTH_CALLBACK_PROTOCOL_VERSION: u32 = 1;
const AUTH_CALLBACK_DIAGNOSTIC_HISTORY_LIMIT: usize = 64;
const AUTH_CALLBACK_DIAGNOSTIC_LOG_MAX_BYTES: u64 = 256 * 1024;
const AUTH_CALLBACK_DIAGNOSTIC_LOG_PREFIX: &str = "auth-callback-phases-";
const AUTH_CALLBACK_DIAGNOSTIC_SESSION_FILE_LIMIT: usize = 8;
const AUTH_FOCUS_TOKEN_BYTES: usize = 32;
const AUTH_FOCUS_MAX_USES: u8 = 3;

fn is_truthy_env_flag(value: Option<&OsStr>) -> bool {
    value
        .map(|value| value.to_string_lossy())
        .is_some_and(|value| {
            matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        })
}

fn browser_devtools_allowed_for(bundle_id: &str, explicit_opt_in: bool, debug_build: bool) -> bool {
    debug_build || bundle_id == STAGE1_BUNDLE_ID || explicit_opt_in
}

fn configure_browser_devtools(bundle_id: &str) {
    let explicit_opt_in =
        is_truthy_env_flag(std::env::var_os(BROWSER_DEVTOOLS_OPT_IN_ENV).as_deref());
    if browser_devtools_allowed_for(bundle_id, explicit_opt_in, cfg!(debug_assertions)) {
        std::env::set_var(CEF_DEVTOOLS_ENABLED_ENV, "1");
    } else {
        std::env::remove_var(CEF_DEVTOOLS_ENABLED_ENV);
    }
}

#[cfg(all(
    feature = "metal-integration-tests",
    target_os = "macos",
    target_arch = "aarch64"
))]
fn metal_lifecycle_test_iterations() -> Option<u32> {
    std::env::var("ARDOR_TEST_METAL_CEF_LIFECYCLE_ITERATIONS")
        .ok()?
        .parse()
        .ok()
        .filter(|iterations| *iterations > 0)
}

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
    pending_consumed: bool,
    pending_queued_at: Option<Instant>,
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

#[derive(Clone, Copy, Debug, PartialEq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "snake_case")]
enum AuthCallbackDiagnosticPhase {
    Queued,
    Consumed,
    Acknowledged,
    Expired,
}

#[derive(Clone, Debug, PartialEq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct AuthCallbackDiagnosticEntry {
    timestamp_unix_seconds: u64,
    session_id: String,
    sequence: u64,
    protocol_version: u32,
    callback_id: u64,
    phase: AuthCallbackDiagnosticPhase,
    elapsed_ms: u64,
}

#[derive(Default)]
struct AuthCallbackDiagnosticLog {
    path: Option<PathBuf>,
    entries: VecDeque<AuthCallbackDiagnosticEntry>,
    next_sequence: u64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct AuthCallbackTransition {
    callback_id: u64,
    phase: AuthCallbackDiagnosticPhase,
    elapsed_ms: u64,
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
    Queued(u64),
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
        self.pending_consumed = false;
        self.pending_queued_at = None;
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
            if let Some(transition) = self.expire(now) {
                record_auth_callback_transition(transition);
            }
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
            self.pending_consumed = false;
            self.pending_queued_at = Some(now);
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

    fn complete_callback(
        &mut self,
        callback_id: u64,
        now: Instant,
    ) -> Option<AuthCallbackTransition> {
        if self.pending.as_ref().map(|pending| pending.id) != Some(callback_id) {
            return None;
        }
        let elapsed_ms = self.pending_elapsed_ms(now);
        self.clear_active_callback();
        Some(AuthCallbackTransition {
            callback_id,
            phase: AuthCallbackDiagnosticPhase::Acknowledged,
            elapsed_ms,
        })
    }

    fn expire(&mut self, now: Instant) -> Option<AuthCallbackTransition> {
        if self
            .focus_grant
            .as_ref()
            .is_some_and(|grant| now >= grant.expires_at || grant.remaining_uses == 0)
        {
            self.focus_grant = None;
        }

        if self.expires_at.is_some_and(|expires_at| now >= expires_at) {
            let transition = self.pending.as_ref().map(|pending| AuthCallbackTransition {
                callback_id: pending.id,
                phase: AuthCallbackDiagnosticPhase::Expired,
                elapsed_ms: self.pending_elapsed_ms(now),
            });
            self.clear_active_callback();
            return transition;
        }

        None
    }

    fn consume_pending(
        &mut self,
        now: Instant,
    ) -> (Option<PendingAuthCallback>, Option<AuthCallbackTransition>) {
        let pending = self.pending.clone();
        let transition = pending.as_ref().and_then(|pending| {
            if self.pending_consumed {
                return None;
            }
            self.pending_consumed = true;
            Some(AuthCallbackTransition {
                callback_id: pending.id,
                phase: AuthCallbackDiagnosticPhase::Consumed,
                elapsed_ms: self.pending_elapsed_ms(now),
            })
        });
        (pending, transition)
    }

    fn pending_elapsed_ms(&self, now: Instant) -> u64 {
        self.pending_queued_at
            .map(|queued_at| duration_millis_u64(now.saturating_duration_since(queued_at)))
            .unwrap_or_default()
    }

    fn consume_focus_token(&mut self, token: &str, now: Instant) -> bool {
        if let Some(transition) = self.expire(now) {
            record_auth_callback_transition(transition);
        }
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
        if let Some(transition) = self.expire(now) {
            record_auth_callback_transition(transition);
        }
        self.focus_grant.as_ref().map(|grant| grant.token.clone())
    }
}

static AUTH_CALLBACK_STATUS: OnceLock<Mutex<AuthCallbackStatus>> = OnceLock::new();
static AUTH_CALLBACK_ATTEMPT: OnceLock<Mutex<AuthCallbackAttempt>> = OnceLock::new();
static AUTH_CALLBACK_DIAGNOSTICS: OnceLock<Mutex<AuthCallbackDiagnosticLog>> = OnceLock::new();
static AUTH_CALLBACK_SESSION_ID: OnceLock<String> = OnceLock::new();
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

fn auth_callback_diagnostics() -> &'static Mutex<AuthCallbackDiagnosticLog> {
    AUTH_CALLBACK_DIAGNOSTICS.get_or_init(|| Mutex::new(AuthCallbackDiagnosticLog::default()))
}

fn duration_millis_u64(duration: Duration) -> u64 {
    duration.as_millis().try_into().unwrap_or(u64::MAX)
}

fn auth_callback_session_id() -> &'static str {
    AUTH_CALLBACK_SESSION_ID.get_or_init(|| {
        let mut bytes = [0_u8; 16];
        if getrandom::fill(&mut bytes).is_err() {
            bytes.copy_from_slice(
                &SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_nanos()
                    .to_le_bytes(),
            );
        }
        URL_SAFE_NO_PAD.encode(bytes)
    })
}

fn configure_auth_callback_diagnostics(path: PathBuf) {
    let mut diagnostics = auth_callback_diagnostics()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Err(error) = diagnostics.configure(path) {
        eprintln!("Failed to initialize desktop auth callback diagnostics: {error}");
    }
}

fn auth_callback_diagnostic_path(directory: &std::path::Path, session_id: &str) -> PathBuf {
    directory.join(format!(
        "{AUTH_CALLBACK_DIAGNOSTIC_LOG_PREFIX}{session_id}.jsonl"
    ))
}

fn prune_auth_callback_diagnostic_files(
    directory: &std::path::Path,
    current_path: &std::path::Path,
) -> Result<(), String> {
    let mut files = fs::read_dir(directory)
        .map_err(|error| error.to_string())?
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let file_name = entry.file_name();
            let file_name = file_name.to_str()?;
            if !file_name.starts_with(AUTH_CALLBACK_DIAGNOSTIC_LOG_PREFIX)
                || !file_name.ends_with(".jsonl")
            {
                return None;
            }
            let path = entry.path();
            let modified = entry.metadata().ok()?.modified().ok()?;
            Some((modified, path))
        })
        .collect::<Vec<_>>();
    let remove_count = files
        .len()
        .saturating_sub(AUTH_CALLBACK_DIAGNOSTIC_SESSION_FILE_LIMIT);
    files.retain(|(_, path)| path != current_path);
    files.sort_by_key(|(modified, _)| *modified);
    for (_, path) in files.into_iter().take(remove_count) {
        match fs::remove_file(path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.to_string()),
        }
    }
    Ok(())
}

fn record_auth_callback_transition(transition: AuthCallbackTransition) {
    let timestamp_unix_seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let mut diagnostics = auth_callback_diagnostics()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let sequence = diagnostics.next_sequence.max(1);
    diagnostics.next_sequence = sequence.saturating_add(1);
    diagnostics.push(AuthCallbackDiagnosticEntry {
        timestamp_unix_seconds,
        session_id: auth_callback_session_id().to_string(),
        sequence,
        protocol_version: AUTH_CALLBACK_PROTOCOL_VERSION,
        callback_id: transition.callback_id,
        phase: transition.phase,
        elapsed_ms: transition.elapsed_ms,
    });
    if let Err(error) = diagnostics.persist() {
        eprintln!("Failed to persist desktop auth callback diagnostics: {error}");
    }
}

impl AuthCallbackDiagnosticLog {
    fn configure(&mut self, path: PathBuf) -> Result<(), String> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let backup_path = diagnostic_backup_path(&path);
        if !path.exists() && backup_path.exists() {
            fs::rename(&backup_path, &path).map_err(|error| error.to_string())?;
        }

        self.entries.clear();
        self.next_sequence = 1;
        let source = match fs::metadata(&path) {
            Ok(metadata) if metadata.len() > AUTH_CALLBACK_DIAGNOSTIC_LOG_MAX_BYTES => None,
            Ok(_) => Some(fs::read_to_string(&path).map_err(|error| error.to_string())?),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => return Err(error.to_string()),
        };
        if let Some(source) = source {
            for line in source.lines() {
                if let Ok(entry) = serde_json::from_str(line) {
                    self.push(entry);
                }
            }
        }
        self.path = Some(path);
        self.persist()
    }

    fn push(&mut self, entry: AuthCallbackDiagnosticEntry) {
        self.next_sequence = self.next_sequence.max(entry.sequence.saturating_add(1));
        self.entries.push_back(entry);
        while self.entries.len() > AUTH_CALLBACK_DIAGNOSTIC_HISTORY_LIMIT {
            self.entries.pop_front();
        }
    }

    fn persist(&self) -> Result<(), String> {
        let Some(path) = self.path.as_ref() else {
            return Ok(());
        };
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let temporary_path = diagnostic_temporary_path(path);
        let mut temporary_file =
            fs::File::create(&temporary_path).map_err(|error| error.to_string())?;
        temporary_file
            .write_all(serialize_auth_callback_diagnostics(&self.entries).as_bytes())
            .and_then(|()| temporary_file.sync_all())
            .map_err(|error| error.to_string())?;
        drop(temporary_file);

        match fs::rename(&temporary_path, path) {
            Ok(()) => Ok(()),
            Err(error) if path.exists() => replace_diagnostic_file(path, &temporary_path)
                .map_err(|replace_error| format!("{error}; {replace_error}")),
            Err(error) => Err(error.to_string()),
        }
    }
}

fn diagnostic_temporary_path(path: &std::path::Path) -> PathBuf {
    path.with_extension("jsonl.tmp")
}

fn diagnostic_backup_path(path: &std::path::Path) -> PathBuf {
    path.with_extension("jsonl.bak")
}

fn replace_diagnostic_file(
    path: &std::path::Path,
    temporary_path: &std::path::Path,
) -> Result<(), String> {
    let backup_path = diagnostic_backup_path(path);
    if backup_path.exists() {
        fs::remove_file(&backup_path).map_err(|error| error.to_string())?;
    }
    fs::rename(path, &backup_path).map_err(|error| error.to_string())?;
    if let Err(error) = fs::rename(temporary_path, path) {
        let _ = fs::rename(&backup_path, path);
        return Err(error.to_string());
    }
    fs::remove_file(backup_path).map_err(|error| error.to_string())
}

fn serialize_auth_callback_diagnostics(entries: &VecDeque<AuthCallbackDiagnosticEntry>) -> String {
    let mut output = String::new();
    for entry in entries {
        let Ok(line) = serde_json::to_string(entry) else {
            continue;
        };
        output.push_str(&line);
        output.push('\n');
    }
    output
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
    consume_pending_auth_callback(
        auth_callback_attempt(),
        Instant::now(),
        record_auth_callback_transition,
    )
}

fn consume_pending_auth_callback<R>(
    attempt: &Mutex<AuthCallbackAttempt>,
    now: Instant,
    mut record: R,
) -> Option<PendingAuthCallback>
where
    R: FnMut(AuthCallbackTransition),
{
    let mut attempt = attempt
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let expired = attempt.expire(now);
    let (pending, consumed) = attempt.consume_pending(now);
    for transition in [expired, consumed].into_iter().flatten() {
        record(transition);
    }
    pending
}

#[tauri::command(rename_all = "camelCase")]
fn complete_auth_callback(callback_id: u64) -> bool {
    complete_auth_callback_with(
        auth_callback_attempt(),
        callback_id,
        Instant::now(),
        record_auth_callback_transition,
    )
}

fn complete_auth_callback_with<R>(
    attempt: &Mutex<AuthCallbackAttempt>,
    callback_id: u64,
    now: Instant,
    record: R,
) -> bool
where
    R: FnOnce(AuthCallbackTransition),
{
    let mut attempt = attempt
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let completed = attempt.complete_callback(callback_id, now);
    if let Some(transition) = completed {
        record(transition);
        true
    } else {
        false
    }
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

pub(crate) fn open_external_url(url: &str) -> Result<(), String> {
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

fn start_auth_callback_server(app: DesktopAppHandle) {
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

    thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let app = app.clone();
            thread::spawn(move || handle_auth_callback(&app, stream));
        }
    });
}

fn desktop_auth_callback_target(app: &DesktopAppHandle) -> Option<(DesktopWebview, DesktopWindow)> {
    let webviews = app.webviews();
    let webview = webviews
        .values()
        .find(|webview| webview.label() != "main" && is_privileged_shell_label(webview.label()))
        .cloned()
        .or_else(|| webviews.get("main").cloned())?;
    let window = webview.window();
    Some((webview, window))
}

fn handle_auth_callback(app: &DesktopAppHandle, stream: TcpStream) {
    handle_auth_callback_with(
        stream,
        auth_callback_attempt(),
        Instant::now(),
        || {
            let (webview, _) = desktop_auth_callback_target(app)
                .ok_or_else(|| "desktop auth callback target is unavailable".to_string())?;
            webview
                .emit(AUTH_CALLBACK_READY_EVENT, ())
                .map_err(|error| format!("failed to notify WebView about auth callback: {error}"))
        },
        || {
            let (_, window) = desktop_auth_callback_target(app)
                .ok_or_else(|| "desktop auth callback target is unavailable".to_string())?;
            focus_desktop_window(&window)
        },
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
                let _ = write_focus_response(&mut stream);
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
        AuthCallbackHandoff::Queued(_) => {
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

fn focus_desktop_window(window: &DesktopWindow) -> Result<(), String> {
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
    let expired = attempt.expire(now);
    if attempt.pending.is_some() {
        return Err("a desktop authentication callback is still pending".to_string());
    }
    if let Some(transition) = expired {
        record_auth_callback_transition(transition);
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
    hand_off_auth_callback_recording(
        attempt,
        callback_state,
        callback_url,
        now,
        record_auth_callback_transition,
    )
}

fn hand_off_auth_callback_recording<R>(
    attempt: &Mutex<AuthCallbackAttempt>,
    callback_state: Option<&str>,
    callback_url: String,
    now: Instant,
    record: R,
) -> AuthCallbackHandoff
where
    R: FnOnce(AuthCallbackTransition),
{
    let Some(callback_state) = callback_state.filter(|state| !state.is_empty()) else {
        return AuthCallbackHandoff::Unexpected;
    };
    let (claim, callback_id) = {
        let mut attempt = attempt
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let claim = attempt.queue_callback(callback_state, callback_url, now);
        let callback_id = attempt.pending.as_ref().map(|pending| pending.id);
        if claim == AuthCallbackClaim::Claimed {
            record(AuthCallbackTransition {
                callback_id: callback_id.expect("claimed callback must be pending"),
                phase: AuthCallbackDiagnosticPhase::Queued,
                elapsed_ms: 0,
            });
        }
        (claim, callback_id)
    };

    match claim {
        AuthCallbackClaim::Duplicate => AuthCallbackHandoff::Duplicate,
        AuthCallbackClaim::Unexpected => AuthCallbackHandoff::Unexpected,
        AuthCallbackClaim::Expired => AuthCallbackHandoff::Expired,
        AuthCallbackClaim::Claimed => {
            AuthCallbackHandoff::Queued(callback_id.expect("claimed callback must be pending"))
        }
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
    let (state, document_title, title) = if is_success {
        ("success", "Return to Ardor", "Sign-in received")
    } else {
        ("error", "Sign-in issue — Ardor", "Return to Ardor")
    };
    let handoff = focus_token
        .filter(|_| is_success)
        .map(|token| {
            format!(
                "<form class=\"handoff-form\" method=\"get\" action=\"{AUTH_FOCUS_PATH}\"><input type=\"hidden\" name=\"token\" value=\"{}\"><button class=\"handoff\" type=\"submit\">Return to Ardor</button></form>",
                escape_html(token)
            )
        })
        .unwrap_or_default();

    include_str!("auth_callback_page.html")
        .replace("%%DOCUMENT_TITLE%%", document_title)
        .replace("%%STATE%%", state)
        .replace("%%TITLE%%", title)
        .replace("%%MESSAGE%%", &escape_html(message))
        .replace("%%HANDOFF%%", &handoff)
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

fn write_focus_response(stream: &mut TcpStream) -> std::io::Result<()> {
    const BODY: &str = r#"<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="color-scheme" content="light dark">
    <title>Returning to Ardor</title>
    <style>
      :root { color-scheme: light dark; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      body { min-height: 100vh; margin: 0; display: grid; place-items: center; background: #fafafa; color: #18181b; text-align: center; }
      main { padding: 24px; }
      h1 { margin: 0; font-size: 24px; }
      p { margin: 10px 0 0; color: #71717a; }
      @media (prefers-color-scheme: dark) {
        body { background: #09090b; color: #fafafa; }
        p { color: #a1a1aa; }
      }
    </style>
  </head>
  <body>
    <main>
      <h1>Returning to Ardor</h1>
      <p>If this tab does not close automatically, you can close it.</p>
    </main>
    <script>setTimeout(() => window.close(), 5000)</script>
  </body>
</html>"#;

    write!(
        stream,
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store, max-age=0\r\nPragma: no-cache\r\nContent-Security-Policy: default-src 'none'; base-uri 'none'; frame-ancestors 'none'; style-src 'unsafe-inline'; script-src 'sha256-9BF3h95D4gf41+ZlhLfMEOev9mzuvZZJXQQv85BUx9k='\r\nReferrer-Policy: no-referrer\r\nX-Content-Type-Options: nosniff\r\nX-Frame-Options: DENY\r\nConnection: close\r\n\r\n{BODY}",
        BODY.len()
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

fn updater_public_key(app: &DesktopAppHandle) -> Result<String, String> {
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
    app: &DesktopAppHandle,
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
async fn check_desktop_update(app: DesktopAppHandle) -> Result<DesktopUpdateCheckOutcome, String> {
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
    app: DesktopAppHandle,
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
#[allow(clippy::assertions_on_constants)]
pub fn run() {
    const {
        assert!(
            tauri_runtime_cef::CEF_SANDBOX_ENABLED,
            "the Ardor CEF runtime must be built with sandbox support"
        );
    }
    #[cfg(windows)]
    assert!(
        tauri_runtime_cef::windows_sandbox_active(),
        "Ardor CEF on Windows must be launched through bootstrap.exe"
    );
    std::env::set_var("ARDOR_CEF_ACCELERATED_OSR_PROBE", "1");
    std::env::set_var("ARDOR_CEF_DENY_WEB_PERMISSIONS", "1");
    let context = tauri::generate_context!();
    configure_browser_devtools(&context.config().identifier);

    tauri::Builder::<DesktopRuntime>::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(SidebarBrowserState::default())
        .invoke_handler(tauri::generate_handler![
            check_desktop_update,
            close_sidebar_browser,
            complete_auth_callback,
            control_sidebar_browser,
            get_auth_callback_status,
            get_pending_auth_callback,
            input_sidebar_browser,
            layout_sidebar_browser,
            open_sidebar_browser,
            open_auth_url,
            install_desktop_update
        ])
        // Keep the WebView on trusted origins: the app itself, plus the Auth0
        // domain the SPA's logout flow navigates through before bouncing back.
        // Anything else opens no window for the auth callback to leak into.
        .plugin(
            tauri::plugin::Builder::<DesktopRuntime>::new("navigation-guard")
                .on_navigation(|webview, url| {
                    let allowed = if is_sidebar_browser_label(webview.label()) {
                        is_allowed_sidebar_navigation(url)
                    } else {
                        is_allowed_return_origin(url) || is_auth0_url(url)
                    };
                    if !allowed {
                        eprintln!(
                            "Blocked {} webview navigation to {}",
                            webview.label(),
                            describe_navigation(url)
                        );
                    }
                    allowed
                })
                .build(),
        )
        .setup(|app| {
            #[cfg(all(
                feature = "metal-integration-tests",
                target_os = "macos",
                target_arch = "aarch64"
            ))]
            if let Some(iterations) = metal_lifecycle_test_iterations() {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    let result =
                        test_support::run_cef_lifecycle_stress(&handle, iterations).await;
                    test_support::store_cef_lifecycle_stress_result(result);
                    handle.exit(0);
                });
                return Ok(());
            }

            start_auth_callback_server(app.handle().clone());

            match app.path().app_log_dir() {
                Ok(log_dir) => {
                    let path = auth_callback_diagnostic_path(&log_dir, auth_callback_session_id());
                    configure_auth_callback_diagnostics(path.clone());
                    if let Err(error) = prune_auth_callback_diagnostic_files(&log_dir, &path) {
                        eprintln!("Failed to prune desktop auth callback diagnostics: {error}");
                    }
                }
                Err(error) => {
                    eprintln!("Failed to resolve desktop auth diagnostic directory: {error}")
                }
            }

            #[cfg(any(windows, all(target_os = "macos", target_arch = "aarch64")))]
            {
                #[cfg(windows)]
                if let Some(bootstrap) = app.get_webview_window("main") {
                    let _ = bootstrap.hide();
                }
                sidebar_browser::start_device_recovery_coordinator(app.handle().clone());
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    let result = async {
                        let generation = handle
                            .state::<SidebarBrowserState>()
                            .start_compositor(&handle)
                            .await?;
                        let shell_label = sidebar_browser::compositor_shell_label(generation);
                        let window_label = sidebar_browser::compositor_window_label(generation);
                        if handle.get_webview(&shell_label).is_none() {
                            return Err(
                                "accelerated compositor shell is unavailable after startup"
                                    .to_string(),
                            );
                        }
                        if handle.get_window(&window_label).is_none() {
                            return Err(
                                "accelerated compositor window is unavailable after startup"
                                    .to_string(),
                            );
                        }
                        handle
                            .state::<SidebarBrowserState>()
                            .wait_for_first_shell_present(generation, Duration::from_secs(30))
                            .await?;
                        Ok::<u64, String>(generation)
                    }
                    .await;

                    match result {
                        Ok(generation) => {
                            let shell_label = sidebar_browser::compositor_shell_label(generation);
                            #[cfg(debug_assertions)]
                            if let Some(shell) = handle.get_webview(&shell_label) {
                                shell.open_devtools();
                            }
                            if let Some(bootstrap) = handle.get_webview_window("main") {
                                #[cfg(windows)]
                                let cutover_result = bootstrap.close();
                                #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
                                let cutover_result = bootstrap.hide();
                                if let Err(error) = cutover_result {
                                    eprintln!(
                                        "Failed to hide the compositor bootstrap shell: {error}"
                                    );
                                }
                            }
                        }
                        Err(error) => {
                            eprintln!(
                                "Accelerated compositor startup failed; using native fallback: {error}"
                            );
                            if let Err(fallback_error) = handle
                                .state::<SidebarBrowserState>()
                                .enter_native_fallback(&handle)
                                .await
                            {
                                eprintln!(
                                    "Failed to enter native sidebar fallback: {fallback_error}"
                                );
                            }
                        }
                    }
                });
            }

            #[cfg(not(any(windows, all(target_os = "macos", target_arch = "aarch64"))))]
            if let Some(webview) = app.get_webview("main") {
                #[cfg(debug_assertions)]
                webview.open_devtools();
            }

            Ok(())
        })
        .run(context)
        .expect("error while running Ardor Solutions desktop prototype");
}

#[cfg(windows)]
unsafe fn bootstrap_command_line_is_subprocess(mut command_line: *const u16) -> bool {
    const PROCESS_TYPE_SWITCH: &[u16] = &[
        b'-' as u16,
        b'-' as u16,
        b't' as u16,
        b'y' as u16,
        b'p' as u16,
        b'e' as u16,
        b'=' as u16,
    ];

    if command_line.is_null() {
        return false;
    }
    let mut matched = 0;
    while *command_line != 0 {
        let current = *command_line;
        if current == PROCESS_TYPE_SWITCH[matched] {
            matched += 1;
            if matched == PROCESS_TYPE_SWITCH.len() {
                return true;
            }
        } else {
            matched = usize::from(current == PROCESS_TYPE_SWITCH[0]);
        }
        command_line = command_line.add(1);
    }
    false
}

/// CEF M138+ Windows sandbox bootstrap entry point.
///
/// # Safety
/// The matching CEF bootstrap owns all pointers and keeps them valid for this
/// call. No CEF API may run before the sandbox context is installed.
#[cfg(windows)]
#[allow(non_snake_case)]
#[no_mangle]
pub unsafe extern "system" fn RunWinMain(
    _instance: *mut core::ffi::c_void,
    command_line: *mut u16,
    _show_command: i32,
    sandbox_info: *mut core::ffi::c_void,
    _version_info: *mut core::ffi::c_void,
) -> i32 {
    if !bootstrap_command_line_is_subprocess(command_line) {
        windows_crash_diagnostics::install();
    }
    if tauri_runtime_cef::install_windows_sandbox_info(sandbox_info.cast()).is_err() {
        return 1;
    }
    if bootstrap_command_line_is_subprocess(command_line) {
        tauri_runtime_cef::run_cef_helper_process();
        return 0;
    }
    run();
    0
}

#[cfg(test)]
mod tests {
    use super::{
        auth_callback_diagnostic_path, auth_state_from_query, auth_state_from_url,
        begin_auth_callback_attempt, browser_devtools_allowed_for, complete_auth_callback_with,
        consume_pending_auth_callback, escape_html, generate_auth_focus_token,
        hand_off_auth_callback, hand_off_auth_callback_recording, handle_auth_callback_with,
        is_allowed_return_origin, is_truthy_env_flag, open_auth_url_with,
        prepare_auth_callback_attempt, prune_auth_callback_diagnostic_files,
        read_auth_callback_request_path, render_auth_callback_page,
        serialize_auth_callback_diagnostics, validate_update_metadata, AuthCallbackAttempt,
        AuthCallbackDiagnosticEntry, AuthCallbackDiagnosticLog, AuthCallbackDiagnosticPhase,
        AuthCallbackHandoff, DesktopUpdateCheckOutcome, DesktopUpdateEvent, UpdateAnnouncement,
        AUTH_CALLBACK_ATTEMPT_TTL, AUTH_CALLBACK_DIAGNOSTIC_HISTORY_LIMIT,
        AUTH_CALLBACK_DIAGNOSTIC_SESSION_FILE_LIMIT, AUTH_CALLBACK_PROTOCOL_VERSION,
        AUTH_CALLBACK_READY_EVENT, AUTH_FOCUS_MAX_USES, PROD_BUNDLE_ID, STAGE1_BUNDLE_ID,
    };
    use serde_json::json;
    use std::{
        cell::Cell,
        ffi::OsStr,
        fs,
        io::{Read, Write},
        net::{Shutdown, TcpListener, TcpStream},
        sync::{mpsc, Arc, Mutex},
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

    #[test]
    fn production_browser_devtools_require_explicit_opt_in() {
        assert!(!browser_devtools_allowed_for(PROD_BUNDLE_ID, false, false));
        assert!(browser_devtools_allowed_for(PROD_BUNDLE_ID, true, false));
    }

    #[test]
    fn developer_browser_devtools_remain_available() {
        assert!(browser_devtools_allowed_for(STAGE1_BUNDLE_ID, false, false));
        assert!(browser_devtools_allowed_for(PROD_BUNDLE_ID, false, true));
    }

    #[test]
    fn browser_devtools_opt_in_accepts_only_explicit_truthy_values() {
        for value in ["1", "true", "TRUE", " yes ", "on"] {
            assert!(is_truthy_env_flag(Some(OsStr::new(value))));
        }
        for value in ["", "0", "false", "no", "enabled"] {
            assert!(!is_truthy_env_flag(Some(OsStr::new(value))));
        }
        assert!(!is_truthy_env_flag(None));
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
            .complete_callback(callback_id, callback_at)
            .is_some());

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
        assert!(focus_response.starts_with("HTTP/1.1 200 OK\r\n"));
        assert!(focus_response.contains("<script>setTimeout(() => window.close(), 5000)</script>"));
        assert!(focus_response
            .contains("script-src 'sha256-9BF3h95D4gf41+ZlhLfMEOev9mzuvZZJXQQv85BUx9k='"));
        assert!(
            focus_response.contains("If this tab does not close automatically, you can close it.")
        );
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
        assert!(focus_response.starts_with("HTTP/1.1 200 OK\r\n"));
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
            .complete_callback(callback_id, now)
            .is_some());

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
            assert!(response.starts_with("HTTP/1.1 200 OK\r\n"));
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
            assert!(!response.starts_with("HTTP/1.1 200 OK\r\n"));
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

        assert_eq!(first, AuthCallbackHandoff::Queued(1));
        assert_eq!(duplicate, AuthCallbackHandoff::Duplicate);
        assert_eq!(pending.callback_url, callback_url);
        assert!(attempt
            .lock()
            .expect("attempt should lock")
            .complete_callback(pending.id, now)
            .is_some());
        assert!(attempt
            .lock()
            .expect("attempt should lock")
            .pending
            .is_none());
    }

    #[test]
    fn queued_diagnostic_is_recorded_before_pending_callback_can_be_consumed() {
        let attempt = Arc::new(Mutex::new(AuthCallbackAttempt::default()));
        let now = Instant::now();
        begin_auth_callback_attempt(&attempt, "state-1".to_string(), now);
        let (recording_started_tx, recording_started_rx) = mpsc::channel();
        let (release_recording_tx, release_recording_rx) = mpsc::channel();
        let (consumed_tx, consumed_rx) = mpsc::channel();

        thread::scope(|scope| {
            let handoff_attempt = Arc::clone(&attempt);
            scope.spawn(move || {
                hand_off_auth_callback_recording(
                    &handoff_attempt,
                    Some("state-1"),
                    "http://127.0.0.1/callback?redacted".to_string(),
                    now,
                    |transition| {
                        assert_eq!(transition.phase, AuthCallbackDiagnosticPhase::Queued);
                        recording_started_tx
                            .send(())
                            .expect("test should observe queued diagnostic");
                        release_recording_rx
                            .recv()
                            .expect("test should release queued diagnostic");
                    },
                )
            });

            recording_started_rx
                .recv()
                .expect("queued diagnostic should start");
            let consume_attempt = Arc::clone(&attempt);
            scope.spawn(move || {
                let (_, transition) = consume_attempt
                    .lock()
                    .expect("attempt should lock")
                    .consume_pending(now);
                consumed_tx
                    .send(transition)
                    .expect("test should observe consumption");
            });

            assert!(consumed_rx.recv_timeout(Duration::from_millis(50)).is_err());
            release_recording_tx
                .send(())
                .expect("queued diagnostic should be released");
            assert_eq!(
                consumed_rx
                    .recv_timeout(Duration::from_secs(1))
                    .expect("pending callback should be consumed")
                    .expect("first consumption should emit a transition")
                    .phase,
                AuthCallbackDiagnosticPhase::Consumed
            );
        });
    }

    #[test]
    fn consumed_diagnostic_is_recorded_before_callback_can_be_acknowledged() {
        let attempt = Arc::new(Mutex::new(AuthCallbackAttempt::default()));
        let now = Instant::now();
        begin_auth_callback_attempt(&attempt, "state-1".to_string(), now);
        assert_eq!(
            attempt.lock().expect("attempt should lock").queue_callback(
                "state-1",
                "http://127.0.0.1/callback?redacted".to_string(),
                now,
            ),
            super::AuthCallbackClaim::Claimed
        );
        let (recording_started_tx, recording_started_rx) = mpsc::channel();
        let (release_recording_tx, release_recording_rx) = mpsc::channel();
        let (acknowledged_tx, acknowledged_rx) = mpsc::channel();

        thread::scope(|scope| {
            let consume_attempt = Arc::clone(&attempt);
            scope.spawn(move || {
                consume_pending_auth_callback(&consume_attempt, now, |transition| {
                    assert_eq!(transition.phase, AuthCallbackDiagnosticPhase::Consumed);
                    recording_started_tx
                        .send(())
                        .expect("test should observe consumed diagnostic");
                    release_recording_rx
                        .recv()
                        .expect("test should release consumed diagnostic");
                });
            });

            recording_started_rx
                .recv()
                .expect("consumed diagnostic should start");
            let complete_attempt = Arc::clone(&attempt);
            scope.spawn(move || {
                complete_auth_callback_with(&complete_attempt, 1, now, |transition| {
                    acknowledged_tx
                        .send(transition.phase)
                        .expect("test should observe acknowledgment");
                });
            });

            assert!(acknowledged_rx
                .recv_timeout(Duration::from_millis(50))
                .is_err());
            release_recording_tx
                .send(())
                .expect("consumed diagnostic should be released");
            assert_eq!(
                acknowledged_rx
                    .recv_timeout(Duration::from_secs(1))
                    .expect("callback should be acknowledged"),
                AuthCallbackDiagnosticPhase::Acknowledged
            );
        });
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
            AuthCallbackHandoff::Queued(1)
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
            AuthCallbackHandoff::Queued(1)
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
            AuthCallbackHandoff::Queued(1)
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
            AuthCallbackHandoff::Queued(1)
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
        assert!(page.contains("Sign-in received"));
        assert!(page.contains("Sign-in is continuing in Ardor Desktop."));
        assert!(page.contains("ARDOR"));
        assert!(page.contains("method=\"get\" action=\"/auth/focus\""));
        assert!(page.contains("name=\"token\" value=\"state/one+two\""));
        assert!(page.contains("type=\"submit\""));
        assert!(page.contains(">Return to Ardor</button>"));
        assert!(page.contains("prefers-color-scheme: dark"));
        assert!(!page.contains("Authentication complete"));
        assert!(!page.contains("<script>"));
        assert!(!page.contains("window.close()"));
    }

    #[test]
    fn auth_callback_page_renders_safe_error_state() {
        let page = render_auth_callback_page(500, "Try <again> & don't panic.", None);

        assert!(page.contains("data-state=\"error\""));
        assert!(page.contains("Return to Ardor"));
        assert!(page.contains("Try &lt;again&gt; &amp; don&#39;t panic."));
        assert!(!page.contains("<form class=\"handoff-form\""));
        assert!(!page.contains("Try <again>"));
        assert!(!page.contains("window.close()"));
    }

    #[test]
    fn auth_callback_diagnostics_are_bounded_and_exclude_oauth_material() {
        let mut diagnostics = AuthCallbackDiagnosticLog::default();
        for callback_id in 1..=(AUTH_CALLBACK_DIAGNOSTIC_HISTORY_LIMIT as u64 + 3) {
            diagnostics.push(AuthCallbackDiagnosticEntry {
                timestamp_unix_seconds: 1_700_000_000 + callback_id,
                session_id: "session-a".to_string(),
                sequence: callback_id,
                protocol_version: AUTH_CALLBACK_PROTOCOL_VERSION,
                callback_id,
                phase: AuthCallbackDiagnosticPhase::Consumed,
                elapsed_ms: callback_id * 10,
            });
        }

        let output = serialize_auth_callback_diagnostics(&diagnostics.entries);

        assert_eq!(
            output.lines().count(),
            AUTH_CALLBACK_DIAGNOSTIC_HISTORY_LIMIT
        );
        assert!(!output.contains("callbackUrl"));
        assert!(!output.contains("code"));
        assert!(!output.contains("state"));
        assert!(!output.contains("token"));
        assert!(output.contains("\"protocolVersion\":1"));
        assert!(output.contains("\"sessionId\":\"session-a\""));
        assert!(output.contains("\"sequence\":"));
        assert!(output.contains("\"phase\":\"consumed\""));
    }

    #[test]
    fn auth_callback_diagnostics_survive_restart_and_ignore_invalid_lines() {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("test clock should be after epoch")
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "ardor-auth-diagnostics-{}-{unique}",
            std::process::id()
        ));
        let path = directory.join("auth-callback-phases.jsonl");
        fs::create_dir_all(&directory).expect("temporary diagnostic directory should exist");
        fs::write(
            &path,
            concat!(
                "{\"timestampUnixSeconds\":1,\"sessionId\":\"session-a\",\"sequence\":1,\"protocolVersion\":1,\"callbackId\":4,\"phase\":\"queued\",\"elapsedMs\":0}\n",
                "not-json\n"
            ),
        )
        .expect("diagnostic fixture should write");

        let mut diagnostics = AuthCallbackDiagnosticLog::default();
        diagnostics
            .configure(path.clone())
            .expect("existing diagnostics should load");
        assert_eq!(diagnostics.entries.len(), 1);
        diagnostics.push(AuthCallbackDiagnosticEntry {
            timestamp_unix_seconds: 2,
            session_id: "session-a".to_string(),
            sequence: 2,
            protocol_version: 1,
            callback_id: 4,
            phase: AuthCallbackDiagnosticPhase::Acknowledged,
            elapsed_ms: 25,
        });
        diagnostics.persist().expect("diagnostics should persist");
        assert!(!super::diagnostic_temporary_path(&path).exists());

        let mut reloaded = AuthCallbackDiagnosticLog::default();
        reloaded
            .configure(path)
            .expect("persisted diagnostics should reload");
        assert_eq!(reloaded.entries.len(), 2);
        assert_eq!(reloaded.next_sequence, 3);
        assert_eq!(
            reloaded.entries.back().map(|entry| entry.phase),
            Some(AuthCallbackDiagnosticPhase::Acknowledged)
        );

        fs::remove_dir_all(directory).expect("temporary diagnostic directory should clean up");
    }

    #[test]
    fn auth_callback_diagnostics_recover_backup_and_discard_oversized_input() {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("test clock should be after epoch")
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "ardor-auth-diagnostics-recovery-{}-{unique}",
            std::process::id()
        ));
        let path = directory.join("auth-callback-phases.jsonl");
        let backup_path = super::diagnostic_backup_path(&path);
        fs::create_dir_all(&directory).expect("temporary diagnostic directory should exist");
        fs::write(
            &backup_path,
            "{\"timestampUnixSeconds\":1,\"sessionId\":\"session-a\",\"sequence\":9,\"protocolVersion\":1,\"callbackId\":4,\"phase\":\"queued\",\"elapsedMs\":0}\n",
        )
        .expect("backup fixture should write");

        let mut recovered = AuthCallbackDiagnosticLog::default();
        recovered
            .configure(path.clone())
            .expect("backup diagnostics should recover");
        assert_eq!(recovered.entries.len(), 1);
        assert_eq!(recovered.next_sequence, 10);
        assert!(!backup_path.exists());

        fs::write(
            &path,
            vec![b'x'; (super::AUTH_CALLBACK_DIAGNOSTIC_LOG_MAX_BYTES + 1) as usize],
        )
        .expect("oversized fixture should write");
        let mut bounded = AuthCallbackDiagnosticLog::default();
        bounded
            .configure(path.clone())
            .expect("oversized diagnostics should be replaced");
        assert!(bounded.entries.is_empty());
        assert_eq!(
            fs::metadata(&path)
                .expect("diagnostic log should exist")
                .len(),
            0
        );

        fs::remove_dir_all(directory).expect("temporary diagnostic directory should clean up");
    }

    #[test]
    fn auth_callback_diagnostics_use_bounded_per_session_files() {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("test clock should be after epoch")
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "ardor-auth-diagnostics-sessions-{}-{unique}",
            std::process::id()
        ));
        fs::create_dir_all(&directory).expect("temporary diagnostic directory should exist");
        let first = auth_callback_diagnostic_path(&directory, "session-a");
        let second = auth_callback_diagnostic_path(&directory, "session-b");
        assert_ne!(first, second);
        assert_ne!(
            super::diagnostic_temporary_path(&first),
            super::diagnostic_temporary_path(&second)
        );

        for index in 0..=(AUTH_CALLBACK_DIAGNOSTIC_SESSION_FILE_LIMIT + 1) {
            let path = auth_callback_diagnostic_path(&directory, &format!("old-{index}"));
            fs::write(path, "\n").expect("session diagnostic fixture should write");
        }
        let current = auth_callback_diagnostic_path(&directory, "current");
        fs::write(&current, "\n").expect("current diagnostic fixture should write");
        prune_auth_callback_diagnostic_files(&directory, &current)
            .expect("session diagnostics should prune");

        let retained = fs::read_dir(&directory)
            .expect("diagnostic directory should read")
            .filter_map(Result::ok)
            .filter(|entry| {
                entry.file_name().to_str().is_some_and(|name| {
                    name.starts_with(super::AUTH_CALLBACK_DIAGNOSTIC_LOG_PREFIX)
                })
            })
            .count();
        assert_eq!(retained, AUTH_CALLBACK_DIAGNOSTIC_SESSION_FILE_LIMIT);
        assert!(current.exists());

        fs::remove_dir_all(directory).expect("temporary diagnostic directory should clean up");
    }

    #[test]
    fn desktop_ui_requirements_match_the_native_callback_contract() {
        let _get_pending_command: fn() -> Option<super::PendingAuthCallback> =
            super::get_pending_auth_callback;
        let _complete_command: fn(u64) -> bool = super::complete_auth_callback;
        let requirements: serde_json::Value =
            serde_json::from_str(include_str!("../../desktop-ui-requirements.json"))
                .expect("desktop UI requirements must be valid JSON");
        let callback = &requirements["requirements"]["desktopAuthCallback"];

        assert_eq!(requirements["schemaVersion"], 1);
        assert_eq!(callback["protocolVersion"], AUTH_CALLBACK_PROTOCOL_VERSION);
        assert_eq!(callback["event"], AUTH_CALLBACK_READY_EVENT);
        assert_eq!(
            callback["commands"]["getPendingAuthCallback"],
            stringify!(get_pending_auth_callback)
        );
        assert_eq!(
            callback["commands"]["completeAuthCallback"],
            stringify!(complete_auth_callback)
        );
        assert_eq!(
            serde_json::to_value(super::PendingAuthCallback {
                id: 7,
                callback_url: "redacted".to_string(),
            })
            .expect("pending callback must serialize"),
            serde_json::json!({ "id": 7, "callbackUrl": "redacted" })
        );
        assert_eq!(
            callback["payloads"]["getPendingAuthCallbackResult"]["nullable"],
            true
        );
        assert_eq!(
            callback["payloads"]["getPendingAuthCallbackResult"]["fields"],
            serde_json::json!({ "id": "number", "callbackUrl": "string" })
        );
        assert_eq!(
            callback["payloads"]["completeAuthCallbackArguments"],
            serde_json::json!({ "callbackId": "number" })
        );
        assert_eq!(
            callback["payloads"]["completeAuthCallbackResult"],
            "boolean"
        );
        assert_eq!(
            callback["lifecycle"],
            serde_json::json!({
                "delivery": "retained-until-acknowledged-or-expired",
                "readyEvent": "wake-up-only",
                "acknowledgeAfter": "auth0-code-exchange-attempt-or-authenticated-reconciliation",
                "expiresAfterSeconds": AUTH_CALLBACK_ATTEMPT_TTL.as_secs(),
                "expiryPhase": "expired"
            })
        );
        let source = include_str!("lib.rs");
        assert!(source.contains(
            "#[tauri::command(rename_all = \"camelCase\")]\nfn complete_auth_callback(callback_id: u64)"
        ));
        assert!(source.contains(
            "close_sidebar_browser,\n            complete_auth_callback,\n            control_sidebar_browser,"
        ));
        assert!(source.contains(
            "input_sidebar_browser,\n            layout_sidebar_browser,\n            open_sidebar_browser,"
        ));
    }

    #[test]
    fn native_sidebar_browser_commands_are_privileged_shell_only() {
        let requirements: serde_json::Value =
            serde_json::from_str(include_str!("../../desktop-ui-requirements.json"))
                .expect("desktop UI requirements must be valid JSON");
        let browser = &requirements["requirements"]["nativeSidebarBrowser"];
        assert_eq!(browser["protocolVersion"], 6);
        assert_eq!(
            browser["commands"],
            serde_json::json!({
                "open": "open_sidebar_browser",
                "layout": "layout_sidebar_browser",
                "control": "control_sidebar_browser",
                "input": "input_sidebar_browser",
                "close": "close_sidebar_browser"
            })
        );
        assert_eq!(
            browser["payloads"]["openResult"],
            serde_json::json!({
                "generation": "number",
                "devtoolsEnabled": "boolean"
            })
        );

        let capability: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/default.json"))
                .expect("default capability must be valid JSON");
        assert_eq!(
            capability["webviews"],
            serde_json::json!(["main", "offscreen-browser-gpu-shell-*"])
        );
        assert!(!capability["webviews"]
            .as_array()
            .expect("webviews must be an array")
            .iter()
            .any(|label| label
                .as_str()
                .is_some_and(|label| label.contains("preview"))));
        assert!(capability.get("windows").is_none());
        for permission in [
            "allow-open-sidebar-browser",
            "allow-layout-sidebar-browser",
            "allow-control-sidebar-browser",
            "allow-input-sidebar-browser",
            "allow-close-sidebar-browser",
        ] {
            assert!(capability["permissions"]
                .as_array()
                .expect("permissions must be an array")
                .contains(&serde_json::json!(permission)));
        }

        let build = include_str!("../build.rs");
        for command in [
            "open_sidebar_browser",
            "layout_sidebar_browser",
            "control_sidebar_browser",
            "input_sidebar_browser",
            "close_sidebar_browser",
        ] {
            assert!(
                build.contains(&format!("\"{command}\"")),
                "AppManifest is missing {command}"
            );
        }
    }

    #[test]
    fn auth_callback_diagnostics_emit_consumed_acknowledged_and_expired_once() {
        let mut attempt = AuthCallbackAttempt::default();
        let started_at = Instant::now();
        attempt.begin(
            "state-1".to_string(),
            "focus-state-1".to_string(),
            started_at,
        );
        assert_eq!(
            attempt.queue_callback(
                "state-1",
                "http://127.0.0.1/auth/callback?redacted".to_string(),
                started_at,
            ),
            super::AuthCallbackClaim::Claimed
        );

        let (pending, consumed) = attempt.consume_pending(started_at + Duration::from_millis(25));
        assert!(pending.is_some());
        assert_eq!(
            consumed
                .expect("first delivery should record consumption")
                .phase,
            AuthCallbackDiagnosticPhase::Consumed
        );
        assert!(attempt.consume_pending(started_at).1.is_none());

        let callback_id = pending.expect("pending callback should exist").id;
        let acknowledged = attempt
            .complete_callback(callback_id, started_at + Duration::from_millis(50))
            .expect("matching callback should acknowledge");
        assert_eq!(
            acknowledged.phase,
            AuthCallbackDiagnosticPhase::Acknowledged
        );

        attempt.begin(
            "state-2".to_string(),
            "focus-state-2".to_string(),
            started_at,
        );
        attempt.queue_callback(
            "state-2",
            "http://127.0.0.1/auth/callback?redacted".to_string(),
            started_at,
        );
        let expired = attempt
            .expire(started_at + AUTH_CALLBACK_ATTEMPT_TTL)
            .expect("pending callback should record expiry");
        assert_eq!(expired.phase, AuthCallbackDiagnosticPhase::Expired);
        assert!(attempt
            .expire(started_at + AUTH_CALLBACK_ATTEMPT_TTL)
            .is_none());
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
