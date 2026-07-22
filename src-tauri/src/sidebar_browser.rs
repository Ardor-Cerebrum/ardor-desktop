use std::{
    net::{IpAddr, Ipv4Addr, Ipv6Addr},
    sync::Mutex,
};

use serde::{Deserialize, Serialize};
use tauri::State;

#[cfg(not(windows))]
use cef::{ImplBrowser as _, ImplBrowserHost as _};

#[cfg(not(windows))]
use tauri::Manager;

use crate::runtime::{DesktopAppHandle as AppHandle, DesktopWebview as Webview};

#[cfg(not(windows))]
use tauri::{
    webview::{DownloadEvent, NewWindowResponse, WebviewBuilder},
    LogicalPosition, LogicalSize, WebviewUrl,
};

mod windows_gpu_compositor;

#[cfg(windows)]
pub(crate) use windows_gpu_compositor::start_device_recovery_coordinator;
pub(crate) use windows_gpu_compositor::AcceleratedCompositorState;
#[cfg(windows)]
pub(crate) use windows_gpu_compositor::{
    shell_label as compositor_shell_label, window_label as compositor_window_label,
};

#[cfg(target_os = "macos")]
mod macos_child;

const MAIN_WEBVIEW_LABEL: &str = "main";
const SIDEBAR_BROWSER_LABEL_PREFIX: &str = "sidebar-browser-";
const MAX_FIND_QUERY_BYTES: usize = 4 * 1024;
const MIN_ZOOM_FACTOR: f64 = 0.25;
const MAX_ZOOM_FACTOR: f64 = 5.0;
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
    compositor: AcceleratedCompositorState,
}

