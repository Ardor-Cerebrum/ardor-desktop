use std::{
    net::{IpAddr, Ipv4Addr, Ipv6Addr},
    sync::Mutex,
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State, Webview};

#[cfg(not(windows))]
use tauri::{
    webview::{DownloadEvent, NewWindowResponse, WebviewBuilder},
    LogicalPosition, LogicalSize, WebviewUrl,
};

#[cfg(windows)]
mod windows_composition;

const MAIN_WEBVIEW_LABEL: &str = "main";
const SIDEBAR_BROWSER_LABEL_PREFIX: &str = "sidebar-browser-";
const DEVICE_PERMISSION_DEFENSE_IN_DEPTH: &str = r#"
(() => {
  const denied = () => Promise.reject(new DOMException('Device access is disabled in preview.', 'NotAllowedError'));
  try {
    if (navigator.mediaDevices) {
      Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
        configurable: false,
        value: denied,
        writable: false,
      });
    }
  } catch (_) {}
  try {
    const geolocation = navigator.geolocation;
    if (geolocation) {
      const fail = (_success, error) => error?.({ code: 1, message: 'Device access is disabled in preview.' });
      Object.defineProperties(geolocation, {
        getCurrentPosition: { configurable: false, value: fail, writable: false },
        watchPosition: { configurable: false, value: (...args) => { fail(...args); return 0; }, writable: false },
      });
    }
  } catch (_) {}
})();
"#;

#[derive(Default)]
pub(crate) struct SidebarBrowserState {
    operations: tauri::async_runtime::Mutex<()>,
    lifecycle: Mutex<BrowserLifecycle>,
}

#[derive(Default)]
struct BrowserLifecycle {
    next_generation: u64,
    active: Option<ActiveBrowser>,
}

