use std::{
    collections::{BTreeMap, HashMap, VecDeque},
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde::{Deserialize, Serialize};
use tauri::{webview::DownloadEvent, Emitter, Manager, State};
use zeroize::{Zeroize, Zeroizing};

use crate::{
    runtime::{DesktopAppHandle as AppHandle, DesktopWebview as Webview},
    sidebar_browser::{
        artifact_preview_for_caller, artifact_preview_webview, browser_profile_webview,
        is_privileged_shell_label, open_downloads_directory, SidebarBrowserState,
    },
};

mod hooks;
pub(crate) use hooks::credential_hook_script as browser_credential_hook_script;

const MAX_CREDENTIAL_ID_BYTES: usize = 128;
const MAX_CREDENTIAL_USERNAME_BYTES: usize = 1024;
const MAX_CREDENTIAL_SECRET_BYTES: usize = 2048;
const CREDENTIAL_PROMPT_TTL: Duration = Duration::from_secs(2 * 60);
const CREDENTIAL_DETECTION_INTERVAL: Duration = Duration::from_millis(500);
const CREDENTIAL_SUBMISSION_INTERVAL: Duration = Duration::from_secs(2);
const MAX_PENDING_CREDENTIAL_PROMPTS: usize = 32;
pub(crate) const BROWSER_CREDENTIAL_OPTIONS_EVENT: &str = "desktop-browser-credential-options";
pub(crate) const BROWSER_SAVE_PASSWORD_PROMPT_EVENT: &str = "desktop-browser-save-password-prompt";
pub(crate) const BROWSER_DOWNLOADS_CHANGED_EVENT: &str = "desktop-browser-downloads-changed";

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum AutofillMode {
    #[default]
    Ask,
    Automatic,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BrowserPreferences {
    pub(crate) autofill_mode: AutofillMode,
    pub(crate) ask_to_save_passwords: bool,
}

impl Default for BrowserPreferences {
    fn default() -> Self {
        Self {
            autofill_mode: AutofillMode::Ask,
            ask_to_save_passwords: true,
        }
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CredentialMetadata {
    pub(crate) id: String,
    pub(crate) origin: String,
    pub(crate) username: String,
    pub(crate) created_at_unix_seconds: u64,
    pub(crate) updated_at_unix_seconds: u64,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum DownloadStatus {
    InProgress,
    Completed,
    Failed,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DownloadRecord {
    pub(crate) id: String,
    pub(crate) source_origin: String,
    pub(crate) file_name: String,
    pub(crate) path: String,
    pub(crate) started_at_unix_seconds: u64,
    pub(crate) finished_at_unix_seconds: Option<u64>,
    pub(crate) status: DownloadStatus,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BrowserProfileDocument {
    #[serde(default)]
    pub(crate) preferences: BrowserPreferences,
    #[serde(default)]
    pub(crate) credentials: Vec<CredentialMetadata>,
    #[serde(default)]
    pub(crate) downloads: Vec<DownloadRecord>,
}

pub(crate) struct BrowserProfileIndexStore {
    path: PathBuf,
}

impl BrowserProfileIndexStore {
    pub(crate) fn new(path: PathBuf) -> Self {
        Self { path }
    }

    #[cfg(test)]
    pub(crate) fn path(&self) -> &Path {
        &self.path
    }

    pub(crate) fn load(&self) -> Result<BrowserProfileDocument, String> {
        let source = match fs::read_to_string(&self.path) {
            Ok(source) => source,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(BrowserProfileDocument::default());
            }
            Err(error) => return Err(format!("failed to read browser profile index: {error}")),
        };
        serde_json::from_str(&source)
            .map_err(|error| format!("failed to parse browser profile index: {error}"))
    }

    pub(crate) fn save(&self, document: &BrowserProfileDocument) -> Result<(), String> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("failed to create browser profile directory: {error}"))?;
        }
        let encoded = serde_json::to_vec_pretty(document)
            .map_err(|error| format!("failed to serialize browser profile index: {error}"))?;
        let temporary_path = self.path.with_extension("json.tmp");
        let backup_path = self.path.with_extension("json.bak");
        let mut temporary_file = fs::File::create(&temporary_path)
            .map_err(|error| format!("failed to create browser profile index: {error}"))?;
        temporary_file
            .write_all(&encoded)
            .and_then(|()| temporary_file.sync_all())
            .map_err(|error| format!("failed to write browser profile index: {error}"))?;
        drop(temporary_file);

        if !self.path.exists() {
            return fs::rename(&temporary_path, &self.path)
                .map_err(|error| format!("failed to install browser profile index: {error}"));
        }
        if backup_path.exists() {
            fs::remove_file(&backup_path).map_err(|error| {
                format!("failed to remove stale browser profile backup: {error}")
            })?;
        }
        fs::rename(&self.path, &backup_path)
            .map_err(|error| format!("failed to back up browser profile index: {error}"))?;
        if let Err(error) = fs::rename(&temporary_path, &self.path) {
            let _ = fs::rename(&backup_path, &self.path);
            return Err(format!("failed to replace browser profile index: {error}"));
        }
        let _ = fs::remove_file(backup_path);
        Ok(())
    }
}

pub(crate) trait CredentialVault: Send + Sync {
    fn set_secret(&self, credential_id: &str, secret: &str) -> Result<(), String>;
    fn get_secret(&self, credential_id: &str) -> Result<Zeroizing<String>, String>;
    fn delete_secret(&self, credential_id: &str) -> Result<(), String>;
}

pub(crate) struct SystemCredentialVault {
    service: String,
    operations: Mutex<()>,
}

impl SystemCredentialVault {
    pub(crate) fn new(bundle_id: &str) -> Self {
        Self {
            service: format!("{bundle_id}.artifact-browser.passwords.v1"),
            operations: Mutex::new(()),
        }
    }

    #[cfg(test)]
    pub(crate) fn service_name(&self) -> &str {
        &self.service
    }
}

impl CredentialVault for SystemCredentialVault {
    fn set_secret(&self, credential_id: &str, secret: &str) -> Result<(), String> {
        let _operation = self
            .operations
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        platform_vault::set_secret(&self.service, credential_id, secret)
    }

    fn get_secret(&self, credential_id: &str) -> Result<Zeroizing<String>, String> {
        let _operation = self
            .operations
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        platform_vault::get_secret(&self.service, credential_id)
    }

    fn delete_secret(&self, credential_id: &str) -> Result<(), String> {
        let _operation = self
            .operations
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        platform_vault::delete_secret(&self.service, credential_id)
    }
}

#[cfg(target_os = "macos")]
mod platform_vault {
    use security_framework::passwords::{
        delete_generic_password, get_generic_password, set_generic_password,
    };
    use zeroize::Zeroizing;

    pub(super) fn set_secret(
        service: &str,
        credential_id: &str,
        secret: &str,
    ) -> Result<(), String> {
        set_generic_password(service, credential_id, secret.as_bytes())
            .map_err(|error| format!("failed to write browser password to macOS Keychain: {error}"))
    }

    pub(super) fn get_secret(
        service: &str,
        credential_id: &str,
    ) -> Result<Zeroizing<String>, String> {
        let secret = get_generic_password(service, credential_id).map_err(|error| {
            format!("failed to read browser password from macOS Keychain: {error}")
        })?;
        String::from_utf8(secret)
            .map(Zeroizing::new)
            .map_err(|_| "browser password in macOS Keychain is not valid UTF-8".to_string())
    }

    pub(super) fn delete_secret(service: &str, credential_id: &str) -> Result<(), String> {
        delete_generic_password(service, credential_id).map_err(|error| {
            format!("failed to delete browser password from macOS Keychain: {error}")
        })
    }
}

#[cfg(windows)]
mod platform_vault {
    use std::{ptr, slice};

    use windows::{
        core::{PCWSTR, PWSTR},
        Win32::Security::Credentials::{
            CredDeleteW, CredFree, CredReadW, CredWriteW, CREDENTIALW, CRED_PERSIST_LOCAL_MACHINE,
            CRED_TYPE_GENERIC,
        },
    };
    use zeroize::Zeroizing;

    fn credential_target(service: &str, credential_id: &str) -> Vec<u16> {
        format!("{service}/{credential_id}")
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect()
    }

    pub(super) fn set_secret(
        service: &str,
        credential_id: &str,
        secret: &str,
    ) -> Result<(), String> {
        let mut target = credential_target(service, credential_id);
        let mut username = credential_id
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect::<Vec<_>>();
        let mut secret = Zeroizing::new(secret.as_bytes().to_vec());
        let credential = CREDENTIALW {
            Type: CRED_TYPE_GENERIC,
            TargetName: PWSTR(target.as_mut_ptr()),
            CredentialBlobSize: secret
                .len()
                .try_into()
                .map_err(|_| "browser password is too large for Windows Credential Manager")?,
            CredentialBlob: secret.as_mut_ptr(),
            Persist: CRED_PERSIST_LOCAL_MACHINE,
            UserName: PWSTR(username.as_mut_ptr()),
            ..Default::default()
        };
        unsafe { CredWriteW(&credential, 0) }.map_err(|error| {
            format!("failed to write browser password to Windows Credential Manager: {error}")
        })
    }

    struct CredentialBuffer(*mut CREDENTIALW);

    impl Drop for CredentialBuffer {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe { CredFree(self.0.cast()) };
            }
        }
    }

    pub(super) fn get_secret(
        service: &str,
        credential_id: &str,
    ) -> Result<Zeroizing<String>, String> {
        let target = credential_target(service, credential_id);
        let mut raw = ptr::null_mut();
        unsafe { CredReadW(PCWSTR(target.as_ptr()), CRED_TYPE_GENERIC, None, &mut raw) }.map_err(
            |error| {
                format!("failed to read browser password from Windows Credential Manager: {error}")
            },
        )?;
        let buffer = CredentialBuffer(raw);
        let credential = unsafe { buffer.0.as_ref() }
            .ok_or_else(|| "Windows Credential Manager returned an empty credential".to_string())?;
        let length: usize = credential
            .CredentialBlobSize
            .try_into()
            .map_err(|_| "Windows Credential Manager returned an invalid password size")?;
        if length > super::MAX_CREDENTIAL_SECRET_BYTES || credential.CredentialBlob.is_null() {
            return Err("Windows Credential Manager returned an invalid password".to_string());
        }
        let bytes = unsafe { slice::from_raw_parts(credential.CredentialBlob, length) };
        std::str::from_utf8(bytes)
            .map(|secret| Zeroizing::new(secret.to_string()))
            .map_err(|_| {
                "browser password in Windows Credential Manager is not valid UTF-8".to_string()
            })
    }

    pub(super) fn delete_secret(service: &str, credential_id: &str) -> Result<(), String> {
        let target = credential_target(service, credential_id);
        unsafe { CredDeleteW(PCWSTR(target.as_ptr()), CRED_TYPE_GENERIC, None) }.map_err(|error| {
            format!("failed to delete browser password from Windows Credential Manager: {error}")
        })
    }
}

#[cfg(not(any(windows, target_os = "macos")))]
mod platform_vault {
    use zeroize::Zeroizing;

    fn unsupported() -> String {
        "browser password storage is available only on macOS and Windows".to_string()
    }

    pub(super) fn set_secret(
        _service: &str,
        _credential_id: &str,
        _secret: &str,
    ) -> Result<(), String> {
        Err(unsupported())
    }

    pub(super) fn get_secret(
        _service: &str,
        _credential_id: &str,
    ) -> Result<Zeroizing<String>, String> {
        Err(unsupported())
    }

    pub(super) fn delete_secret(_service: &str, _credential_id: &str) -> Result<(), String> {
        Err(unsupported())
    }
}

pub(crate) struct BrowserProfileService {
    index: BrowserProfileIndexStore,
    vault: Arc<dyn CredentialVault>,
    document: Mutex<BrowserProfileDocument>,
}

pub(crate) struct CredentialForAutofill {
    pub(crate) metadata: CredentialMetadata,
    pub(crate) secret: Zeroizing<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BrowserSettingsSnapshot {
    pub(crate) password_storage_supported: bool,
    pub(crate) preferences: BrowserPreferences,
    pub(crate) credentials: Vec<CredentialMetadata>,
    pub(crate) downloads: Vec<DownloadRecord>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BrowserSiteData {
    pub(crate) domain: String,
    pub(crate) cookie_count: usize,
}

pub(crate) struct BrowserProfileState {
    service: Arc<BrowserProfileService>,
    password_storage_supported: bool,
    pending_prompts: Mutex<HashMap<String, PendingCredentialPrompt>>,
    credential_notifications: Mutex<CredentialNotificationLimiter>,
    active_downloads: Mutex<HashMap<(String, String), VecDeque<String>>>,
}

impl BrowserProfileState {
    pub(crate) fn load(index_path: PathBuf, bundle_id: &str) -> Result<Self, String> {
        let vault = Arc::new(SystemCredentialVault::new(bundle_id));
        let service =
            BrowserProfileService::load(BrowserProfileIndexStore::new(index_path), vault)?;
        Ok(Self {
            service: Arc::new(service),
            password_storage_supported: cfg!(any(windows, target_os = "macos")),
            pending_prompts: Mutex::new(HashMap::new()),
            credential_notifications: Mutex::new(CredentialNotificationLimiter::default()),
            active_downloads: Mutex::new(HashMap::new()),
        })
    }

    fn snapshot(&self) -> BrowserSettingsSnapshot {
        BrowserSettingsSnapshot {
            password_storage_supported: self.password_storage_supported,
            preferences: self.service.preferences(),
            credentials: self.service.list_credentials(),
            downloads: self.service.downloads(),
        }
    }
}

#[derive(Clone, Copy)]
enum CredentialNotificationKind {
    Detected,
    Submitted,
}

#[derive(Default)]
struct CredentialNotificationLimiter {
    detected: HashMap<String, Instant>,
    submitted: HashMap<String, Instant>,
}

impl CredentialNotificationLimiter {
    fn allow(&mut self, label: &str, kind: CredentialNotificationKind, now: Instant) -> bool {
        let (timestamps, interval) = match kind {
            CredentialNotificationKind::Detected => {
                (&mut self.detected, CREDENTIAL_DETECTION_INTERVAL)
            }
            CredentialNotificationKind::Submitted => {
                (&mut self.submitted, CREDENTIAL_SUBMISSION_INTERVAL)
            }
        };
        timestamps.retain(|_, previous| {
            now.saturating_duration_since(*previous) <= CREDENTIAL_PROMPT_TTL
        });
        if timestamps
            .get(label)
            .is_some_and(|previous| now.saturating_duration_since(*previous) < interval)
        {
            return false;
        }
        timestamps.insert(label.to_string(), now);
        true
    }
}

fn active_download_key(webview_label: &str, url: &str) -> (String, String) {
    (webview_label.to_string(), url.to_string())
}

fn ensure_main_caller(caller: &Webview) -> Result<(), String> {
    if !is_privileged_shell_label(caller.label()) {
        return Err("browser settings are available only to the main application".to_string());
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn get_browser_settings(
    caller: Webview,
    state: State<'_, BrowserProfileState>,
) -> Result<BrowserSettingsSnapshot, String> {
    ensure_main_caller(&caller)?;
    Ok(state.snapshot())
}

#[tauri::command]
pub(crate) async fn update_browser_preferences(
    caller: Webview,
    state: State<'_, BrowserProfileState>,
    preferences: BrowserPreferences,
) -> Result<BrowserSettingsSnapshot, String> {
    ensure_main_caller(&caller)?;
    let service = Arc::clone(&state.service);
    tauri::async_runtime::spawn_blocking(move || service.update_preferences(preferences))
        .await
        .map_err(|error| format!("browser preferences task failed: {error}"))??;
    Ok(state.snapshot())
}

#[tauri::command]
pub(crate) async fn delete_browser_credential(
    caller: Webview,
    state: State<'_, BrowserProfileState>,
    credential_id: String,
) -> Result<bool, String> {
    ensure_main_caller(&caller)?;
    let service = Arc::clone(&state.service);
    tauri::async_runtime::spawn_blocking(move || service.delete_credential(&credential_id))
        .await
        .map_err(|error| format!("browser credential deletion task failed: {error}"))?
}

#[tauri::command]
pub(crate) async fn clear_browser_download_history(
    caller: Webview,
    state: State<'_, BrowserProfileState>,
) -> Result<BrowserSettingsSnapshot, String> {
    ensure_main_caller(&caller)?;
    let service = Arc::clone(&state.service);
    tauri::async_runtime::spawn_blocking(move || service.clear_download_history())
        .await
        .map_err(|error| format!("browser download history task failed: {error}"))??;
    Ok(state.snapshot())
}

#[tauri::command]
pub(crate) async fn open_browser_downloads(caller: Webview, app: AppHandle) -> Result<(), String> {
    ensure_main_caller(&caller)?;
    open_downloads_directory(&app)
}

#[tauri::command]
pub(crate) async fn list_browser_site_data(
    caller: Webview,
    app: AppHandle,
    sidebar_state: State<'_, SidebarBrowserState>,
) -> Result<Vec<BrowserSiteData>, String> {
    ensure_main_caller(&caller)?;
    let Some(webview) = browser_profile_webview(&app, &sidebar_state) else {
        return Ok(Vec::new());
    };
    tauri::async_runtime::spawn_blocking(move || {
        let cookies = webview
            .cookies()
            .map_err(|error| format!("failed to list artifact browser cookies: {error}"))?;
        let mut domains = BTreeMap::<String, usize>::new();
        for cookie in cookies {
            let domain = cookie
                .domain()
                .unwrap_or("unknown")
                .trim_start_matches('.')
                .to_ascii_lowercase();
            *domains.entry(domain).or_default() += 1;
        }
        Ok(domains
            .into_iter()
            .map(|(domain, cookie_count)| BrowserSiteData {
                domain,
                cookie_count,
            })
            .collect())
    })
    .await
    .map_err(|error| format!("browser cookie listing task failed: {error}"))?
}

#[tauri::command]
pub(crate) async fn clear_browser_site_data(
    caller: Webview,
    app: AppHandle,
    sidebar_state: State<'_, SidebarBrowserState>,
) -> Result<bool, String> {
    ensure_main_caller(&caller)?;
    let Some(webview) = browser_profile_webview(&app, &sidebar_state) else {
        return Ok(false);
    };
    webview
        .clear_all_browsing_data()
        .map_err(|error| format!("failed to clear artifact browser cookies and cache: {error}"))?;
    Ok(true)
}

pub(crate) fn record_browser_download(webview: Webview, event: DownloadEvent<'_>) -> bool {
    let app = webview.app_handle().clone();
    let state = app.state::<BrowserProfileState>();
    let result = match event {
        DownloadEvent::Requested { url, destination } => {
            let result: Result<(), String> = (|| {
                let id = new_opaque_id()?;
                let destination = if destination.as_os_str().is_empty() {
                    url.path_segments()
                        .and_then(Iterator::last)
                        .filter(|name| !name.is_empty())
                        .unwrap_or("download")
                        .to_string()
                } else {
                    destination.to_string_lossy().into_owned()
                };
                state.service.record_download_requested(
                    &id,
                    url.as_str(),
                    &destination,
                    unix_timestamp(),
                )?;
                state
                    .active_downloads
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .entry(active_download_key(webview.label(), url.as_str()))
                    .or_default()
                    .push_back(id);
                Ok(())
            })();
            result
        }
        DownloadEvent::Finished { url, path, success } => {
            let result: Result<(), String> = (|| {
                let key = active_download_key(webview.label(), url.as_str());
                let id = {
                    let mut downloads = state
                        .active_downloads
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner());
                    let id = downloads.get_mut(&key).and_then(VecDeque::pop_front);
                    if downloads.get(&key).is_some_and(VecDeque::is_empty) {
                        downloads.remove(&key);
                    }
                    id
                };
                let id = match id {
                    Some(id) => id,
                    None => {
                        let id = new_opaque_id()?;
                        let fallback = path
                            .as_deref()
                            .map(Path::to_path_buf)
                            .or_else(|| {
                                url.path_segments()
                                    .and_then(Iterator::last)
                                    .filter(|name| !name.is_empty())
                                    .map(PathBuf::from)
                            })
                            .ok_or_else(|| {
                                "browser download has no destination path".to_string()
                            })?;
                        state.service.record_download_requested(
                            &id,
                            url.as_str(),
                            fallback.to_string_lossy().as_ref(),
                            unix_timestamp(),
                        )?;
                        id
                    }
                };
                state.service.record_download_finished(
                    &id,
                    path.map(|path| path.to_string_lossy().into_owned()),
                    success,
                    unix_timestamp(),
                )?;
                Ok(())
            })();
            result
        }
        _ => Ok(()),
    };
    match result {
        Ok(()) => {
            let _ = emit_to_privileged_shells(
                &app,
                BROWSER_DOWNLOADS_CHANGED_EVENT,
                state.service.downloads(),
            );
        }
        Err(error) => {
            eprintln!("[artifact-browser] failed to update download history: {error}");
        }
    }
    true
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BrowserCredentialSubmission {
    origin: String,
    username: String,
    password: String,
}

impl Drop for BrowserCredentialSubmission {
    fn drop(&mut self) {
        self.password.zeroize();
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BrowserCredentialOptionsEvent {
    generation: u64,
    origin: String,
    credentials: Vec<CredentialMetadata>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BrowserSavePasswordPromptEvent {
    prompt_id: String,
    generation: u64,
    origin: String,
    username: String,
    is_update: bool,
}

struct PendingCredentialPrompt {
    generation: u64,
    origin: String,
    username: String,
    secret: Zeroizing<String>,
    expires_at: Instant,
}

fn queue_pending_credential_prompt(
    prompts: &mut HashMap<String, PendingCredentialPrompt>,
    prompt_id: String,
    prompt: PendingCredentialPrompt,
    now: Instant,
) -> bool {
    prompts.retain(|_, pending| pending.expires_at > now);
    let duplicate_id = prompts
        .iter()
        .find(|(_, pending)| {
            pending.generation == prompt.generation
                && pending.origin == prompt.origin
                && pending.username == prompt.username
        })
        .map(|(id, _)| id.clone());
    if let Some(duplicate_id) = duplicate_id {
        prompts.remove(&duplicate_id);
    } else if prompts.len() >= MAX_PENDING_CREDENTIAL_PROMPTS {
        return false;
    }
    prompts.insert(prompt_id, prompt);
    true
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum BrowserCredentialPromptAction {
    Save,
    NotNow,
}

fn emit_to_privileged_shells<T: Clone + Serialize>(
    app: &AppHandle,
    event: &str,
    payload: T,
) -> Result<(), String> {
    for label in app.webviews().keys() {
        if is_privileged_shell_label(label) {
            app.emit_to(label, event, payload.clone())
                .map_err(|error| format!("failed to emit {event}: {error}"))?;
        }
    }
    Ok(())
}

fn current_preview_origin(webview: &Webview) -> Result<String, String> {
    let url = webview
        .url()
        .map_err(|error| format!("failed to read artifact browser URL: {error}"))?;
    normalize_https_origin(url.as_str())
}

fn fill_preview_credential(
    webview: &Webview,
    credential: &CredentialForAutofill,
) -> Result<(), String> {
    let payload = Zeroizing::new(
        serde_json::to_string(&serde_json::json!({
            "origin": credential.metadata.origin,
            "username": credential.metadata.username,
            "password": credential.secret.as_str(),
        }))
        .map_err(|error| format!("failed to encode browser credential fill: {error}"))?,
    );
    let script = Zeroizing::new(format!(
        "window.__ARDOR_BROWSER_CREDENTIALS__?.fill({});",
        payload.as_str()
    ));
    webview
        .eval(script.as_str())
        .map_err(|error| format!("failed to fill artifact browser credential: {error}"))
}

#[tauri::command]
pub(crate) async fn browser_credential_form_detected(
    caller: Webview,
    app: AppHandle,
    sidebar_state: State<'_, SidebarBrowserState>,
    profile_state: State<'_, BrowserProfileState>,
    username: String,
) -> Result<bool, String> {
    let _operation = sidebar_state.operations.lock().await;
    let Some((generation, webview)) = artifact_preview_for_caller(&app, &sidebar_state, &caller)?
    else {
        return Err("credential detection is available only to artifact previews".to_string());
    };
    if !profile_state
        .credential_notifications
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .allow(
            caller.label(),
            CredentialNotificationKind::Detected,
            Instant::now(),
        )
    {
        return Ok(false);
    }
    let origin = current_preview_origin(&webview)?;
    let service = Arc::clone(&profile_state.service);
    let lookup_origin = origin.clone();
    let credentials = tauri::async_runtime::spawn_blocking(move || {
        service.credential_metadata_for_origin(&lookup_origin)
    })
    .await
    .map_err(|error| format!("browser credential lookup task failed: {error}"))??;
    if credentials.is_empty() {
        return Ok(false);
    }

    let matching = if username.is_empty() {
        credentials
    } else {
        let exact = credentials
            .iter()
            .filter(|credential| credential.username == username)
            .cloned()
            .collect::<Vec<_>>();
        if exact.is_empty() {
            credentials
        } else {
            exact
        }
    };
    if profile_state.service.preferences().autofill_mode == AutofillMode::Automatic {
        let selected = matching
            .first()
            .ok_or_else(|| "browser credential selection is empty".to_string())?;
        let credential_id = selected.id.clone();
        let service = Arc::clone(&profile_state.service);
        let fill_origin = origin.clone();
        let credential = tauri::async_runtime::spawn_blocking(move || {
            service.credential_for_fill(&fill_origin, &credential_id)
        })
        .await
        .map_err(|error| format!("browser credential read task failed: {error}"))??
        .ok_or_else(|| "browser credential is unavailable for this origin".to_string())?;
        fill_preview_credential(&webview, &credential)?;
        return Ok(true);
    }

    emit_to_privileged_shells(
        &app,
        BROWSER_CREDENTIAL_OPTIONS_EVENT,
        BrowserCredentialOptionsEvent {
            generation,
            origin,
            credentials: matching,
        },
    )?;
    Ok(true)
}

#[tauri::command]
pub(crate) async fn fill_browser_credential(
    caller: Webview,
    app: AppHandle,
    sidebar_state: State<'_, SidebarBrowserState>,
    profile_state: State<'_, BrowserProfileState>,
    generation: u64,
    credential_id: String,
) -> Result<bool, String> {
    ensure_main_caller(&caller)?;
    let _operation = sidebar_state.operations.lock().await;
    let Some(webview) = artifact_preview_webview(&app, &sidebar_state, generation)? else {
        return Ok(false);
    };
    let origin = current_preview_origin(&webview)?;
    let service = Arc::clone(&profile_state.service);
    let credential = tauri::async_runtime::spawn_blocking(move || {
        service.credential_for_fill(&origin, &credential_id)
    })
    .await
    .map_err(|error| format!("browser credential read task failed: {error}"))??
    .ok_or_else(|| "browser credential is unavailable for this origin".to_string())?;
    fill_preview_credential(&webview, &credential)?;
    Ok(true)
}

#[tauri::command]
pub(crate) async fn browser_credential_form_submitted(
    caller: Webview,
    app: AppHandle,
    sidebar_state: State<'_, SidebarBrowserState>,
    profile_state: State<'_, BrowserProfileState>,
    mut submission: BrowserCredentialSubmission,
) -> Result<bool, String> {
    let _operation = sidebar_state.operations.lock().await;
    let Some((generation, webview)) = artifact_preview_for_caller(&app, &sidebar_state, &caller)?
    else {
        return Err("credential submission is available only to artifact previews".to_string());
    };
    if !profile_state.service.preferences().ask_to_save_passwords {
        return Ok(false);
    }
    if !profile_state
        .credential_notifications
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .allow(
            caller.label(),
            CredentialNotificationKind::Submitted,
            Instant::now(),
        )
    {
        return Ok(false);
    }
    let origin = current_preview_origin(&webview)?;
    if normalize_https_origin(&submission.origin)? != origin {
        return Err("browser credential submission origin does not match its preview".to_string());
    }
    validate_credential_username(&submission.username)?;
    validate_credential_secret(&submission.password)?;
    let password = Zeroizing::new(std::mem::take(&mut submission.password));
    let existing = profile_state
        .service
        .credential_metadata_for_origin(&origin)?
        .into_iter()
        .any(|credential| credential.username == submission.username);
    let prompt_id = new_opaque_id()?;
    let prompt = PendingCredentialPrompt {
        generation,
        origin: origin.clone(),
        username: submission.username.clone(),
        secret: password,
        expires_at: Instant::now() + CREDENTIAL_PROMPT_TTL,
    };
    let queued = {
        let mut prompts = profile_state
            .pending_prompts
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        queue_pending_credential_prompt(&mut prompts, prompt_id.clone(), prompt, Instant::now())
    };
    if !queued {
        return Ok(false);
    }
    emit_to_privileged_shells(
        &app,
        BROWSER_SAVE_PASSWORD_PROMPT_EVENT,
        BrowserSavePasswordPromptEvent {
            prompt_id,
            generation,
            origin,
            username: submission.username.clone(),
            is_update: existing,
        },
    )?;
    Ok(true)
}

#[tauri::command]
pub(crate) async fn resolve_browser_credential_prompt(
    caller: Webview,
    app: AppHandle,
    sidebar_state: State<'_, SidebarBrowserState>,
    profile_state: State<'_, BrowserProfileState>,
    prompt_id: String,
    action: BrowserCredentialPromptAction,
) -> Result<Option<CredentialMetadata>, String> {
    ensure_main_caller(&caller)?;
    validate_credential_id(&prompt_id)?;
    let _operation = sidebar_state.operations.lock().await;
    let prompt = profile_state
        .pending_prompts
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .remove(&prompt_id);
    let Some(prompt) = prompt else {
        return Ok(None);
    };
    if prompt.expires_at <= Instant::now()
        || matches!(action, BrowserCredentialPromptAction::NotNow)
    {
        return Ok(None);
    }
    let Some(webview) = artifact_preview_webview(&app, &sidebar_state, prompt.generation)? else {
        return Ok(None);
    };
    if current_preview_origin(&webview)? != prompt.origin {
        return Ok(None);
    }
    let service = Arc::clone(&profile_state.service);
    tauri::async_runtime::spawn_blocking(move || {
        service.save_credential(prompt.origin, prompt.username, prompt.secret)
    })
    .await
    .map_err(|error| format!("browser credential save task failed: {error}"))?
    .map(Some)
}

impl BrowserProfileService {
    pub(crate) fn load(
        index: BrowserProfileIndexStore,
        vault: Arc<dyn CredentialVault>,
    ) -> Result<Self, String> {
        let document = index.load()?;
        Ok(Self {
            index,
            vault,
            document: Mutex::new(document),
        })
    }

    #[cfg(test)]
    pub(crate) fn index_path(&self) -> &Path {
        self.index.path()
    }

    pub(crate) fn list_credentials(&self) -> Vec<CredentialMetadata> {
        self.document
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .credentials
            .clone()
    }

    pub(crate) fn preferences(&self) -> BrowserPreferences {
        self.document
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .preferences
            .clone()
    }

    pub(crate) fn downloads(&self) -> Vec<DownloadRecord> {
        let mut downloads = self
            .document
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .downloads
            .clone();
        downloads.sort_by_key(|download| std::cmp::Reverse(download.started_at_unix_seconds));
        downloads
    }

    pub(crate) fn record_download_requested(
        &self,
        id: &str,
        source_url: &str,
        destination: &str,
        now_unix_seconds: u64,
    ) -> Result<DownloadRecord, String> {
        validate_download_id(id)?;
        let source_origin = download_source_origin(source_url)?;
        let path = PathBuf::from(destination);
        let file_name = path
            .file_name()
            .and_then(|name| name.to_str())
            .filter(|name| !name.is_empty())
            .ok_or_else(|| "browser download destination has no valid file name".to_string())?
            .to_string();
        let record = DownloadRecord {
            id: id.to_string(),
            source_origin,
            file_name,
            path: destination.to_string(),
            started_at_unix_seconds: now_unix_seconds,
            finished_at_unix_seconds: None,
            status: DownloadStatus::InProgress,
        };
        let mut current = self
            .document
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut next = current.clone();
        next.downloads.retain(|download| download.id != id);
        next.downloads.push(record.clone());
        self.index.save(&next)?;
        *current = next;
        Ok(record)
    }

    pub(crate) fn record_download_finished(
        &self,
        id: &str,
        path: Option<String>,
        success: bool,
        now_unix_seconds: u64,
    ) -> Result<bool, String> {
        validate_download_id(id)?;
        let mut current = self
            .document
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let Some(position) = current
            .downloads
            .iter()
            .position(|download| download.id == id)
        else {
            return Ok(false);
        };
        let mut next = current.clone();
        let download = &mut next.downloads[position];
        if let Some(path) = path.filter(|path| !path.is_empty()) {
            download.file_name = PathBuf::from(&path)
                .file_name()
                .and_then(|name| name.to_str())
                .filter(|name| !name.is_empty())
                .unwrap_or(&download.file_name)
                .to_string();
            download.path = path;
        }
        download.finished_at_unix_seconds = Some(now_unix_seconds);
        download.status = if success {
            DownloadStatus::Completed
        } else {
            DownloadStatus::Failed
        };
        self.index.save(&next)?;
        *current = next;
        Ok(true)
    }

    pub(crate) fn clear_download_history(&self) -> Result<(), String> {
        let mut current = self
            .document
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if current.downloads.is_empty() {
            return Ok(());
        }
        let mut next = current.clone();
        next.downloads.clear();
        self.index.save(&next)?;
        *current = next;
        Ok(())
    }

    pub(crate) fn update_preferences(&self, preferences: BrowserPreferences) -> Result<(), String> {
        let mut current = self
            .document
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut next = current.clone();
        next.preferences = preferences;
        self.index.save(&next)?;
        *current = next;
        Ok(())
    }

    pub(crate) fn delete_credential(&self, credential_id: &str) -> Result<bool, String> {
        validate_credential_id(credential_id)?;
        let mut current = self
            .document
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let Some(position) = current
            .credentials
            .iter()
            .position(|credential| credential.id == credential_id)
        else {
            return Ok(false);
        };
        let previous_secret = self.vault.get_secret(credential_id)?;
        self.vault.delete_secret(credential_id)?;
        let mut next = current.clone();
        next.credentials.remove(position);
        if let Err(index_error) = self.index.save(&next) {
            return match self.vault.set_secret(credential_id, &previous_secret) {
                Ok(()) => Err(index_error),
                Err(rollback_error) => Err(format!(
                    "{index_error}; failed to restore browser credential after metadata rollback: {rollback_error}"
                )),
            };
        }
        *current = next;
        Ok(true)
    }

    #[cfg(test)]
    pub(crate) fn credentials_for_origin(
        &self,
        origin: &str,
    ) -> Result<Vec<CredentialForAutofill>, String> {
        let origin = normalize_https_origin(origin)?;
        let mut matching = self
            .document
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .credentials
            .iter()
            .filter(|credential| credential.origin == origin)
            .cloned()
            .collect::<Vec<_>>();
        matching.sort_by_key(|credential| std::cmp::Reverse(credential.updated_at_unix_seconds));
        matching
            .into_iter()
            .map(|metadata| {
                self.vault
                    .get_secret(&metadata.id)
                    .map(|secret| CredentialForAutofill { metadata, secret })
            })
            .collect()
    }

    pub(crate) fn credential_metadata_for_origin(
        &self,
        origin: &str,
    ) -> Result<Vec<CredentialMetadata>, String> {
        let origin = normalize_https_origin(origin)?;
        let mut matching = self
            .document
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .credentials
            .iter()
            .filter(|credential| credential.origin == origin)
            .cloned()
            .collect::<Vec<_>>();
        matching.sort_by_key(|credential| std::cmp::Reverse(credential.updated_at_unix_seconds));
        Ok(matching)
    }

    pub(crate) fn credential_for_fill(
        &self,
        origin: &str,
        credential_id: &str,
    ) -> Result<Option<CredentialForAutofill>, String> {
        validate_credential_id(credential_id)?;
        let origin = normalize_https_origin(origin)?;
        let metadata = self
            .document
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .credentials
            .iter()
            .find(|credential| credential.id == credential_id && credential.origin == origin)
            .cloned();
        metadata
            .map(|metadata| {
                self.vault
                    .get_secret(&metadata.id)
                    .map(|secret| CredentialForAutofill { metadata, secret })
            })
            .transpose()
    }

    pub(crate) fn save_credential(
        &self,
        origin: String,
        username: String,
        secret: Zeroizing<String>,
    ) -> Result<CredentialMetadata, String> {
        self.save_credential_with_id(
            &new_opaque_id()?,
            &origin,
            &username,
            secret,
            unix_timestamp(),
        )
    }

    fn save_credential_with_id(
        &self,
        requested_id: &str,
        origin: &str,
        username: &str,
        secret: Zeroizing<String>,
        now_unix_seconds: u64,
    ) -> Result<CredentialMetadata, String> {
        validate_credential_id(requested_id)?;
        let origin = normalize_https_origin(origin)?;
        validate_credential_username(username)?;
        validate_credential_secret(&secret)?;

        let mut current = self
            .document
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let existing = current
            .credentials
            .iter()
            .position(|credential| credential.origin == origin && credential.username == username);
        let credential = existing
            .and_then(|position| current.credentials.get(position).cloned())
            .map(|credential| CredentialMetadata {
                updated_at_unix_seconds: now_unix_seconds,
                ..credential
            })
            .unwrap_or_else(|| CredentialMetadata {
                id: requested_id.to_string(),
                origin,
                username: username.to_string(),
                created_at_unix_seconds: now_unix_seconds,
                updated_at_unix_seconds: now_unix_seconds,
            });
        let previous_secret = existing.and_then(|_| self.vault.get_secret(&credential.id).ok());
        self.vault.set_secret(&credential.id, &secret)?;

        let mut next = current.clone();
        if let Some(position) = existing {
            next.credentials[position] = credential.clone();
        } else {
            next.credentials.push(credential.clone());
        }
        if let Err(error) = self.index.save(&next) {
            if let Some(previous_secret) = previous_secret {
                let _ = self
                    .vault
                    .set_secret(&credential.id, previous_secret.as_str());
            } else {
                let _ = self.vault.delete_secret(&credential.id);
            }
            return Err(error);
        }
        *current = next;
        Ok(credential)
    }
}

fn validate_credential_id(credential_id: &str) -> Result<(), String> {
    if credential_id.is_empty()
        || credential_id.len() > MAX_CREDENTIAL_ID_BYTES
        || !credential_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err("browser credential id is invalid".to_string());
    }
    Ok(())
}

fn validate_download_id(download_id: &str) -> Result<(), String> {
    validate_credential_id(download_id).map_err(|_| "browser download id is invalid".to_string())
}

fn download_source_origin(value: &str) -> Result<String, String> {
    let url =
        tauri::Url::parse(value).map_err(|_| "browser download URL is invalid".to_string())?;
    if url.scheme() == "blob" {
        return download_source_origin(url.path());
    }
    if matches!(url.scheme(), "http" | "https") && url.host_str().is_some() {
        return Ok(url.origin().ascii_serialization());
    }
    Ok("opaque".to_string())
}

fn normalize_https_origin(value: &str) -> Result<String, String> {
    let url =
        tauri::Url::parse(value).map_err(|_| "browser credential origin is invalid".to_string())?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("browser credentials require an HTTPS origin".to_string());
    }
    Ok(url.origin().ascii_serialization())
}

fn validate_credential_username(username: &str) -> Result<(), String> {
    if username.is_empty()
        || username.len() > MAX_CREDENTIAL_USERNAME_BYTES
        || username.contains('\0')
    {
        return Err("browser credential username is invalid".to_string());
    }
    Ok(())
}

fn validate_credential_secret(secret: &str) -> Result<(), String> {
    if secret.is_empty() || secret.len() > MAX_CREDENTIAL_SECRET_BYTES || secret.contains('\0') {
        return Err("browser credential password is invalid".to_string());
    }
    Ok(())
}

fn new_opaque_id() -> Result<String, String> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes)
        .map_err(|error| format!("failed to generate browser credential id: {error}"))?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

fn unix_timestamp() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

#[cfg(test)]
mod tests {
    use std::{
        collections::HashMap,
        sync::{Arc, Mutex},
        time::{Duration, Instant},
    };

    use zeroize::Zeroizing;

    use super::{
        active_download_key, queue_pending_credential_prompt, AutofillMode, BrowserPreferences,
        BrowserProfileDocument, BrowserProfileIndexStore, BrowserProfileService,
        BrowserSettingsSnapshot, CredentialMetadata, CredentialNotificationKind,
        CredentialNotificationLimiter, CredentialVault, DownloadStatus, PendingCredentialPrompt,
        SystemCredentialVault, MAX_PENDING_CREDENTIAL_PROMPTS,
    };

    #[derive(Default)]
    struct MemoryCredentialVault {
        secrets: Mutex<HashMap<String, String>>,
    }

    impl CredentialVault for MemoryCredentialVault {
        fn set_secret(&self, credential_id: &str, secret: &str) -> Result<(), String> {
            self.secrets
                .lock()
                .expect("memory vault should lock")
                .insert(credential_id.to_string(), secret.to_string());
            Ok(())
        }

        fn get_secret(&self, credential_id: &str) -> Result<Zeroizing<String>, String> {
            self.secrets
                .lock()
                .expect("memory vault should lock")
                .get(credential_id)
                .cloned()
                .map(Zeroizing::new)
                .ok_or_else(|| "credential not found".to_string())
        }

        fn delete_secret(&self, credential_id: &str) -> Result<(), String> {
            self.secrets
                .lock()
                .expect("memory vault should lock")
                .remove(credential_id);
            Ok(())
        }
    }

    #[test]
    fn browser_preferences_default_to_user_confirmed_autofill() {
        let preferences = BrowserPreferences::default();

        assert_eq!(preferences.autofill_mode, AutofillMode::Ask);
        assert!(preferences.ask_to_save_passwords);
    }

    #[test]
    fn credential_notifications_are_rate_limited_per_preview_and_kind() {
        let now = Instant::now();
        let mut limiter = CredentialNotificationLimiter::default();

        assert!(limiter.allow(
            "sidebar-browser-1",
            CredentialNotificationKind::Detected,
            now
        ));
        assert!(!limiter.allow(
            "sidebar-browser-1",
            CredentialNotificationKind::Detected,
            now + Duration::from_millis(499)
        ));
        assert!(limiter.allow(
            "sidebar-browser-1",
            CredentialNotificationKind::Detected,
            now + Duration::from_millis(500)
        ));
        assert!(limiter.allow(
            "sidebar-browser-2",
            CredentialNotificationKind::Detected,
            now
        ));

        assert!(limiter.allow(
            "sidebar-browser-1",
            CredentialNotificationKind::Submitted,
            now
        ));
        assert!(!limiter.allow(
            "sidebar-browser-1",
            CredentialNotificationKind::Submitted,
            now + Duration::from_millis(1_999)
        ));
        assert!(limiter.allow(
            "sidebar-browser-1",
            CredentialNotificationKind::Submitted,
            now + Duration::from_secs(2)
        ));
    }

    #[test]
    fn pending_credential_prompts_are_bounded_and_replace_duplicates() {
        let now = Instant::now();
        let mut prompts = HashMap::new();
        for index in 0..MAX_PENDING_CREDENTIAL_PROMPTS {
            assert!(queue_pending_credential_prompt(
                &mut prompts,
                format!("prompt-{index}"),
                PendingCredentialPrompt {
                    generation: index as u64,
                    origin: "https://example.com".to_string(),
                    username: format!("user-{index}@example.com"),
                    secret: Zeroizing::new(format!("password-{index}")),
                    expires_at: now + Duration::from_secs(60),
                },
                now,
            ));
        }
        assert_eq!(prompts.len(), MAX_PENDING_CREDENTIAL_PROMPTS);
        assert!(!queue_pending_credential_prompt(
            &mut prompts,
            "overflow".to_string(),
            PendingCredentialPrompt {
                generation: 999,
                origin: "https://example.com".to_string(),
                username: "overflow@example.com".to_string(),
                secret: Zeroizing::new("password".to_string()),
                expires_at: now + Duration::from_secs(60),
            },
            now,
        ));

        assert!(queue_pending_credential_prompt(
            &mut prompts,
            "replacement".to_string(),
            PendingCredentialPrompt {
                generation: 0,
                origin: "https://example.com".to_string(),
                username: "user-0@example.com".to_string(),
                secret: Zeroizing::new("new-password".to_string()),
                expires_at: now + Duration::from_secs(60),
            },
            now,
        ));
        assert_eq!(prompts.len(), MAX_PENDING_CREDENTIAL_PROMPTS);
        assert!(!prompts.contains_key("prompt-0"));
        assert_eq!(
            prompts
                .get("replacement")
                .expect("duplicate prompt should be replaced")
                .secret
                .as_str(),
            "new-password"
        );
    }

    #[test]
    fn simultaneous_downloads_with_the_same_url_are_scoped_to_their_webview() {
        let url = "https://example.com/download.zip";

        assert_ne!(
            active_download_key("sidebar-browser-1", url),
            active_download_key("sidebar-browser-2", url)
        );
        assert_eq!(
            active_download_key("sidebar-browser-1", url),
            active_download_key("sidebar-browser-1", url)
        );
    }

    #[test]
    fn credential_fills_hold_the_preview_operation_lease_across_vault_reads() {
        let source = include_str!("browser_profile.rs");
        for command_name in [
            "browser_credential_form_detected",
            "fill_browser_credential",
        ] {
            let command = source
                .split(&format!("pub(crate) async fn {command_name}"))
                .nth(1)
                .unwrap_or_else(|| panic!("{command_name} should exist"))
                .split("#[tauri::command]")
                .next()
                .expect("command should have a boundary");
            let lock = command
                .find("sidebar_state.operations.lock().await")
                .unwrap_or_else(|| panic!("{command_name} must acquire the preview lease"));
            let vault_read = command
                .find("credential_for_fill")
                .unwrap_or_else(|| panic!("{command_name} must read a credential for fill"));
            let fill = command
                .find("fill_preview_credential")
                .unwrap_or_else(|| panic!("{command_name} must fill the preview"));

            assert!(lock < vault_read && vault_read < fill);
        }
    }

    #[test]
    fn credential_metadata_serialization_never_contains_a_secret() {
        let metadata = CredentialMetadata {
            id: "credential-1".to_string(),
            origin: "https://example.com".to_string(),
            username: "user@example.com".to_string(),
            created_at_unix_seconds: 1,
            updated_at_unix_seconds: 2,
        };

        let serialized = serde_json::to_value(metadata).expect("metadata should serialize");

        assert_eq!(serialized["origin"], "https://example.com");
        assert_eq!(serialized["username"], "user@example.com");
        assert!(serialized.get("password").is_none());
        assert!(serialized.get("secret").is_none());
    }

    #[test]
    fn profile_index_round_trips_preferences_and_credential_metadata() {
        let directory = tempfile::tempdir().expect("temporary directory should exist");
        let path = directory.path().join("browser-profile.json");
        let store = BrowserProfileIndexStore::new(path);
        let document = BrowserProfileDocument {
            preferences: BrowserPreferences {
                autofill_mode: AutofillMode::Automatic,
                ask_to_save_passwords: false,
            },
            credentials: vec![CredentialMetadata {
                id: "credential-1".to_string(),
                origin: "https://example.com".to_string(),
                username: "user@example.com".to_string(),
                created_at_unix_seconds: 1,
                updated_at_unix_seconds: 2,
            }],
            downloads: Vec::new(),
        };

        store.save(&document).expect("profile index should save");
        let restored = store.load().expect("profile index should load");

        assert_eq!(restored, document);
        let raw = std::fs::read_to_string(store.path()).expect("profile index should be readable");
        assert!(!raw.contains("password"));
        assert!(!raw.contains("secret"));
    }

    #[test]
    fn missing_profile_index_loads_safe_defaults() {
        let directory = tempfile::tempdir().expect("temporary directory should exist");
        let store = BrowserProfileIndexStore::new(directory.path().join("missing.json"));

        assert_eq!(
            store.load().expect("missing profile should be valid"),
            BrowserProfileDocument::default()
        );
    }

    #[test]
    fn credential_service_keeps_secrets_in_the_vault_and_metadata_in_the_index() {
        let directory = tempfile::tempdir().expect("temporary directory should exist");
        let store = BrowserProfileIndexStore::new(directory.path().join("browser-profile.json"));
        let vault = Arc::new(MemoryCredentialVault::default());
        let service =
            BrowserProfileService::load(store, vault.clone()).expect("profile should load");

        let saved = service
            .save_credential_with_id(
                "credential-1",
                "https://example.com/login?token=private",
                "user@example.com",
                Zeroizing::new("correct horse battery staple".to_string()),
                10,
            )
            .expect("credential should save");

        assert_eq!(saved.origin, "https://example.com");
        assert_eq!(
            vault
                .get_secret("credential-1")
                .expect("secret should be in the vault")
                .as_str(),
            "correct horse battery staple"
        );
        let raw = std::fs::read_to_string(service.index_path())
            .expect("profile index should be readable");
        assert!(!raw.contains("correct horse battery staple"));
        assert_eq!(service.list_credentials(), vec![saved]);
    }

    #[test]
    fn credential_service_updates_an_existing_origin_and_username_without_duplicates() {
        let directory = tempfile::tempdir().expect("temporary directory should exist");
        let store = BrowserProfileIndexStore::new(directory.path().join("browser-profile.json"));
        let vault = Arc::new(MemoryCredentialVault::default());
        let service =
            BrowserProfileService::load(store, vault.clone()).expect("profile should load");

        let first = service
            .save_credential_with_id(
                "credential-1",
                "https://example.com",
                "user@example.com",
                Zeroizing::new("old password".to_string()),
                10,
            )
            .expect("credential should save");
        let updated = service
            .save_credential_with_id(
                "credential-2",
                "https://example.com/account",
                "user@example.com",
                Zeroizing::new("new password".to_string()),
                20,
            )
            .expect("credential should update");

        assert_eq!(updated.id, first.id);
        assert_eq!(updated.created_at_unix_seconds, 10);
        assert_eq!(updated.updated_at_unix_seconds, 20);
        assert_eq!(service.list_credentials(), vec![updated]);
        assert_eq!(
            vault
                .get_secret("credential-1")
                .expect("updated secret should remain in the vault")
                .as_str(),
            "new password"
        );
        assert!(vault.get_secret("credential-2").is_err());
    }

    #[test]
    fn credential_service_rejects_insecure_origins_and_invalid_ids() {
        let directory = tempfile::tempdir().expect("temporary directory should exist");
        let store = BrowserProfileIndexStore::new(directory.path().join("browser-profile.json"));
        let service =
            BrowserProfileService::load(store, Arc::new(MemoryCredentialVault::default()))
                .expect("profile should load");

        for origin in [
            "http://example.com",
            "javascript:alert(1)",
            "https://user:password@example.com",
        ] {
            assert!(
                service
                    .save_credential_with_id(
                        "credential-1",
                        origin,
                        "user@example.com",
                        Zeroizing::new("password".to_string()),
                        10,
                    )
                    .is_err(),
                "{origin} must be rejected"
            );
        }
        assert!(service
            .save_credential_with_id(
                "../credential",
                "https://example.com",
                "user@example.com",
                Zeroizing::new("password".to_string()),
                10,
            )
            .is_err());
    }

    #[test]
    fn native_vault_namespace_is_scoped_to_the_application_bundle() {
        let production = SystemCredentialVault::new("cloud.ardor.desktop");
        let stage1 = SystemCredentialVault::new("cloud.ardor.desktop.stage1");

        assert_eq!(
            production.service_name(),
            "cloud.ardor.desktop.artifact-browser.passwords.v1"
        );
        assert_eq!(
            stage1.service_name(),
            "cloud.ardor.desktop.stage1.artifact-browser.passwords.v1"
        );
        assert_ne!(production.service_name(), stage1.service_name());
    }

    #[test]
    fn preferences_update_persists_across_service_reloads() {
        let directory = tempfile::tempdir().expect("temporary directory should exist");
        let path = directory.path().join("browser-profile.json");
        let vault = Arc::new(MemoryCredentialVault::default());
        let service =
            BrowserProfileService::load(BrowserProfileIndexStore::new(path.clone()), vault.clone())
                .expect("profile should load");
        let preferences = BrowserPreferences {
            autofill_mode: AutofillMode::Automatic,
            ask_to_save_passwords: false,
        };

        service
            .update_preferences(preferences.clone())
            .expect("preferences should persist");
        let restored = BrowserProfileService::load(BrowserProfileIndexStore::new(path), vault)
            .expect("profile should reload");

        assert_eq!(restored.preferences(), preferences);
    }

    #[test]
    fn deleting_a_credential_removes_the_secret_and_metadata() {
        let directory = tempfile::tempdir().expect("temporary directory should exist");
        let store = BrowserProfileIndexStore::new(directory.path().join("browser-profile.json"));
        let vault = Arc::new(MemoryCredentialVault::default());
        let service =
            BrowserProfileService::load(store, vault.clone()).expect("profile should load");
        service
            .save_credential_with_id(
                "credential-1",
                "https://example.com",
                "user@example.com",
                Zeroizing::new("password".to_string()),
                10,
            )
            .expect("credential should save");

        assert!(service
            .delete_credential("credential-1")
            .expect("credential should delete"));

        assert!(service.list_credentials().is_empty());
        assert!(vault.get_secret("credential-1").is_err());
        assert!(!service
            .delete_credential("credential-1")
            .expect("missing credential delete should be idempotent"));
    }

    #[test]
    fn credential_deletion_restores_the_vault_when_metadata_persistence_fails() {
        let directory = tempfile::tempdir().expect("temporary directory should exist");
        let path = directory.path().join("browser-profile.json");
        let vault = Arc::new(MemoryCredentialVault::default());
        let service =
            BrowserProfileService::load(BrowserProfileIndexStore::new(path.clone()), vault.clone())
                .expect("profile should load");
        service
            .save_credential_with_id(
                "credential-1",
                "https://example.com",
                "user@example.com",
                Zeroizing::new("password".to_string()),
                10,
            )
            .expect("credential should save");
        std::fs::create_dir(path.with_extension("json.bak"))
            .expect("backup-directory failure fixture should exist");

        assert!(service.delete_credential("credential-1").is_err());
        assert_eq!(service.list_credentials().len(), 1);
        assert_eq!(
            vault
                .get_secret("credential-1")
                .expect("failed metadata update must restore the secret")
                .as_str(),
            "password"
        );
    }

    #[test]
    fn credential_prompt_resolution_revalidates_its_live_generation_and_origin() {
        let source = include_str!("browser_profile.rs");
        let command = source
            .split("pub(crate) async fn resolve_browser_credential_prompt")
            .nth(1)
            .expect("prompt resolver should exist")
            .split("impl BrowserProfileService")
            .next()
            .expect("prompt resolver should have a boundary");
        let lock = command
            .find("sidebar_state.operations.lock().await")
            .expect("prompt resolver must hold the preview operation lease");
        let preview = command
            .find("artifact_preview_webview")
            .expect("prompt resolver must revalidate its artifact generation");
        let origin = command
            .find("current_preview_origin")
            .expect("prompt resolver must revalidate its HTTPS origin");
        let save = command
            .find("save_credential")
            .expect("prompt resolver must retain its save operation");

        assert!(lock < preview && preview < origin && origin < save);
    }

    #[test]
    fn settings_snapshot_exposes_only_non_secret_browser_state() {
        let snapshot = BrowserSettingsSnapshot {
            password_storage_supported: true,
            preferences: BrowserPreferences::default(),
            credentials: vec![CredentialMetadata {
                id: "credential-1".to_string(),
                origin: "https://example.com".to_string(),
                username: "user@example.com".to_string(),
                created_at_unix_seconds: 1,
                updated_at_unix_seconds: 2,
            }],
            downloads: Vec::new(),
        };

        let serialized = serde_json::to_value(snapshot).expect("snapshot should serialize");

        assert_eq!(serialized["passwordStorageSupported"], true);
        assert_eq!(serialized["credentials"][0]["username"], "user@example.com");
        assert!(serialized["credentials"][0].get("password").is_none());
        assert!(serialized["credentials"][0].get("secret").is_none());
    }

    #[test]
    fn autofill_lookup_is_bound_to_the_exact_https_origin() {
        let directory = tempfile::tempdir().expect("temporary directory should exist");
        let store = BrowserProfileIndexStore::new(directory.path().join("browser-profile.json"));
        let vault = Arc::new(MemoryCredentialVault::default());
        let service = BrowserProfileService::load(store, vault).expect("profile should load");
        service
            .save_credential_with_id(
                "credential-1",
                "https://login.example.com",
                "user@example.com",
                Zeroizing::new("password".to_string()),
                10,
            )
            .expect("credential should save");

        let matching = service
            .credentials_for_origin("https://login.example.com/session")
            .expect("matching origin should load");

        assert_eq!(matching.len(), 1);
        assert_eq!(matching[0].metadata.id, "credential-1");
        assert_eq!(matching[0].secret.as_str(), "password");
        assert!(service
            .credentials_for_origin("https://example.com")
            .expect("different origin should be valid")
            .is_empty());
        assert!(service
            .credentials_for_origin("http://login.example.com")
            .is_err());
    }

    #[test]
    fn download_history_persists_status_without_sensitive_url_details() {
        let directory = tempfile::tempdir().expect("temporary directory should exist");
        let path = directory.path().join("browser-profile.json");
        let vault = Arc::new(MemoryCredentialVault::default());
        let service =
            BrowserProfileService::load(BrowserProfileIndexStore::new(path.clone()), vault.clone())
                .expect("profile should load");

        service
            .record_download_requested(
                "download-1",
                "https://example.com/private/file.zip?token=secret",
                "/downloads/file.zip",
                10,
            )
            .expect("download request should persist");
        service
            .record_download_finished(
                "download-1",
                Some("/downloads/file.zip".to_string()),
                true,
                20,
            )
            .expect("download completion should persist");

        let downloads = service.downloads();
        assert_eq!(downloads.len(), 1);
        assert_eq!(downloads[0].source_origin, "https://example.com");
        assert_eq!(downloads[0].status, DownloadStatus::Completed);
        assert_eq!(downloads[0].finished_at_unix_seconds, Some(20));
        let raw = std::fs::read_to_string(path).expect("download history should persist");
        assert!(!raw.contains("token=secret"));

        let restored = BrowserProfileService::load(
            BrowserProfileIndexStore::new(service.index_path().into()),
            vault,
        )
        .expect("profile should reload");
        assert_eq!(restored.downloads(), downloads);
    }

    #[test]
    fn download_history_reduces_blob_and_data_urls_to_non_sensitive_origins() {
        let directory = tempfile::tempdir().expect("temporary directory should exist");
        let service = BrowserProfileService::load(
            BrowserProfileIndexStore::new(directory.path().join("browser-profile.json")),
            Arc::new(MemoryCredentialVault::default()),
        )
        .expect("profile should load");

        let blob = service
            .record_download_requested(
                "download-blob",
                "blob:https://example.com/private-id",
                "/downloads/blob.bin",
                10,
            )
            .expect("blob download should persist");
        let opaque = service
            .record_download_requested(
                "download-data",
                "data:text/plain,private-content",
                "/downloads/data.txt",
                20,
            )
            .expect("data download should persist");

        assert_eq!(blob.source_origin, "https://example.com");
        assert_eq!(opaque.source_origin, "opaque");
        let raw = std::fs::read_to_string(service.index_path()).expect("history should persist");
        assert!(!raw.contains("private-id"));
        assert!(!raw.contains("private-content"));
    }
}