impl SidebarBrowserState {
    #[cfg(windows)]
    pub(crate) async fn start_compositor(&self, app: &AppHandle) -> Result<u64, String> {
        self.compositor.start(app).await
    }
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

#[cfg(any(target_os = "macos", test))]
#[derive(Clone, Copy, Debug, PartialEq)]
struct BrowserOverlayCutout {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    corner_radius: f64,
}

#[cfg(any(target_os = "macos", test))]
impl BrowserOverlayCutout {
    fn contains(self, x: f64, y: f64) -> bool {
        let right = self.x + self.width;
        let bottom = self.y + self.height;
        if x < self.x || x > right || y < self.y || y > bottom {
            return false;
        }

        let radius = self
            .corner_radius
            .min(self.width / 2.0)
            .min(self.height / 2.0);
        if radius <= 0.0
            || (x >= self.x + radius && x <= right - radius)
            || (y >= self.y + radius && y <= bottom - radius)
        {
            return true;
        }

        let center_x = if x < self.x + radius {
            self.x + radius
        } else {
            right - radius
        };
        let center_y = if y < self.y + radius {
            self.y + radius
        } else {
            bottom - radius
        };
        let dx = x - center_x;
        let dy = y - center_y;
        dx * dx + dy * dy <= radius * radius
    }
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
    Find,
    Forward,
    Reload,
    Navigate,
    OpenExternal,
    OpenDevTools,
    Print,
    SetZoom,
    StopFind,
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

#[cfg(any(target_os = "macos", test))]
fn dom_top_to_native_y(
    native_origin_y: f64,
    native_height: f64,
    dom_y: f64,
    dom_height: f64,
    is_flipped: bool,
) -> f64 {
    if is_flipped {
        native_origin_y + dom_y
    } else {
        native_origin_y + native_height - dom_y - dom_height
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

fn validate_find_query(query: Option<&str>) -> Result<&str, String> {
    let query = query.ok_or_else(|| "sidebar browser find requires a query".to_string())?;
    if query.is_empty() {
        return Err("sidebar browser find query cannot be empty".to_string());
    }
    if query.len() > MAX_FIND_QUERY_BYTES {
        return Err("sidebar browser find query exceeds the size limit".to_string());
    }
    Ok(query)
}

fn validate_zoom_factor(zoom_factor: Option<f64>) -> Result<f64, String> {
    let zoom_factor = zoom_factor
        .filter(|factor| factor.is_finite())
        .ok_or_else(|| "sidebar browser zoom requires a finite factor".to_string())?;
    if !(MIN_ZOOM_FACTOR..=MAX_ZOOM_FACTOR).contains(&zoom_factor) {
        return Err(format!(
            "sidebar browser zoom factor must be between {MIN_ZOOM_FACTOR} and {MAX_ZOOM_FACTOR}"
        ));
    }
    Ok(zoom_factor)
}

#[cfg(any(target_os = "macos", test))]
fn overlay_cutouts(
    browser: BrowserBounds,
    overlays: &[BrowserOverlay],
) -> Vec<BrowserOverlayCutout> {
    let cutouts: Vec<_> = overlays
        .iter()
        .filter_map(|overlay| {
            let left = (overlay.bounds.x - browser.x).clamp(0.0, browser.width);
            let top = (overlay.bounds.y - browser.y).clamp(0.0, browser.height);
            let right =
                (overlay.bounds.x + overlay.bounds.width - browser.x).clamp(0.0, browser.width);
            let bottom =
                (overlay.bounds.y + overlay.bounds.height - browser.y).clamp(0.0, browser.height);
            if left >= right || top >= bottom {
                return None;
            }

            let width = right - left;
            let height = bottom - top;
            Some(BrowserOverlayCutout {
                x: left,
                y: top,
                width,
                height,
                corner_radius: overlay.corner_radius.min(width / 2.0).min(height / 2.0),
            })
        })
        .collect();

    coalesce_overlapping_cutouts(cutouts)
}

#[cfg(any(target_os = "macos", test))]
fn coalesce_overlapping_cutouts(
    mut cutouts: Vec<BrowserOverlayCutout>,
) -> Vec<BrowserOverlayCutout> {
    loop {
        let mut pair = None;
        'search: for index in 0..cutouts.len() {
            for other_index in index + 1..cutouts.len() {
                let left = cutouts[index].x.max(cutouts[other_index].x);
                let top = cutouts[index].y.max(cutouts[other_index].y);
                let right = (cutouts[index].x + cutouts[index].width)
                    .min(cutouts[other_index].x + cutouts[other_index].width);
                let bottom = (cutouts[index].y + cutouts[index].height)
                    .min(cutouts[other_index].y + cutouts[other_index].height);
                if left < right && top < bottom {
                    pair = Some((index, other_index));
                    break 'search;
                }
            }
        }

        let Some((index, other_index)) = pair else {
            break;
        };
        let first = cutouts[index];
        let second = cutouts[other_index];
        let merged_left = first.x.min(second.x);
        let merged_top = first.y.min(second.y);
        let merged_right = (first.x + first.width).max(second.x + second.width);
        let merged_bottom = (first.y + first.height).max(second.y + second.height);
        let same_bounds = first.x == second.x
            && first.y == second.y
            && first.width == second.width
            && first.height == second.height;
        cutouts[index] = BrowserOverlayCutout {
            x: merged_left,
            y: merged_top,
            width: merged_right - merged_left,
            height: merged_bottom - merged_top,
            corner_radius: if same_bounds {
                first.corner_radius.min(second.corner_radius)
            } else {
                0.0
            },
        };
        cutouts.swap_remove(other_index);
    }
    cutouts
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
        || windows_gpu_compositor::is_preview_label(label)
}

pub(crate) fn is_privileged_shell_label(label: &str) -> bool {
    label == MAIN_WEBVIEW_LABEL || windows_gpu_compositor::is_shell_label(label)
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

fn parse_public_sidebar_navigation(value: &str) -> Result<tauri::Url, String> {
    const MAX_URL_LENGTH: usize = 2048;

    let value = value.trim();
    if value.is_empty() {
        return Err("sidebar browser URL cannot be empty".to_string());
    }
    if value.len() > MAX_URL_LENGTH {
        return Err(format!(
            "sidebar browser URL cannot exceed {MAX_URL_LENGTH} bytes"
        ));
    }

    let candidate = if value.contains("://") {
        value.to_string()
    } else {
        format!("https://{value}")
    };
    let url =
        tauri::Url::parse(&candidate).map_err(|_| "invalid sidebar browser URL".to_string())?;
    if !is_public_https_url(&url) {
        return Err("sidebar browser URL must be a public HTTPS URL".to_string());
    }
    Ok(url)
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
    if is_privileged_shell_label(caller.label()) {
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
    _compositor: &AcceleratedCompositorState,
    browser: &ActiveBrowser,
) -> Result<(), String> {
    if let Some(webview) = app.get_webview(&browser.label) {
        let _ = webview.hide();
        #[cfg(target_os = "macos")]
        let detach_error = macos_child::detach(&webview).await.err();
        let close_error = webview.close().err().map(|error| {
            format!(
                "failed to close sidebar browser generation {}: {error}",
                browser.generation
            )
        });
        #[cfg(target_os = "macos")]
        if let Some(detach_error) = detach_error {
            return Err(match close_error {
                Some(close_error) => format!("{detach_error}; {close_error}"),
                None => detach_error,
            });
        }
        if let Some(close_error) = close_error {
            return Err(close_error);
        }
    }
    Ok(())
}

#[cfg(windows)]
async fn close_browser(
    _caller: &Webview,
    _app: &AppHandle,
    compositor: &AcceleratedCompositorState,
    browser: &ActiveBrowser,
) -> Result<(), String> {
    let _ = compositor.close_preview(browser.generation)?;
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
        if let Err(error) = close_browser(&caller, &app, &state.compositor, previous).await {
            lifecycle_lock(&state).install(previous.clone());
            return Err(error);
        }
    }

    #[cfg(windows)]
    {
        if !state
            .compositor
            .open_preview(next.generation, url.clone(), bounds, overlays)?
        {
            return Err("accelerated compositor rejected the preview generation".to_string());
        }
    }

    #[cfg(not(windows))]
    {
        let window = app
            .get_window(MAIN_WEBVIEW_LABEL)
            .ok_or_else(|| "main desktop window is unavailable".to_string())?;
        #[cfg(not(target_os = "macos"))]
        let _ = &overlays;
        let label = next.label.clone();
        let builder = WebviewBuilder::new(label, WebviewUrl::External(url.clone()))
            .incognito(true)
            .initialization_script_for_all_frames(DEVICE_PERMISSION_DEFENSE_IN_DEPTH)
            .on_navigation(is_allowed_sidebar_navigation)
            .on_new_window(|_, _| NewWindowResponse::Deny)
            .on_download(|_, event| !matches!(event, DownloadEvent::Requested { .. }));

        let _webview = window
            .add_child(builder, bounds.position(), bounds.size())
            .map_err(|error| format!("failed to create sidebar browser: {error}"))?;

        #[cfg(target_os = "macos")]
        {
            if let Err(error) = _webview.hide() {
                let _ = _webview.close();
                return Err(format!(
                    "failed to hide macOS sidebar browser before layout: {error}"
                ));
            }
            if let Err(error) =
                macos_child::apply_layout(&_webview, bounds, true, true, overlays).await
            {
                let _ = _webview.hide();
                let _ = macos_child::detach(&_webview).await;
                let _ = _webview.close();
                return Err(error);
            }
        }
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
    #[cfg(all(not(windows), not(target_os = "macos")))]
    if snapshot.last_bounds == bounds && snapshot.visible == visible {
        return Ok(true);
    }

    #[cfg(windows)]
    {
        let _ = &app;
        if !state
            .compositor
            .layout_preview(generation, bounds, visible, overlays)?
        {
            return Ok(false);
        }
    }

    #[cfg(target_os = "macos")]
    {
        let Some(webview) = app.get_webview(&snapshot.label) else {
            return Ok(false);
        };
        macos_child::apply_layout(&webview, bounds, visible, false, overlays).await?;
    }

    #[cfg(all(not(windows), not(target_os = "macos")))]
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

#[cfg(not(windows))]
async fn with_sidebar_browser_host(
    webview: &Webview,
    operation: impl FnOnce(cef::BrowserHost) + Send + 'static,
) -> Result<(), String> {
    let (sender, mut receiver) = tauri::async_runtime::channel(1);
    webview
        .with_webview(move |platform| {
            let Some(host) = platform.browser().host() else {
                let _ = sender.try_send(false);
                return;
            };
            operation(host);
            let _ = sender.try_send(true);
        })
        .map_err(|error| format!("failed to access sidebar browser host: {error}"))?;

    match receiver.recv().await {
        Some(true) => Ok(()),
        Some(false) => Err("sidebar browser host is unavailable".to_string()),
        None => Err("sidebar browser host operation ended without a result".to_string()),
    }
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn control_sidebar_browser(
    caller: Webview,
    app: AppHandle,
    state: State<'_, SidebarBrowserState>,
    generation: u64,
    action: SidebarBrowserAction,
    url: Option<String>,
    query: Option<String>,
    forward: Option<bool>,
    find_next: Option<bool>,
    zoom_factor: Option<f64>,
) -> Result<bool, String> {
    ensure_main_caller(&caller)?;
    let navigation_url = match action {
        SidebarBrowserAction::Navigate => Some(parse_public_sidebar_navigation(
            url.as_deref()
                .ok_or_else(|| "navigate requires a sidebar browser URL".to_string())?,
        )?),
        _ => {
            if url.is_some() {
                return Err("sidebar browser URL is only valid for navigate".to_string());
            }
            None
        }
    };
    let find_query = match action {
        SidebarBrowserAction::Find => Some(validate_find_query(query.as_deref())?.to_string()),
        _ => {
            if query.is_some() || forward.is_some() || find_next.is_some() {
                return Err("find options are only valid for find".to_string());
            }
            None
        }
    };
    let zoom_factor = match action {
        SidebarBrowserAction::SetZoom => Some(validate_zoom_factor(zoom_factor)?),
        _ => {
            if zoom_factor.is_some() {
                return Err("zoom factor is only valid for setZoom".to_string());
            }
            None
        }
    };
    let _operation = state.operations.lock().await;
    let Some(snapshot) = lifecycle_lock(&state).snapshot(generation) else {
        return Ok(false);
    };
    #[cfg(windows)]
    let _ = (&app, &snapshot);

    #[cfg(windows)]
    {
        if !state.compositor.control_preview(
            action,
            navigation_url,
            find_query,
            forward,
            find_next,
            zoom_factor,
        )? {
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
            SidebarBrowserAction::Find => {
                let query = find_query.expect("find query was validated");
                with_sidebar_browser_host(&webview, move |host| {
                    let query = cef::CefString::from(query.as_str());
                    host.find(
                        Some(&query),
                        i32::from(forward.unwrap_or(true)),
                        0,
                        i32::from(find_next.unwrap_or(false)),
                    );
                })
                .await?;
            }
            SidebarBrowserAction::Forward => webview
                .eval("window.history.forward()")
                .map_err(|error| format!("failed to navigate sidebar browser forward: {error}"))?,
            SidebarBrowserAction::Reload => webview
                .reload()
                .map_err(|error| format!("failed to reload sidebar browser: {error}"))?,
            SidebarBrowserAction::Navigate => webview
                .navigate(navigation_url.expect("navigate URL was validated"))
                .map_err(|error| format!("failed to navigate sidebar browser: {error}"))?,
            SidebarBrowserAction::OpenExternal => {
                let url = webview
                    .url()
                    .map_err(|error| format!("failed to read sidebar browser URL: {error}"))?;
                if !is_public_https_url(&url) {
                    return Err("refusing to open a non-public sidebar browser URL".to_string());
                }
                crate::open_external_url(url.as_str())?;
            }
            SidebarBrowserAction::OpenDevTools => webview.open_devtools(),
            SidebarBrowserAction::Print => webview
                .print()
                .map_err(|error| format!("failed to print sidebar browser: {error}"))?,
            SidebarBrowserAction::SetZoom => webview
                .set_zoom(zoom_factor.expect("zoom factor was validated"))
                .map_err(|error| format!("failed to zoom sidebar browser: {error}"))?,
            SidebarBrowserAction::StopFind => {
                with_sidebar_browser_host(&webview, |host| host.stop_finding(1)).await?;
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
        if state.compositor.input_preview(input) {
            Ok(SidebarBrowserInputResponse::accepted("default"))
        } else {
            Ok(SidebarBrowserInputResponse::ignored())
        }
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
    if let Err(error) = close_browser(&caller, &app, &state.compositor, &browser).await {
        lifecycle_lock(&state).install(browser);
        return Err(error);
    }
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::{
        describe_navigation, dom_top_to_native_y, is_allowed_sidebar_navigation,
        is_public_https_url, overlay_cutouts, parse_public_sidebar_navigation, validate_find_query,
        validate_overlays, validate_zoom_factor, BrowserBounds, BrowserLifecycle, BrowserOverlay,
        MAX_FIND_QUERY_BYTES, MAX_ZOOM_FACTOR, MIN_ZOOM_FACTOR,
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
    fn address_navigation_normalizes_hosts_and_rejects_unsafe_urls() {
        assert_eq!(
            parse_public_sidebar_navigation(" example.com/docs ")
                .expect("public host should be normalized")
                .as_str(),
            "https://example.com/docs"
        );
        assert_eq!(
            parse_public_sidebar_navigation("https://example.com/path?value=1")
                .expect("public HTTPS URL should be accepted")
                .as_str(),
            "https://example.com/path?value=1"
        );

        for blocked in [
            "",
            "http://example.com",
            "https://localhost:3000",
            "https://127.0.0.1",
            "https://user:password@example.com",
            "file:///tmp/preview.html",
        ] {
            assert!(
                parse_public_sidebar_navigation(blocked).is_err(),
                "accepted {blocked}"
            );
        }
        assert!(parse_public_sidebar_navigation(&format!(
            "https://example.com/{}",
            "a".repeat(2048)
        ))
        .is_err());
    }

    #[test]
    fn native_find_query_is_bounded() {
        assert_eq!(validate_find_query(Some("artifact")).unwrap(), "artifact");
        assert!(validate_find_query(None).is_err());
        assert!(validate_find_query(Some("")).is_err());
        assert!(validate_find_query(Some(&"x".repeat(MAX_FIND_QUERY_BYTES + 1))).is_err());
    }

    #[test]
    fn native_zoom_factor_is_bounded() {
        assert_eq!(validate_zoom_factor(Some(1.0)).unwrap(), 1.0);
        assert_eq!(
            validate_zoom_factor(Some(MIN_ZOOM_FACTOR)).unwrap(),
            MIN_ZOOM_FACTOR
        );
        assert_eq!(
            validate_zoom_factor(Some(MAX_ZOOM_FACTOR)).unwrap(),
            MAX_ZOOM_FACTOR
        );
        for invalid in [
            None,
            Some(f64::NAN),
            Some(0.0),
            Some(MIN_ZOOM_FACTOR - 0.01),
            Some(MAX_ZOOM_FACTOR + 0.01),
        ] {
            assert!(validate_zoom_factor(invalid).is_err());
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

    #[test]
    fn dom_top_coordinates_convert_for_flipped_and_unflipped_native_views() {
        assert_eq!(dom_top_to_native_y(5.0, 900.0, 40.0, 320.0, true), 45.0);
        assert_eq!(dom_top_to_native_y(5.0, 900.0, 40.0, 320.0, false), 545.0);
    }

    #[test]
    fn overlay_cutouts_clip_to_preview_and_clamp_corner_radius() {
        let browser = BrowserBounds {
            x: 100.0,
            y: 50.0,
            width: 300.0,
            height: 200.0,
        };
        let cutouts = overlay_cutouts(
            browser,
            &[BrowserOverlay {
                bounds: BrowserBounds {
                    x: 80.0,
                    y: 30.0,
                    width: 80.0,
                    height: 60.0,
                },
                corner_radius: 100.0,
            }],
        );

        assert_eq!(cutouts.len(), 1);
        assert_eq!(cutouts[0].x, 0.0);
        assert_eq!(cutouts[0].y, 0.0);
        assert_eq!(cutouts[0].width, 60.0);
        assert_eq!(cutouts[0].height, 40.0);
        assert_eq!(cutouts[0].corner_radius, 20.0);
    }

    #[test]
    fn overlay_cutouts_drop_regions_covered_by_a_larger_overlay() {
        let browser = BrowserBounds {
            x: 100.0,
            y: 50.0,
            width: 300.0,
            height: 200.0,
        };
        let cutouts = overlay_cutouts(
            browser,
            &[
                BrowserOverlay {
                    bounds: browser,
                    corner_radius: 0.0,
                },
                BrowserOverlay {
                    bounds: BrowserBounds {
                        x: 150.0,
                        y: 80.0,
                        width: 100.0,
                        height: 70.0,
                    },
                    corner_radius: 12.0,
                },
            ],
        );

        assert_eq!(cutouts.len(), 1);
        assert_eq!(cutouts[0].width, browser.width);
        assert_eq!(cutouts[0].height, browser.height);
    }

    #[test]
    fn overlay_cutouts_coalesce_partial_and_chained_overlaps() {
        let browser = BrowserBounds {
            x: 0.0,
            y: 0.0,
            width: 300.0,
            height: 100.0,
        };
        let overlays = [
            BrowserOverlay {
                bounds: BrowserBounds {
                    x: 0.0,
                    y: 0.0,
                    width: 80.0,
                    height: 40.0,
                },
                corner_radius: 8.0,
            },
            BrowserOverlay {
                bounds: BrowserBounds {
                    x: 120.0,
                    y: 0.0,
                    width: 80.0,
                    height: 40.0,
                },
                corner_radius: 8.0,
            },
            BrowserOverlay {
                bounds: BrowserBounds {
                    x: 60.0,
                    y: 10.0,
                    width: 80.0,
                    height: 40.0,
                },
                corner_radius: 8.0,
            },
        ];

        let cutouts = overlay_cutouts(browser, &overlays);
        assert_eq!(cutouts.len(), 1);
        assert_eq!(cutouts[0].x, 0.0);
        assert_eq!(cutouts[0].width, 200.0);
        assert_eq!(cutouts[0].height, 50.0);
        assert_eq!(cutouts[0].corner_radius, 0.0);
    }

    #[test]
    fn rounded_cutout_hit_test_excludes_only_the_rounded_corners() {
        let cutout = overlay_cutouts(
            BrowserBounds {
                x: 0.0,
                y: 0.0,
                width: 200.0,
                height: 100.0,
            },
            &[BrowserOverlay {
                bounds: BrowserBounds {
                    x: 10.0,
                    y: 20.0,
                    width: 80.0,
                    height: 40.0,
                },
                corner_radius: 10.0,
            }],
        )[0];

        assert!(cutout.contains(20.0, 30.0));
        assert!(cutout.contains(50.0, 20.0));
        assert!(!cutout.contains(10.0, 20.0));
        assert!(!cutout.contains(9.0, 30.0));
    }
}