#[derive(Clone)]
struct ActiveBrowser {
    generation: u64,
    #[cfg_attr(windows, allow(dead_code))]
    label: String,
    last_bounds: BrowserBounds,
    visible: bool,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BrowserBounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BrowserOverlay {
    bounds: BrowserBounds,
    corner_radius: f64,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
enum BrowserSource {
    Artifact,
    Solution,
}

impl BrowserSource {
    fn as_str(self) -> &'static str {
        match self {
            Self::Artifact => "artifact",
            Self::Solution => "solution",
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OpenSidebarBrowserRequest {
    url: String,
    source: BrowserSource,
    bounds: BrowserBounds,
    #[serde(default)]
    overlays: Vec<BrowserOverlay>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OpenSidebarBrowserResponse {
    generation: u64,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum SidebarBrowserAction {
    Back,
    Forward,
    Reload,
    OpenExternal,
}

impl BrowserBounds {
    fn validate(self, visible: bool) -> Result<Self, String> {
        if ![self.x, self.y, self.width, self.height]
            .into_iter()
            .all(f64::is_finite)
        {
            return Err("sidebar browser bounds must be finite".to_string());
        }
        if self.x < 0.0 || self.y < 0.0 || self.width < 0.0 || self.height < 0.0 {
            return Err("sidebar browser bounds cannot be negative".to_string());
        }
        if visible && (self.width < 1.0 || self.height < 1.0) {
            return Err("visible sidebar browser bounds must have a positive size".to_string());
        }
        Ok(self)
    }

    #[cfg(not(windows))]
    fn position(self) -> LogicalPosition<f64> {
        LogicalPosition::new(self.x, self.y)
    }

    #[cfg(not(windows))]
    fn size(self) -> LogicalSize<f64> {
        LogicalSize::new(self.width, self.height)
    }
}

fn validate_overlays(overlays: Vec<BrowserOverlay>) -> Result<Vec<BrowserOverlay>, String> {
    const MAX_OVERLAYS: usize = 32;
    if overlays.len() > MAX_OVERLAYS {
        return Err(format!(
            "sidebar browser supports at most {MAX_OVERLAYS} overlay regions"
        ));
    }

    overlays
        .into_iter()
        .map(|overlay| {
            let bounds = overlay.bounds.validate(false)?;
            if !overlay.corner_radius.is_finite() || overlay.corner_radius < 0.0 {
                return Err(
                    "sidebar browser overlay corner radius must be finite and non-negative"
                        .to_string(),
                );
            }
            Ok(BrowserOverlay {
                bounds,
                corner_radius: overlay.corner_radius,
            })
        })
        .collect()
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum SidebarBrowserInputKind {
    Focus,
    FocusNext,
    FocusPrevious,
    Move,
    Leave,
    LeftDown,
    LeftUp,
    LeftDoubleClick,
    RightDown,
    RightUp,
    RightDoubleClick,
    MiddleDown,
    MiddleUp,
    MiddleDoubleClick,
    XDown,
    XUp,
    XDoubleClick,
    Wheel,
    HorizontalWheel,
}

impl SidebarBrowserInputKind {
    #[cfg(windows)]
    fn focus_reason(
        self,
    ) -> Option<webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_MOVE_FOCUS_REASON> {
        use webview2_com::Microsoft::Web::WebView2::Win32::*;

        match self {
            Self::Focus => Some(COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC),
            Self::FocusNext => Some(COREWEBVIEW2_MOVE_FOCUS_REASON_NEXT),
            Self::FocusPrevious => Some(COREWEBVIEW2_MOVE_FOCUS_REASON_PREVIOUS),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) struct SidebarBrowserInput {
    kind: SidebarBrowserInputKind,
    x: f64,
    y: f64,
    #[serde(default)]
    #[cfg_attr(windows, allow(dead_code))]
    mouse_data: i32,
    #[serde(default)]
    buttons: u16,
    #[serde(default)]
    #[cfg_attr(windows, allow(dead_code))]
    control: bool,
    #[serde(default)]
    #[cfg_attr(windows, allow(dead_code))]
    shift: bool,
}

impl SidebarBrowserInput {
    fn validate(self) -> Result<Self, String> {
        if !self.x.is_finite() || !self.y.is_finite() {
            return Err("sidebar browser input coordinates must be finite".to_string());
        }
        if self.buttons & !31 != 0 {
            return Err("sidebar browser input contains unsupported button flags".to_string());
        }
        Ok(self)
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SidebarBrowserInputResponse {
    accepted: bool,
    cursor: &'static str,
}

impl SidebarBrowserInputResponse {
    #[cfg(windows)]
    fn accepted(cursor: &'static str) -> Self {
        Self {
            accepted: true,
            cursor,
        }
    }

    fn ignored() -> Self {
        Self {
            accepted: false,
            cursor: "default",
        }
    }
}

impl BrowserLifecycle {
    fn begin_open(&mut self, bounds: BrowserBounds) -> (ActiveBrowser, Option<ActiveBrowser>) {
        self.next_generation = self.next_generation.saturating_add(1);
        let generation = self.next_generation;
        let next = ActiveBrowser {
            generation,
            label: format!("{SIDEBAR_BROWSER_LABEL_PREFIX}{generation}"),
            last_bounds: bounds,
            visible: true,
        };
        (next, self.active.take())
    }

    fn install(&mut self, browser: ActiveBrowser) {
        self.active = Some(browser);
    }

    fn snapshot(&self, generation: u64) -> Option<ActiveBrowser> {
        self.active
            .as_ref()
            .filter(|browser| browser.generation == generation)
            .cloned()
    }

    fn take(&mut self, generation: u64) -> Option<ActiveBrowser> {
        if self
            .active
            .as_ref()
            .is_some_and(|browser| browser.generation == generation)
        {
            self.active.take()
        } else {
            None
        }
    }
}

pub(crate) fn is_sidebar_browser_label(label: &str) -> bool {
    label.starts_with(SIDEBAR_BROWSER_LABEL_PREFIX)
}

pub(crate) fn is_allowed_sidebar_navigation(url: &tauri::Url) -> bool {
    is_public_https_url(url)
        || matches!(url.scheme(), "blob" | "data")
        || (url.scheme() == "about" && url.path() == "blank")
}

pub(crate) fn describe_navigation(url: &tauri::Url) -> String {
    let host = url.host_str().unwrap_or("<none>");
    match url.port() {
        Some(port) => format!("{}://{host}:{port}", url.scheme()),
        None => format!("{}://{host}", url.scheme()),
    }
}

fn is_public_https_url(url: &tauri::Url) -> bool {
    if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() {
        return false;
    }

    let Some(host) = url.host_str() else {
        return false;
    };
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    if host == "localhost" || host.ends_with(".localhost") || host.ends_with(".local") {
        return false;
    }

    let literal_host = host.trim_start_matches('[').trim_end_matches(']');
    match literal_host.parse::<IpAddr>() {
        Ok(IpAddr::V4(address)) => is_public_ipv4(address),
        Ok(IpAddr::V6(address)) => is_public_ipv6(address),
        Err(_) => true,
    }
}

fn is_public_ipv4(address: Ipv4Addr) -> bool {
    let octets = address.octets();
    !(address.is_private()
        || address.is_loopback()
        || address.is_link_local()
        || address.is_unspecified()
        || address.is_multicast()
        || address.is_broadcast()
        || octets[0] == 0
        || (octets[0] == 100 && (64..=127).contains(&octets[1]))
        || (octets[0] == 192 && octets[1] == 0 && octets[2] == 0)
        || (octets[0] == 198 && (18..=19).contains(&octets[1]))
        || octets[0] >= 240)
}

fn is_public_ipv6(address: Ipv6Addr) -> bool {
    if let Some(mapped) = address.to_ipv4_mapped() {
        return is_public_ipv4(mapped);
    }
    !(address.is_loopback()
        || address.is_unspecified()
        || address.is_multicast()
        || address.is_unique_local()
        || address.is_unicast_link_local())
}

fn ensure_main_caller(caller: &Webview) -> Result<(), String> {
    if caller.label() == MAIN_WEBVIEW_LABEL {
        Ok(())
    } else {
        Err("sidebar browser commands are available only to the main webview".to_string())
    }
}

fn lifecycle_lock(state: &SidebarBrowserState) -> std::sync::MutexGuard<'_, BrowserLifecycle> {
    state
        .lifecycle
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[cfg(not(windows))]
async fn close_browser(
    _caller: &Webview,
    app: &AppHandle,
    browser: &ActiveBrowser,
) -> Result<(), String> {
    if let Some(webview) = app.get_webview(&browser.label) {
        let _ = webview.hide();
        webview.close().map_err(|error| {
            format!(
                "failed to close sidebar browser generation {}: {error}",
                browser.generation
            )
        })?;
    }
    Ok(())
}

#[cfg(windows)]
async fn close_browser(
    caller: &Webview,
    _app: &AppHandle,
    browser: &ActiveBrowser,
) -> Result<(), String> {
    let _ = windows_composition::close(caller, browser.generation).await?;
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn open_sidebar_browser(
    caller: Webview,
    app: AppHandle,
    state: State<'_, SidebarBrowserState>,
    request: OpenSidebarBrowserRequest,
) -> Result<OpenSidebarBrowserResponse, String> {
    ensure_main_caller(&caller)?;
    let bounds = request.bounds.validate(true)?;
    let overlays = validate_overlays(request.overlays)?;
    let url =
        tauri::Url::parse(&request.url).map_err(|_| "invalid sidebar browser URL".to_string())?;
    if !is_public_https_url(&url) {
        return Err("sidebar browser initial URL must be a public HTTPS URL".to_string());
    }

    let _operation = state.operations.lock().await;
    let (next, previous) = lifecycle_lock(&state).begin_open(bounds);
    if let Some(previous) = previous.as_ref() {
        if let Err(error) = close_browser(&caller, &app, previous).await {
            lifecycle_lock(&state).install(previous.clone());
            return Err(error);
        }
    }

    let window = app
        .get_window(MAIN_WEBVIEW_LABEL)
        .ok_or_else(|| "main desktop window is unavailable".to_string())?;

    #[cfg(windows)]
    {
        let hwnd = window
            .hwnd()
            .map_err(|error| format!("failed to read the main desktop window handle: {error}"))?;
        let scale_factor = window
            .scale_factor()
            .map_err(|error| format!("failed to read the main desktop scale factor: {error}"))?;
        windows_composition::open(
            &caller,
            next.generation,
            hwnd.0 as isize,
            bounds,
            overlays,
            scale_factor,
            url.to_string(),
        )
        .await?;
    }

    #[cfg(not(windows))]
    {
        let _ = &overlays;
        let label = next.label.clone();
        let builder = WebviewBuilder::new(label, WebviewUrl::External(url.clone()))
            .incognito(true)
            .initialization_script_for_all_frames(DEVICE_PERMISSION_DEFENSE_IN_DEPTH)
            .on_navigation(is_allowed_sidebar_navigation)
            .on_new_window(|_, _| NewWindowResponse::Deny)
            .on_download(|_, event| !matches!(event, DownloadEvent::Requested { .. }));

        window
            .add_child(builder, bounds.position(), bounds.size())
            .map_err(|error| format!("failed to create sidebar browser: {error}"))?;
    }
    lifecycle_lock(&state).install(next.clone());

    eprintln!(
        "Opened {} sidebar browser generation {} at {}",
        request.source.as_str(),
        next.generation,
        describe_navigation(&url)
    );
    Ok(OpenSidebarBrowserResponse {
        generation: next.generation,
    })
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn layout_sidebar_browser(
    caller: Webview,
    app: AppHandle,
    state: State<'_, SidebarBrowserState>,
    generation: u64,
    bounds: BrowserBounds,
    visible: bool,
    overlays: Vec<BrowserOverlay>,
) -> Result<bool, String> {
    ensure_main_caller(&caller)?;
    let bounds = bounds.validate(visible)?;
    let overlays = validate_overlays(overlays)?;
    let _operation = state.operations.lock().await;
    let Some(snapshot) = lifecycle_lock(&state).snapshot(generation) else {
        return Ok(false);
    };
    #[cfg(windows)]
    let _ = &snapshot;
    #[cfg(not(windows))]
    if snapshot.last_bounds == bounds && snapshot.visible == visible {
        return Ok(true);
    }

    #[cfg(windows)]
    {
        let window = app
            .get_window(MAIN_WEBVIEW_LABEL)
            .ok_or_else(|| "main desktop window is unavailable".to_string())?;
        let scale_factor = window
            .scale_factor()
            .map_err(|error| format!("failed to read the main desktop scale factor: {error}"))?;
        if !windows_composition::layout(
            &caller,
            generation,
            bounds,
            visible,
            overlays,
            scale_factor,
        )
        .await?
        {
            return Ok(false);
        }
    }

    #[cfg(not(windows))]
    {
        let _ = &overlays;
        let Some(webview) = app.get_webview(&snapshot.label) else {
            return Ok(false);
        };
        if snapshot.last_bounds != bounds && bounds.width >= 1.0 && bounds.height >= 1.0 {
            webview
                .set_bounds(tauri::Rect {
                    position: tauri::Position::Logical(bounds.position()),
                    size: tauri::Size::Logical(bounds.size()),
                })
                .map_err(|error| format!("failed to position sidebar browser: {error}"))?;
        }
        if snapshot.visible != visible {
            if visible {
                webview.show()
            } else {
                webview.hide()
            }
            .map_err(|error| format!("failed to change sidebar browser visibility: {error}"))?;
        }
    }

    let mut lifecycle = lifecycle_lock(&state);
    let Some(active) = lifecycle.active.as_mut() else {
        return Ok(false);
    };
    if active.generation != generation {
        return Ok(false);
    }
    active.last_bounds = bounds;
    active.visible = visible;
    Ok(true)
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn control_sidebar_browser(
    caller: Webview,
    app: AppHandle,
    state: State<'_, SidebarBrowserState>,
    generation: u64,
    action: SidebarBrowserAction,
) -> Result<bool, String> {
    ensure_main_caller(&caller)?;
    let _operation = state.operations.lock().await;
    let Some(snapshot) = lifecycle_lock(&state).snapshot(generation) else {
        return Ok(false);
    };
    #[cfg(windows)]
    let _ = (&app, &snapshot);

    #[cfg(windows)]
    {
        if !windows_composition::control(&caller, generation, action).await? {
            return Ok(false);
        }
    }

    #[cfg(not(windows))]
    {
        let Some(webview) = app.get_webview(&snapshot.label) else {
            return Ok(false);
        };

        match action {
            SidebarBrowserAction::Back => webview
                .eval("window.history.back()")
                .map_err(|error| format!("failed to navigate sidebar browser back: {error}"))?,
            SidebarBrowserAction::Forward => webview
                .eval("window.history.forward()")
                .map_err(|error| format!("failed to navigate sidebar browser forward: {error}"))?,
            SidebarBrowserAction::Reload => webview
                .reload()
                .map_err(|error| format!("failed to reload sidebar browser: {error}"))?,
            SidebarBrowserAction::OpenExternal => {
                let url = webview
                    .url()
                    .map_err(|error| format!("failed to read sidebar browser URL: {error}"))?;
                if !is_public_https_url(&url) {
                    return Err("refusing to open a non-public sidebar browser URL".to_string());
                }
                crate::open_external_url(url.as_str())?;
            }
        }
    }
    Ok(true)
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn input_sidebar_browser(
    caller: Webview,
    state: State<'_, SidebarBrowserState>,
    generation: u64,
    input: SidebarBrowserInput,
) -> Result<SidebarBrowserInputResponse, String> {
    ensure_main_caller(&caller)?;
    let input = input.validate()?;
    if lifecycle_lock(&state).snapshot(generation).is_none() {
        return Ok(SidebarBrowserInputResponse::ignored());
    }

    #[cfg(windows)]
    {
        windows_composition::input(&caller, generation, input).await
    }

    #[cfg(not(windows))]
    {
        let _ = input;
        Ok(SidebarBrowserInputResponse::ignored())
    }
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn close_sidebar_browser(
    caller: Webview,
    app: AppHandle,
    state: State<'_, SidebarBrowserState>,
    generation: u64,
) -> Result<bool, String> {
    ensure_main_caller(&caller)?;
    let _operation = state.operations.lock().await;
    let Some(browser) = lifecycle_lock(&state).take(generation) else {
        return Ok(false);
    };
    if let Err(error) = close_browser(&caller, &app, &browser).await {
        lifecycle_lock(&state).install(browser);
        return Err(error);
    }
    Ok(true)
}

#[cfg(windows)]
pub(crate) fn notify_sidebar_browser_parent_moved() {
    windows_composition::notify_parent_window_position_changed();
}

#[cfg(test)]
mod tests {
    use super::{
        describe_navigation, is_allowed_sidebar_navigation, is_public_https_url, validate_overlays,
        BrowserBounds, BrowserLifecycle, BrowserOverlay,
    };

    fn url(value: &str) -> tauri::Url {
        tauri::Url::parse(value).expect("test URL should parse")
    }

    fn bounds(x: f64) -> BrowserBounds {
        BrowserBounds {
            x,
            y: 10.0,
            width: 800.0,
            height: 600.0,
        }
    }

    #[test]
    fn initial_navigation_accepts_only_public_https_urls() {
        for allowed in [
            "https://example.com/preview?token=secret",
            "https://artifact.ardor.build:8443/preview",
            "https://8.8.8.8/",
            "https://[2606:4700:4700::1111]/",
        ] {
            assert!(is_public_https_url(&url(allowed)), "rejected {allowed}");
        }

        for blocked in [
            "http://example.com/",
            "https://localhost/",
            "https://preview.local/",
            "https://127.0.0.1/",
            "https://10.0.0.1/",
            "https://100.64.0.1/",
            "https://169.254.1.1/",
            "https://[::1]/",
            "https://[::ffff:127.0.0.1]/",
            "https://[fe80::1]/",
            "https://user:password@example.com/",
            "file:///tmp/preview.html",
        ] {
            assert!(!is_public_https_url(&url(blocked)), "accepted {blocked}");
        }
    }

    #[test]
    fn in_page_navigation_allows_isolated_document_schemes_but_not_privileged_schemes() {
        for allowed in [
            "about:blank",
            "blob:https://example.com/id",
            "data:text/html,preview",
            "https://example.com/path",
        ] {
            assert!(
                is_allowed_sidebar_navigation(&url(allowed)),
                "rejected {allowed}"
            );
        }
        for blocked in [
            "http://example.com/",
            "file:///tmp/preview.html",
            "javascript:alert(1)",
            "tauri://localhost/",
            "https://127.0.0.1/",
        ] {
            assert!(
                !is_allowed_sidebar_navigation(&url(blocked)),
                "accepted {blocked}"
            );
        }
    }

    #[test]
    fn redacted_navigation_description_never_contains_path_query_or_fragment() {
        let description = describe_navigation(&url(
            "https://artifact.ardor.build:8443/private/path?token=secret#fragment",
        ));
        assert_eq!(description, "https://artifact.ardor.build:8443");
    }

    #[test]
    fn generations_make_stale_cleanup_and_layout_no_ops() {
        let mut lifecycle = BrowserLifecycle::default();
        let (first, previous) = lifecycle.begin_open(bounds(1.0));
        assert!(previous.is_none());
        lifecycle.install(first.clone());

        let (second, previous) = lifecycle.begin_open(bounds(2.0));
        assert_eq!(
            previous
                .expect("first browser should be replaced")
                .generation,
            1
        );
        lifecycle.install(second.clone());

        assert!(lifecycle.snapshot(first.generation).is_none());
        assert!(lifecycle.take(first.generation).is_none());
        assert_eq!(
            lifecycle
                .snapshot(second.generation)
                .expect("latest generation should stay active")
                .label,
            "sidebar-browser-2"
        );
    }

    #[test]
    fn repeated_replacement_keeps_only_constant_size_lifecycle_state() {
        let mut lifecycle = BrowserLifecycle::default();
        for expected_generation in 1..=100 {
            let (next, previous) = lifecycle.begin_open(bounds(expected_generation as f64));
            assert_eq!(next.generation, expected_generation);
            assert_eq!(
                previous.as_ref().map(|browser| browser.generation),
                expected_generation
                    .checked_sub(1)
                    .filter(|generation| *generation > 0)
            );
            lifecycle.install(next);
        }

        let active = lifecycle
            .active
            .expect("latest browser should remain active");
        assert_eq!(active.generation, 100);
        assert_eq!(active.label, "sidebar-browser-100");
    }

    #[test]
    fn bounds_reject_nan_infinity_and_non_positive_sizes() {
        assert!(bounds(0.0).validate(true).is_ok());
        assert!(BrowserBounds {
            width: 0.0,
            ..bounds(0.0)
        }
        .validate(true)
        .is_err());
        assert!(BrowserBounds {
            width: 0.0,
            height: 0.0,
            ..bounds(0.0)
        }
        .validate(false)
        .is_ok());
        assert!(BrowserBounds {
            x: f64::NAN,
            ..bounds(0.0)
        }
        .validate(true)
        .is_err());
        assert!(BrowserBounds {
            height: f64::INFINITY,
            ..bounds(0.0)
        }
        .validate(false)
        .is_err());
    }

    #[test]
    fn overlays_reject_unbounded_or_invalid_region_lists() {
        let valid = BrowserOverlay {
            bounds: bounds(0.0),
            corner_radius: 12.0,
        };
        assert_eq!(
            validate_overlays(vec![valid]).expect("valid overlay"),
            vec![valid]
        );
        assert!(validate_overlays(vec![valid; 33]).is_err());
        assert!(validate_overlays(vec![BrowserOverlay {
            corner_radius: f64::NAN,
            ..valid
        }])
        .is_err());
        assert!(validate_overlays(vec![BrowserOverlay {
            corner_radius: -1.0,
            ..valid
        }])
        .is_err());
    }
}
