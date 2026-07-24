#[cfg(any(windows, all(target_os = "macos", target_arch = "aarch64")))]
use super::{
    is_allowed_sidebar_navigation, BrowserBounds, BrowserOverlay, CompositorMode,
    SidebarBrowserAction, SidebarBrowserInput, SidebarBrowserInputKind, SidebarBrowserState,
    DEVICE_PERMISSION_DEFENSE_IN_DEPTH,
};
#[cfg(any(windows, all(target_os = "macos", target_arch = "aarch64")))]
use crate::runtime::{
    DesktopAppHandle as AppHandle, DesktopRuntime as Runtime, DesktopWebview as Webview,
};
#[cfg(any(windows, all(target_os = "macos", target_arch = "aarch64")))]
use serde::Serialize;

#[cfg(any(windows, all(target_os = "macos", target_arch = "aarch64"), test))]
mod geometry;
#[cfg(any(windows, all(target_os = "macos", target_arch = "aarch64")))]
use geometry::{
    clamp_rect, popup_placement, shell_regions_outside_preview, LayoutSnapshot, LogicalRect,
    PhysicalRect,
};
#[cfg(any(windows, all(target_os = "macos", target_arch = "aarch64"), test))]
mod input;
#[cfg(any(windows, all(target_os = "macos", target_arch = "aarch64")))]
use input::{InputRouter, NativeInputHook, PlatformInputHook, FOCUSED_PREVIEW};

#[cfg(any(windows, all(target_os = "macos", target_arch = "aarch64"), test))]
mod renderer;
#[cfg(any(windows, all(target_os = "macos", target_arch = "aarch64"), test))]
mod scheduler;
#[cfg(all(
    target_os = "macos",
    target_arch = "aarch64",
    any(test, feature = "metal-integration-tests")
))]
pub mod test_support;
#[cfg(any(windows, all(target_os = "macos", target_arch = "aarch64")))]
mod texture_import;

const SHELL_LABEL_PREFIX: &str = "offscreen-browser-gpu-shell-";
const PREVIEW_LABEL_PREFIX: &str = "offscreen-browser-gpu-preview-";
#[cfg(any(windows, all(target_os = "macos", target_arch = "aarch64")))]
const INITIAL_PREVIEW_URL: &str = "about:blank";

#[cfg(any(windows, all(target_os = "macos", target_arch = "aarch64")))]
fn debug_checkpoint(message: impl AsRef<str>) {
    eprintln!("[sidebar-compositor] {}", message.as_ref());
}

#[cfg(all(
    feature = "metal-integration-tests",
    target_os = "macos",
    target_arch = "aarch64"
))]
fn integration_test_flag(name: &str) -> bool {
    std::env::var_os(name).is_some_and(|value| {
        matches!(
            value.to_string_lossy().trim().to_ascii_lowercase().as_str(),
            "1" | "true" | "yes" | "on"
        )
    })
}

#[cfg(all(
    feature = "metal-integration-tests",
    target_os = "macos",
    target_arch = "aarch64"
))]
static TEST_STALE_CALLBACKS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

#[cfg(all(
    feature = "metal-integration-tests",
    target_os = "macos",
    target_arch = "aarch64"
))]
fn reset_test_stale_callback_count() {
    TEST_STALE_CALLBACKS.store(0, std::sync::atomic::Ordering::Release);
}

#[cfg(all(
    feature = "metal-integration-tests",
    target_os = "macos",
    target_arch = "aarch64"
))]
fn take_test_stale_callback_count() -> u64 {
    TEST_STALE_CALLBACKS.swap(0, std::sync::atomic::Ordering::AcqRel)
}

#[cfg(all(
    feature = "metal-integration-tests",
    target_os = "macos",
    target_arch = "aarch64"
))]
fn record_test_stale_callback() {
    TEST_STALE_CALLBACKS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
}

pub(crate) fn is_shell_label(label: &str) -> bool {
    label.starts_with(SHELL_LABEL_PREFIX)
}

pub(crate) fn is_preview_label(label: &str) -> bool {
    label.starts_with(PREVIEW_LABEL_PREFIX)
}

#[cfg(any(windows, all(target_os = "macos", target_arch = "aarch64")))]
pub(crate) fn shell_label(generation: u64) -> String {
    format!("{SHELL_LABEL_PREFIX}{generation}")
}

#[cfg(any(windows, all(target_os = "macos", target_arch = "aarch64")))]
pub(crate) fn window_label(generation: u64) -> String {
    format!("gpu-compositor-window-{generation}")
}

#[derive(Default)]
pub struct AcceleratedCompositorState {
    #[cfg(any(windows, all(target_os = "macos", target_arch = "aarch64")))]
    inner: platform_impl::StateInner,
}

#[cfg(any(windows, all(target_os = "macos", target_arch = "aarch64")))]
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcceleratedCompositorStats {
    backend: Option<&'static str>,
    mode: CompositorMode,
    shell_callbacks: u64,
    preview_callbacks: u64,
    imported_frames: u64,
    presented_frames: u64,
    import_failures: u64,
    present_failures: u64,
    shell_fps: u32,
    preview_fps: u32,
    present_fps: u32,
    shell_width: u32,
    shell_height: u32,
    preview_width: u32,
    preview_height: u32,
    last_copy_ms: f64,
    copy_ms_p50: f64,
    copy_ms_p95: f64,
    dropped_frames: u64,
    coalesced_frames: u64,
    surface_recovery_count: u64,
    device_recovery_count: u64,
    device_lost_count: u64,
    surface_timeout_count: u64,
    copy_timeout_count: u64,
    uncaptured_gpu_errors: u64,
    adapter_luid_checks: u64,
    adapter_mismatch_count: u64,
    selected_adapter_luid: Option<String>,
    texture_import_platform: Option<&'static str>,
    last_error: Option<String>,
}

#[cfg(any(windows, all(target_os = "macos", target_arch = "aarch64")))]
pub fn start_device_recovery_coordinator(app: AppHandle) {
    platform_impl::start_device_recovery_coordinator(app);
}

impl AcceleratedCompositorState {
    #[cfg(any(windows, all(target_os = "macos", target_arch = "aarch64")))]
    pub async fn start(&self, app: &AppHandle) -> Result<u64, String> {
        let url = tauri::Url::parse(INITIAL_PREVIEW_URL).expect("valid blank preview URL");
        self.inner.open(app, url).await
    }

    #[cfg(any(windows, all(target_os = "macos", target_arch = "aarch64")))]
    pub async fn wait_for_first_shell_present(
        &self,
        generation: u64,
        timeout: std::time::Duration,
    ) -> Result<renderer::FirstPresent, String> {
        self.inner
            .wait_for_first_shell_present(generation, timeout)
            .await
    }

    #[cfg(any(windows, all(target_os = "macos", target_arch = "aarch64")))]
    pub async fn stop(&self) -> Result<bool, String> {
        self.inner.close().await
    }

    #[cfg(any(windows, all(target_os = "macos", target_arch = "aarch64")))]
    pub fn open_preview(
        &self,
        generation: u64,
        url: tauri::Url,
        bounds: BrowserBounds,
        overlays: Vec<BrowserOverlay>,
    ) -> Result<bool, String> {
        self.inner
            .set_preview(generation, Some(url), bounds, true, overlays)
    }

    #[cfg(any(windows, all(target_os = "macos", target_arch = "aarch64")))]
    pub fn layout_preview(
        &self,
        generation: u64,
        bounds: BrowserBounds,
        visible: bool,
        overlays: Vec<BrowserOverlay>,
    ) -> Result<bool, String> {
        self.inner
            .set_preview(generation, None, bounds, visible, overlays)
    }

    #[cfg(any(windows, all(target_os = "macos", target_arch = "aarch64")))]
    pub fn close_preview(&self, generation: u64) -> Result<bool, String> {
        self.inner.close_preview(generation)
    }

    #[cfg(any(windows, all(target_os = "macos", target_arch = "aarch64")))]
    pub fn control_preview(
        &self,
        action: super::SidebarBrowserAction,
        url: Option<tauri::Url>,
        query: Option<String>,
        forward: Option<bool>,
        find_next: Option<bool>,
        zoom_factor: Option<f64>,
    ) -> Result<bool, String> {
        self.inner
            .control_preview(action, url, query, forward, find_next, zoom_factor)
    }

    #[cfg(any(windows, all(target_os = "macos", target_arch = "aarch64")))]
    pub fn input_preview(&self, input: super::SidebarBrowserInput) -> bool {
        self.inner.input_preview(input)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum FailureKind {
    SurfaceOutdated,
    SurfaceLost,
    SurfaceTimeout,
    Occluded,
    DeviceLost,
    AdapterMismatch,
    RepeatedImportFailure,
    CopyTimeout,
    CpuFrameFallback,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum RecoveryDecision {
    ReconfigureSurface,
    RestartSession,
    EnterNativeFallback,
}

#[derive(Default)]
struct RecoveryBudget {
    session_restarts: u8,
}

impl RecoveryBudget {
    fn decide(&self, failure: FailureKind) -> RecoveryDecision {
        match failure {
            FailureKind::SurfaceOutdated
            | FailureKind::SurfaceLost
            | FailureKind::SurfaceTimeout
            | FailureKind::Occluded => RecoveryDecision::ReconfigureSurface,
            FailureKind::DeviceLost
            | FailureKind::AdapterMismatch
            | FailureKind::RepeatedImportFailure
            | FailureKind::CopyTimeout
            | FailureKind::CpuFrameFallback
                if self.session_restarts == 0 =>
            {
                RecoveryDecision::RestartSession
            }
            FailureKind::DeviceLost
            | FailureKind::AdapterMismatch
            | FailureKind::RepeatedImportFailure
            | FailureKind::CopyTimeout
            | FailureKind::CpuFrameFallback => RecoveryDecision::EnterNativeFallback,
        }
    }

    fn record_session_restart(&mut self) {
        self.session_restarts = self.session_restarts.saturating_add(1);
    }
}

#[cfg(test)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum TeardownStep {
    MarkClosing,
    DetachInput,
    ClearPaintCallbacks,
    StopScheduler,
    ForceCloseBrowsers,
    WaitForBrowserClose,
    ReleaseGpuResources,
    DestroyWindow,
}

#[cfg(test)]
const fn teardown_order() -> [TeardownStep; 8] {
    [
        TeardownStep::MarkClosing,
        TeardownStep::DetachInput,
        TeardownStep::ClearPaintCallbacks,
        TeardownStep::StopScheduler,
        TeardownStep::ForceCloseBrowsers,
        TeardownStep::WaitForBrowserClose,
        TeardownStep::ReleaseGpuResources,
        TeardownStep::DestroyWindow,
    ]
}

#[cfg(test)]
mod recovery_policy_tests {
    use super::*;

    #[test]
    fn recovery_reconfigures_then_restarts_once_then_falls_back() {
        let mut budget = RecoveryBudget::default();
        assert_eq!(
            budget.decide(FailureKind::SurfaceOutdated),
            RecoveryDecision::ReconfigureSurface,
        );
        assert_eq!(
            budget.decide(FailureKind::DeviceLost),
            RecoveryDecision::RestartSession,
        );
        budget.record_session_restart();
        assert_eq!(
            budget.decide(FailureKind::DeviceLost),
            RecoveryDecision::EnterNativeFallback,
        );
    }

    #[test]
    fn teardown_barrier_uses_strict_ownership_order() {
        assert_eq!(
            teardown_order(),
            [
                TeardownStep::MarkClosing,
                TeardownStep::DetachInput,
                TeardownStep::ClearPaintCallbacks,
                TeardownStep::StopScheduler,
                TeardownStep::ForceCloseBrowsers,
                TeardownStep::WaitForBrowserClose,
                TeardownStep::ReleaseGpuResources,
                TeardownStep::DestroyWindow,
            ],
        );
    }
}

#[cfg(any(windows, all(target_os = "macos", target_arch = "aarch64")))]
mod platform_impl {
    use super::*;
    use cef::{ImplBrowser, ImplBrowserHost, PaintElementType};
    use renderer::{
        composition_passes, CompositionPass, FirstPresent, Layer, PresentReadiness,
        RendererBackend, COMPOSITOR_SHADER_WGSL,
    };
    use scheduler::{
        render_activity_policy, PresentScheduler, RenderActivityPolicy, ACTIVE_FRAME_RATE,
    };
    use std::{
        collections::VecDeque,
        ffi::c_void,
        sync::{
            atomic::{AtomicBool, AtomicU64, Ordering},
            mpsc, Arc, Condvar, Mutex, OnceLock,
        },
        thread,
        time::{Duration, Instant},
    };
    use tauri::{
        webview::{NewWindowResponse, WebviewBuilder},
        window::WindowBuilder,
        LogicalPosition, LogicalSize, Manager, Rect, Size, WebviewUrl, WindowEvent,
    };
    use tauri_runtime_cef::{OffscreenRenderMode, OffscreenSurface, Webview as CefWebview};
    use texture_import::{
        ImportedTexture, PlatformTextureImporter, TextureImportError, TextureImporter,
    };

    type PlatformAdapterId = <PlatformTextureImporter as TextureImporter>::AdapterId;

    const WINDOW_WIDTH: f64 = 1440.0;
    const WINDOW_HEIGHT: f64 = 900.0;
    const WINDOW_MIN_WIDTH: f64 = 1024.0;
    const WINDOW_MIN_HEIGHT: f64 = 720.0;
    const GPU_COPY_WAIT_BUDGET: Duration = Duration::from_millis(50);
    static DEVICE_RECOVERY_TX: OnceLock<mpsc::Sender<RecoveryRequest>> = OnceLock::new();
    static DEVICE_RESTART_PENDING: AtomicBool = AtomicBool::new(false);

    struct RecoveryRequest {
        failure: FailureKind,
        reason: String,
    }

    #[derive(Default)]
    pub struct StateInner {
        operations: tauri::async_runtime::Mutex<()>,
        next_generation: AtomicU64,
        session: Arc<Mutex<Option<Session>>>,
        pending_preview: Mutex<Option<PendingPreview>>,
        last_stats_log: Mutex<Option<Instant>>,
        current_url: Mutex<Option<tauri::Url>>,
        device_restart_count: AtomicU64,
        recovery_budget: Mutex<RecoveryBudget>,
    }

    struct PendingPreview {
        generation: u64,
        url: Option<tauri::Url>,
        bounds: BrowserBounds,
        visible: bool,
        overlays: Vec<BrowserOverlay>,
    }

    struct RecoverySessionSnapshot {
        preview_generation: u64,
        preview_bounds: BrowserBounds,
        overlays: Vec<BrowserOverlay>,
        preview_visible: bool,
        input_focus: u8,
        window_focused: bool,
        window_hidden: bool,
    }

    struct StartupWindowGuard {
        window: tauri::Window<Runtime>,
        shell: Option<Webview>,
        preview: Option<Webview>,
        armed: bool,
    }

    impl StartupWindowGuard {
        fn new(window: tauri::Window<Runtime>) -> Self {
            Self {
                window,
                shell: None,
                preview: None,
                armed: true,
            }
        }

        fn track_shell(&mut self, shell: &Webview) {
            self.shell = Some(shell.clone());
        }

        fn track_preview(&mut self, preview: &Webview) {
            self.preview = Some(preview.clone());
        }

        fn disarm(&mut self) {
            self.armed = false;
        }
    }

    impl Drop for StartupWindowGuard {
        fn drop(&mut self) {
            if !self.armed {
                return;
            }
            if let Some(preview) = self.preview.take() {
                let _ = preview.close();
            }
            if let Some(shell) = self.shell.take() {
                let _ = shell.close();
            }
            let _ = self.window.close();
        }
    }

    impl StateInner {
        pub async fn close(&self) -> Result<bool, String> {
            let _operation = self.operations.lock().await;
            self.close_locked()
        }

        pub async fn open(&self, app: &AppHandle, url: tauri::Url) -> Result<u64, String> {
            let _operation = self.operations.lock().await;
            *self
                .recovery_budget
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()) = RecoveryBudget::default();
            self.open_locked(app, url).await
        }

        pub async fn wait_for_first_shell_present(
            &self,
            generation: u64,
            timeout: Duration,
        ) -> Result<FirstPresent, String> {
            let readiness = {
                let guard = self
                    .session
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                let session = guard
                    .as_ref()
                    .ok_or_else(|| "accelerated compositor session is not active".to_string())?;
                if session.generation != generation {
                    return Err(format!(
                        "stale compositor generation {generation}; active generation is {}",
                        session.generation
                    ));
                }
                session.present_readiness.clone()
            };
            tauri::async_runtime::spawn_blocking(move || {
                let deadline = Instant::now() + timeout;
                let (lock, condition) = &*readiness;
                let mut state = lock
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                loop {
                    if let Some(shell_sequence) = state.first_shell_present() {
                        return Ok(FirstPresent {
                            generation,
                            shell_sequence,
                        });
                    }
                    let remaining = deadline.saturating_duration_since(Instant::now());
                    if remaining.is_zero() {
                        return Err(format!(
                            "timed out waiting for compositor generation {generation} to present its first shell frame"
                        ));
                    }
                    let (next_state, wait) = condition
                        .wait_timeout(state, remaining)
                        .unwrap_or_else(|poisoned| poisoned.into_inner());
                    state = next_state;
                    if wait.timed_out() && state.first_shell_present().is_none() {
                        return Err(format!(
                            "timed out waiting for compositor generation {generation} to present its first shell frame"
                        ));
                    }
                }
            })
            .await
            .map_err(|error| format!("failed to join first-present wait: {error}"))?
        }

        async fn open_locked(&self, app: &AppHandle, url: tauri::Url) -> Result<u64, String> {
            self.close_locked()?;
            *self
                .current_url
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(url.clone());

            let generation = self
                .next_generation
                .fetch_add(1, Ordering::Relaxed)
                .saturating_add(1)
                .max(1);
            let window_label = window_label(generation);
            let shell_label = shell_label(generation);
            let preview_label = format!("{PREVIEW_LABEL_PREFIX}{generation}");
            debug_checkpoint(format!(
                "gpu_compositor.open.start generation={generation} url={url}"
            ));

            std::env::set_var("ARDOR_CEF_ACCELERATED_OSR_PROBE", "1");
            let window = WindowBuilder::new(app, &window_label)
                .title("Ardor")
                .inner_size(WINDOW_WIDTH, WINDOW_HEIGHT)
                .min_inner_size(WINDOW_MIN_WIDTH, WINDOW_MIN_HEIGHT)
                .resizable(true)
                .visible(false)
                .build()
                .map_err(|error| format!("failed to create compositor window: {error}"))?;
            let mut startup_guard = StartupWindowGuard::new(window.clone());
            let physical_size = window
                .inner_size()
                .map_err(|error| format!("failed to read compositor size: {error}"))?;
            let scale = window
                .scale_factor()
                .map_err(|error| format!("failed to read compositor scale: {error}"))?;
            let logical_size = physical_size.to_logical::<f64>(scale);
            let preview_rect = LogicalRect {
                x: 0.0,
                y: 0.0,
                width: 1.0,
                height: 1.0,
            };
            let devtools_enabled = tauri_runtime_cef::browser_devtools_enabled();
            let shell = window
                .add_child(
                    WebviewBuilder::new(shell_label.clone(), WebviewUrl::App("index.html".into()))
                        .background_color(tauri::utils::config::Color(0, 0, 0, 0))
                        .devtools(devtools_enabled),
                    LogicalPosition::new(0.0, 0.0),
                    logical_size,
                )
                .map_err(|error| format!("failed to create offscreen shell: {error}"))?;
            startup_guard.track_shell(&shell);
            let preview = window
                .add_child(
                    WebviewBuilder::new(preview_label.clone(), WebviewUrl::External(url))
                        .incognito(true)
                        .devtools(devtools_enabled)
                        .background_color(tauri::utils::config::Color(255, 255, 255, 255))
                        .initialization_script_for_all_frames(DEVICE_PERMISSION_DEFENSE_IN_DEPTH)
                        .on_navigation(is_allowed_sidebar_navigation)
                        .on_new_window(|_, _| NewWindowResponse::Deny)
                        .on_download(|_, event| {
                            !matches!(event, tauri::webview::DownloadEvent::Requested { .. })
                        }),
                    LogicalPosition::new(0.0, 0.0),
                    LogicalSize::new(preview_rect.width, preview_rect.height),
                )
                .map_err(|error| format!("failed to create offscreen preview: {error}"))?;
            startup_guard.track_preview(&preview);
            #[cfg(all(
                feature = "metal-integration-tests",
                target_os = "macos",
                target_arch = "aarch64"
            ))]
            if integration_test_flag("ARDOR_TEST_METAL_STARTUP_FAILURE") {
                return Err("forced Metal startup failure".to_string());
            }

            let (shell_surface, shell_platform) = inspect_accelerated(&shell).await?;
            let (preview_surface, preview_platform) = inspect_accelerated(&preview).await?;
            let shell_adapter_hint = probe_accelerated_adapter_hint(&shell_surface, &shell).await?;
            let preview_adapter_hint =
                probe_accelerated_adapter_hint(&preview_surface, &preview).await?;
            if shell_adapter_hint.is_some()
                && preview_adapter_hint.is_some()
                && shell_adapter_hint != preview_adapter_hint
            {
                return Err(format!(
                    "CEF shell and preview use different GPU adapters: shell={shell_adapter_hint:?} preview={preview_adapter_hint:?}"
                ));
            }
            for (layer, surface) in [("shell", &shell_surface), ("preview", &preview_surface)] {
                if surface.render_mode() != OffscreenRenderMode::NativeCompositor {
                    return Err(format!(
                        "CEF {layer} fell back to CPU frames during accelerated startup"
                    ));
                }
            }
            let adapter_hint = preview_adapter_hint.or(shell_adapter_hint);
            debug_checkpoint(format!(
                "gpu_compositor.adapter.probed source=preview hint={adapter_hint:?}"
            ));
            let renderer = Arc::new(Mutex::new(
                GpuCompositor::new(
                    window.clone(),
                    physical_size.width,
                    physical_size.height,
                    adapter_hint,
                    shell_platform.clone(),
                    preview_platform.clone(),
                )
                .await?,
            ));
            let present_readiness = renderer
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .present_readiness();
            if let Some(host) = preview_platform.browser().host() {
                host.set_audio_muted(0);
            }
            debug_checkpoint(format!(
                "gpu_compositor.audio output=native activity_handler={}",
                preview_platform.audio_state().is_some()
            ));
            let router = Arc::new(InputRouter::new(
                shell_platform,
                preview_platform,
                shell_surface.clone(),
                preview_surface.clone(),
                preview_rect,
                scale,
            ));
            let input_hook = PlatformInputHook::install(&window, router.clone())?;
            let present_scheduler = PresentScheduler::start(renderer.clone())?;
            let closing = Arc::new(AtomicBool::new(false));

            for (layer, surface) in [
                ("shell", shell_surface.clone()),
                ("preview", preview_surface.clone()),
            ] {
                let renderer = renderer.clone();
                let present_scheduler = present_scheduler.clone();
                let closing = closing.clone();
                surface.set_render_mode_handler(move |mode| {
                    if closing.load(Ordering::Acquire) {
                        #[cfg(all(
                            feature = "metal-integration-tests",
                            target_os = "macos",
                            target_arch = "aarch64"
                        ))]
                        record_test_stale_callback();
                        return;
                    }
                    if mode != OffscreenRenderMode::CpuFrame {
                        return;
                    }
                    let renderer = renderer
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner());
                    if let Some(gpu) = renderer.gpu.as_ref() {
                        gpu.device_health.request_recovery(
                            FailureKind::CpuFrameFallback,
                            format!("CEF {layer} switched to CPU frames"),
                        );
                    }
                    drop(renderer);
                    present_scheduler.request();
                });
            }

            {
                let renderer = renderer.clone();
                let present_scheduler = present_scheduler.clone();
                let closing = closing.clone();
                preview_surface.set_popup_state_handler(move |rect| {
                    if closing.load(Ordering::Acquire) {
                        #[cfg(all(
                            feature = "metal-integration-tests",
                            target_os = "macos",
                            target_arch = "aarch64"
                        ))]
                        record_test_stale_callback();
                        return;
                    }
                    renderer
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner())
                        .set_preview_popup_rect(rect);
                    present_scheduler.request();
                });
            }

            {
                let renderer = renderer.clone();
                let present_scheduler = present_scheduler.clone();
                let closing = closing.clone();
                shell_surface.set_accelerated_paint_handler(move |type_, info| {
                    if closing.load(Ordering::Acquire) {
                        #[cfg(all(
                            feature = "metal-integration-tests",
                            target_os = "macos",
                            target_arch = "aarch64"
                        ))]
                        record_test_stale_callback();
                        return;
                    }
                    if type_ == PaintElementType::VIEW {
                        ingest_accelerated_frame(&renderer, &present_scheduler, Layer::Shell, info);
                    }
                });
            }
            {
                let renderer = renderer.clone();
                let present_scheduler = present_scheduler.clone();
                let closing = closing.clone();
                preview_surface.set_accelerated_paint_handler(move |type_, info| {
                    if closing.load(Ordering::Acquire) {
                        #[cfg(all(
                            feature = "metal-integration-tests",
                            target_os = "macos",
                            target_arch = "aarch64"
                        ))]
                        record_test_stale_callback();
                        return;
                    }
                    let layer = match type_ {
                        PaintElementType::VIEW => Layer::Preview,
                        PaintElementType::POPUP => Layer::PreviewPopup,
                        _ => return,
                    };
                    ingest_accelerated_frame(&renderer, &present_scheduler, layer, info);
                });
            }

            let shell_repaint = shell.clone();
            let preview_repaint = preview.clone();
            let session = Session {
                generation,
                active_preview_generation: AtomicU64::new(0),
                preview_visible: AtomicBool::new(false),
                window: window.clone(),
                shell,
                preview,
                shell_surface,
                preview_surface,
                renderer: Some(renderer.clone()),
                present_readiness,
                present_scheduler: Some(present_scheduler),
                router: router.clone(),
                focused: AtomicBool::new(true),
                hidden: AtomicBool::new(false),
                closing,
                next_layout_generation: AtomicU64::new(0),
                last_layout: Mutex::new(None),
                input_hook: Some(input_hook),
            };
            *self
                .session
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(session);
            startup_guard.disarm();

            let session_slot = self.session.clone();
            let app_for_window_events = app.clone();
            let external_close_pending = Arc::new(AtomicBool::new(false));
            window.on_window_event(move |event| match event {
                WindowEvent::Resized(size) => {
                    resize_session(&session_slot, *size);
                }
                WindowEvent::ScaleFactorChanged {
                    scale_factor,
                    new_inner_size,
                    ..
                } => {
                    if let Some(session) = session_slot
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner())
                        .as_ref()
                    {
                        session.router.set_scale(*scale_factor);
                    }
                    resize_session(&session_slot, *new_inner_size);
                }
                WindowEvent::Focused(focused) => {
                    if let Some(session) = session_slot
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner())
                        .as_ref()
                    {
                        session.set_focused(*focused);
                    }
                }
                WindowEvent::CloseRequested { api, .. } => {
                    let session_active = session_slot
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner())
                        .is_some();
                    if session_active {
                        api.prevent_close();
                        if external_close_pending.swap(true, Ordering::AcqRel) {
                            return;
                        }
                        let state = app_for_window_events.state::<SidebarBrowserState>();
                        super::super::lifecycle_lock(&state).active = None;
                        if let Err(error) = super::super::mode_lock(&state)
                            .transition(super::super::ModeEvent::Close)
                        {
                            debug_checkpoint(format!("gpu_compositor.close.mode_error {error}"));
                        }
                        let app = app_for_window_events.clone();
                        tauri::async_runtime::spawn(async move {
                            if let Err(error) =
                                app.state::<SidebarBrowserState>().compositor.stop().await
                            {
                                debug_checkpoint(format!("gpu_compositor.close.error {error}"));
                            }
                            app.exit(0);
                        });
                    }
                }
                WindowEvent::Destroyed => {
                    debug_checkpoint("gpu_compositor.window.destroyed");
                    session_slot
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner())
                        .take();
                }
                _ => {}
            });

            let finish_startup = (|| -> Result<(), String> {
                invalidate(&shell_repaint)?;
                invalidate(&preview_repaint)?;
                resize_session(&self.session, physical_size);
                if let Some(pending) = self
                    .pending_preview
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .take()
                {
                    self.set_preview(
                        pending.generation,
                        pending.url,
                        pending.bounds,
                        pending.visible,
                        pending.overlays,
                    )?;
                }
                window
                    .show()
                    .map_err(|error| format!("failed to show compositor window: {error}"))
            })();
            if let Err(error) = finish_startup {
                let cleanup = self.close_locked();
                return match cleanup {
                    Ok(_) => Err(error),
                    Err(cleanup_error) => Err(format!(
                        "{error}; compositor startup cleanup failed: {cleanup_error}"
                    )),
                };
            }
            debug_checkpoint(format!(
                "gpu_compositor.open.finish generation={generation} shell={shell_label} preview={preview_label}"
            ));
            Ok(generation)
        }

        pub fn set_preview(
            &self,
            generation: u64,
            url: Option<tauri::Url>,
            bounds: BrowserBounds,
            visible: bool,
            overlays: Vec<BrowserOverlay>,
        ) -> Result<bool, String> {
            let guard = self
                .session
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let Some(session) = guard.as_ref() else {
                *self
                    .pending_preview
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(PendingPreview {
                    generation,
                    url,
                    bounds,
                    visible,
                    overlays,
                });
                return Ok(true);
            };
            let active_generation = session.active_preview_generation.load(Ordering::Acquire);
            if active_generation != 0 && active_generation != generation {
                return Ok(false);
            }

            if let Some(url) = url {
                session
                    .preview
                    .navigate(url.clone())
                    .map_err(|error| format!("failed to navigate accelerated preview: {error}"))?;
                *self
                    .current_url
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(url);
                session
                    .active_preview_generation
                    .store(generation, Ordering::Release);
            }

            let rect = LogicalRect::from(bounds);
            let overlay_rects = overlays
                .into_iter()
                .map(|overlay| LogicalRect::from(overlay.bounds))
                .collect::<Vec<_>>();
            session.preview_visible.store(visible, Ordering::Release);
            let physical_size = session
                .window
                .inner_size()
                .map_err(|error| format!("failed to read compositor size: {error}"))?;
            let scale = session
                .window
                .scale_factor()
                .map_err(|error| format!("failed to read compositor scale: {error}"))?;
            let snapshot = LayoutSnapshot::new(
                session
                    .next_layout_generation
                    .fetch_add(1, Ordering::Relaxed)
                    .saturating_add(1),
                scale,
                physical_size.width,
                physical_size.height,
                rect,
                overlay_rects,
                visible,
            );
            if apply_layout_snapshot(session, snapshot)? {
                session.scheduler().request();
            }
            Ok(true)
        }

        pub fn close_preview(&self, generation: u64) -> Result<bool, String> {
            let guard = self
                .session
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let Some(session) = guard.as_ref() else {
                let mut pending = self
                    .pending_preview
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                if pending
                    .as_ref()
                    .is_some_and(|preview| preview.generation == generation)
                {
                    pending.take();
                    return Ok(true);
                }
                return Ok(false);
            };
            if session.active_preview_generation.load(Ordering::Acquire) != generation {
                return Ok(false);
            }
            session
                .active_preview_generation
                .store(0, Ordering::Release);
            session.preview_visible.store(false, Ordering::Release);
            session
                .preview
                .navigate(tauri::Url::parse(INITIAL_PREVIEW_URL).expect("valid blank URL"))
                .map_err(|error| format!("failed to clear accelerated preview: {error}"))?;
            let physical_size = session
                .window
                .inner_size()
                .map_err(|error| format!("failed to read compositor size: {error}"))?;
            let scale = session
                .window
                .scale_factor()
                .map_err(|error| format!("failed to read compositor scale: {error}"))?;
            let snapshot = LayoutSnapshot::new(
                session
                    .next_layout_generation
                    .fetch_add(1, Ordering::Relaxed)
                    .saturating_add(1),
                scale,
                physical_size.width,
                physical_size.height,
                LogicalRect::new(0.0, 0.0, 1.0, 1.0),
                Vec::new(),
                false,
            );
            if apply_layout_snapshot(session, snapshot)? {
                session.scheduler().request();
            }
            Ok(true)
        }

        pub fn control_preview(
            &self,
            action: SidebarBrowserAction,
            url: Option<tauri::Url>,
            query: Option<String>,
            forward: Option<bool>,
            find_next: Option<bool>,
            zoom_factor: Option<f64>,
        ) -> Result<bool, String> {
            let guard = self
                .session
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let Some(session) = guard.as_ref() else {
                return Ok(false);
            };
            if session.active_preview_generation.load(Ordering::Acquire) == 0 {
                return Ok(false);
            }
            match action {
                SidebarBrowserAction::Back => session.preview.go_back(),
                SidebarBrowserAction::Find => {
                    let query = query.expect("find query was validated");
                    session
                        .preview
                        .with_webview(move |platform| {
                            let Some(host) = platform.browser().host() else {
                                return;
                            };
                            let query = cef::CefString::from(query.as_str());
                            host.find(
                                Some(&query),
                                i32::from(forward.unwrap_or(true)),
                                0,
                                i32::from(find_next.unwrap_or(false)),
                            );
                        })
                        .map_err(|error| {
                            format!("failed to search accelerated preview: {error}")
                        })?;
                    return Ok(true);
                }
                SidebarBrowserAction::Forward => session.preview.go_forward(),
                SidebarBrowserAction::Reload => session.preview.reload(),
                SidebarBrowserAction::Navigate => {
                    let url = url.expect("navigate URL was validated");
                    session.preview.navigate(url.clone()).map_err(|error| {
                        format!("failed to navigate accelerated preview: {error}")
                    })?;
                    *self
                        .current_url
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(url);
                    return Ok(true);
                }
                SidebarBrowserAction::OpenExternal => {
                    let url = session.preview.url().map_err(|error| {
                        format!("failed to read accelerated preview URL: {error}")
                    })?;
                    if !is_allowed_sidebar_navigation(&url) || url.scheme() != "https" {
                        return Err("refusing to open a non-public preview URL".to_string());
                    }
                    crate::open_external_url(url.as_str())?;
                    return Ok(true);
                }
                SidebarBrowserAction::OpenDevTools => {
                    session.preview.open_devtools();
                    return Ok(true);
                }
                SidebarBrowserAction::Print => session.preview.print(),
                SidebarBrowserAction::SetZoom => session
                    .preview
                    .set_zoom(zoom_factor.expect("zoom factor was validated")),
                SidebarBrowserAction::StopFind => {
                    session
                        .preview
                        .with_webview(|platform| {
                            if let Some(host) = platform.browser().host() {
                                host.stop_finding(1);
                            }
                        })
                        .map_err(|error| format!("failed to stop preview search: {error}"))?;
                    return Ok(true);
                }
            }
            .map_err(|error| format!("failed to control accelerated preview: {error}"))?;
            Ok(true)
        }

        pub fn input_preview(&self, input: SidebarBrowserInput) -> bool {
            let guard = self
                .session
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let Some(session) = guard.as_ref() else {
                return false;
            };
            if session.active_preview_generation.load(Ordering::Acquire) == 0 {
                return false;
            }
            if matches!(
                input.kind,
                SidebarBrowserInputKind::Focus
                    | SidebarBrowserInputKind::FocusNext
                    | SidebarBrowserInputKind::FocusPrevious
            ) {
                session.router.focus(FOCUSED_PREVIEW);
                true
            } else {
                false
            }
        }

        pub(super) async fn restart_current(
            &self,
            app: &AppHandle,
            reason: &str,
        ) -> Result<u64, String> {
            let _operation = self.operations.lock().await;
            let last_commanded_url = self
                .current_url
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .clone()
                .ok_or_else(|| "device recovery has no active compositor URL".to_string())?;
            let (recovery, preview_webview) = {
                let guard = self
                    .session
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                let session = guard.as_ref().ok_or_else(|| {
                    "device recovery has no active compositor session".to_string()
                })?;
                let layout = session.router.layout();
                (
                    RecoverySessionSnapshot {
                        preview_generation: session
                            .active_preview_generation
                            .load(Ordering::Acquire),
                        preview_bounds: BrowserBounds {
                            x: layout.preview.x,
                            y: layout.preview.y,
                            width: layout.preview.width,
                            height: layout.preview.height,
                        },
                        overlays: layout
                            .overlays
                            .into_iter()
                            .map(|overlay| BrowserOverlay {
                                bounds: BrowserBounds {
                                    x: overlay.x,
                                    y: overlay.y,
                                    width: overlay.width,
                                    height: overlay.height,
                                },
                                corner_radius: 0.0,
                            })
                            .collect(),
                        preview_visible: layout.preview_visible,
                        input_focus: session.router.focused.load(Ordering::Acquire),
                        window_focused: session.focused.load(Ordering::Acquire),
                        window_hidden: session.hidden.load(Ordering::Acquire),
                    },
                    session.preview.clone(),
                )
            };
            let actual_url = preview_webview.url().ok();
            let url = actual_url.unwrap_or(last_commanded_url);
            *self
                .current_url
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(url.clone());
            debug_checkpoint(format!(
                "gpu_compositor.session_restart.start reason={reason}"
            ));
            self.close_locked()?;
            thread::sleep(Duration::from_millis(200));
            let generation = self.open_locked(app, url.clone()).await?;
            if recovery.preview_generation != 0 {
                self.set_preview(
                    recovery.preview_generation,
                    Some(url),
                    recovery.preview_bounds,
                    recovery.preview_visible,
                    recovery.overlays,
                )?;
                if let Some(session) = self
                    .session
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .as_ref()
                {
                    session.router.focus(recovery.input_focus);
                }
            }
            self.wait_for_first_shell_present(generation, Duration::from_secs(30))
                .await?;
            if recovery.preview_visible {
                let deadline = Instant::now() + Duration::from_secs(30);
                loop {
                    let restored = self.stats().is_some_and(|snapshot| {
                        snapshot.preview_callbacks > 0
                            && snapshot.preview_width > 0
                            && snapshot.preview_height > 0
                            && snapshot.import_failures == 0
                    });
                    if restored {
                        break;
                    }
                    if Instant::now() >= deadline {
                        return Err(
                            "timed out waiting for restored preview after recovery".to_string()
                        );
                    }
                    thread::sleep(Duration::from_millis(50));
                }
            }
            let window_to_hide = {
                let guard = self
                    .session
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                guard.as_ref().and_then(|session| {
                    session.set_focused(recovery.window_focused);
                    session.set_hidden(recovery.window_hidden);
                    recovery.window_hidden.then(|| session.window.clone())
                })
            };
            if let Some(window) = window_to_hide {
                window
                    .hide()
                    .map_err(|error| format!("failed to restore hidden window state: {error}"))?;
            }
            let snapshot = self
                .stats()
                .ok_or_else(|| "restarted compositor session disappeared".to_string())?;
            if snapshot.import_failures > 0 || snapshot.present_failures > 0 {
                return Err(format!(
                    "restarted compositor was unhealthy: import_failures={} present_failures={}",
                    snapshot.import_failures, snapshot.present_failures
                ));
            }
            let device_recoveries = self
                .device_restart_count
                .fetch_add(1, Ordering::Relaxed)
                .saturating_add(1);
            debug_checkpoint(format!(
                "gpu_compositor.recovery.healthy kind=device shell_callbacks={} imported={} presented={} import_failures=0 present_failures=0 shell_fps={} present_fps={} surface_recoveries={} device_recoveries={device_recoveries}",
                snapshot.shell_callbacks,
                snapshot.imported_frames,
                snapshot.presented_frames,
                snapshot.shell_fps,
                snapshot.present_fps,
                snapshot.surface_recovery_count
            ));
            debug_checkpoint(format!(
                "gpu_compositor.session_restart.finish reason={reason} generation={generation}"
            ));
            Ok(generation)
        }

        fn close_locked(&self) -> Result<bool, String> {
            let session = self
                .session
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .take();
            let Some(session) = session else {
                return Ok(false);
            };
            debug_checkpoint(format!(
                "gpu_compositor.close generation={}",
                session.generation
            ));
            session.close()?;
            Ok(true)
        }

        pub fn stats(&self) -> Option<AcceleratedCompositorStats> {
            let guard = self
                .session
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let session = guard.as_ref()?;
            let mut snapshot = session
                .renderer()
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .snapshot();
            snapshot.device_recovery_count = snapshot
                .device_recovery_count
                .saturating_add(self.device_restart_count.load(Ordering::Relaxed));
            snapshot.coalesced_frames = session.scheduler().coalesced_frames();
            snapshot.mode = if DEVICE_RESTART_PENDING.load(Ordering::Acquire) {
                CompositorMode::RecoveringGpu
            } else {
                CompositorMode::GpuActive
            };
            let now = Instant::now();
            let mut last_stats_log = self
                .last_stats_log
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if last_stats_log
                .is_none_or(|last_logged| now.duration_since(last_logged) >= Duration::from_secs(2))
            {
                debug_checkpoint(format!(
                    "gpu_compositor.stats backend={} mode={:?} shell_fps={} preview_fps={} present_fps={} copy_ms={:.3} copy_p95_ms={:.3} imported={} presented={} dropped={} coalesced={} recoveries={} failures={} adapter_luid={}",
                    snapshot.backend.unwrap_or("unknown"),
                    snapshot.mode,
                    snapshot.shell_fps,
                    snapshot.preview_fps,
                    snapshot.present_fps,
                    snapshot.last_copy_ms,
                    snapshot.copy_ms_p95,
                    snapshot.imported_frames,
                    snapshot.presented_frames,
                    snapshot.dropped_frames,
                    snapshot.coalesced_frames,
                    snapshot.surface_recovery_count.saturating_add(snapshot.device_recovery_count),
                    snapshot.import_failures.saturating_add(snapshot.present_failures),
                    snapshot
                        .selected_adapter_luid
                        .as_deref()
                        .unwrap_or("unknown")
                ));
                *last_stats_log = Some(now);
            }
            Some(snapshot)
        }
    }

    fn request_device_restart(
        failure: FailureKind,
        reason: impl Into<String>,
    ) -> Result<(), String> {
        if DEVICE_RESTART_PENDING.swap(true, Ordering::AcqRel) {
            return Ok(());
        }
        let request = RecoveryRequest {
            failure,
            reason: reason.into(),
        };
        let Some(sender) = DEVICE_RECOVERY_TX.get() else {
            DEVICE_RESTART_PENDING.store(false, Ordering::Release);
            return Err("device recovery coordinator is not initialized".to_string());
        };
        sender.send(request).map_err(|error| {
            DEVICE_RESTART_PENDING.store(false, Ordering::Release);
            format!("failed to schedule compositor session restart: {error}")
        })
    }

    pub fn start_device_recovery_coordinator(app: AppHandle) {
        if DEVICE_RECOVERY_TX.get().is_some() {
            return;
        }
        let (sender, receiver) = mpsc::channel::<RecoveryRequest>();
        if DEVICE_RECOVERY_TX.set(sender).is_err() {
            return;
        }
        let _ = thread::Builder::new()
            .name("ardor-gpu-recovery".to_string())
            .spawn(move || {
                while let Ok(request) = receiver.recv() {
                    let reason = request.reason;
                    let result = tauri::async_runtime::block_on(async {
                        let state = app.state::<SidebarBrowserState>();
                        let decision = state
                            .compositor
                            .inner
                            .recovery_budget
                            .lock()
                            .unwrap_or_else(|poisoned| poisoned.into_inner())
                            .decide(request.failure);
                        match decision {
                            RecoveryDecision::ReconfigureSurface => Ok(()),
                            RecoveryDecision::RestartSession => {
                                state.begin_compositor_recovery()?;
                                state
                                    .compositor
                                    .inner
                                    .recovery_budget
                                    .lock()
                                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                                    .record_session_restart();
                                match state.compositor.inner.restart_current(&app, &reason).await {
                                    Ok(_) => state.finish_compositor_recovery(),
                                    Err(error) => {
                                        state.enter_native_fallback(&app).await?;
                                        Err(error)
                                    }
                                }
                            }
                            RecoveryDecision::EnterNativeFallback => {
                                state.begin_compositor_recovery()?;
                                state.enter_native_fallback(&app).await
                            }
                        }
                    });
                    if let Err(error) = result {
                        debug_checkpoint(format!(
                            "gpu_compositor.session_restart.error reason={reason} error={error}"
                        ));
                    }
                    DEVICE_RESTART_PENDING.store(false, Ordering::Release);
                }
            });
    }

    struct Session {
        generation: u64,
        active_preview_generation: AtomicU64,
        preview_visible: AtomicBool,
        window: tauri::Window<Runtime>,
        shell: Webview,
        preview: Webview,
        shell_surface: OffscreenSurface,
        preview_surface: OffscreenSurface,
        renderer: Option<Arc<Mutex<GpuCompositor>>>,
        present_readiness: Arc<(Mutex<PresentReadiness>, Condvar)>,
        present_scheduler: Option<Arc<PresentScheduler>>,
        router: Arc<InputRouter>,
        focused: AtomicBool,
        hidden: AtomicBool,
        closing: Arc<AtomicBool>,
        next_layout_generation: AtomicU64,
        last_layout: Mutex<Option<LayoutSnapshot>>,
        input_hook: Option<PlatformInputHook>,
    }

    impl Session {
        fn set_focused(&self, focused: bool) {
            if self.focused.swap(focused, Ordering::AcqRel) != focused {
                self.apply_render_activity();
            }
        }

        fn set_hidden(&self, hidden: bool) {
            if self.hidden.swap(hidden, Ordering::AcqRel) != hidden {
                self.apply_render_activity();
            }
        }

        fn apply_render_activity(&self) {
            if self.closing.load(Ordering::Acquire) {
                return;
            }
            let policy = render_activity_policy(
                self.focused.load(Ordering::Acquire),
                self.hidden.load(Ordering::Acquire),
            );
            apply_webview_activity(&self.router.shell, policy);
            apply_webview_activity(&self.router.preview, policy);
            if let Some(scheduler) = self.present_scheduler.as_ref() {
                scheduler.set_frame_rate(policy.frame_rate);
            }
            debug_checkpoint(format!(
                "gpu_compositor.activity focused={} hidden={} frame_rate={}",
                self.focused.load(Ordering::Relaxed),
                policy.hidden,
                policy.frame_rate
            ));
        }

        fn renderer(&self) -> &Arc<Mutex<GpuCompositor>> {
            self.renderer
                .as_ref()
                .expect("active compositor session must own a renderer")
        }

        fn scheduler(&self) -> &Arc<PresentScheduler> {
            self.present_scheduler
                .as_ref()
                .expect("active compositor session must own a scheduler")
        }

        fn close(mut self) -> Result<(), String> {
            self.closing.store(true, Ordering::Release);
            self.focused.store(false, Ordering::Release);
            self.hidden.store(true, Ordering::Release);

            let mut errors = Vec::new();
            if let Some(input_hook) = self.input_hook.as_mut() {
                if let Err(error) = input_hook.detach() {
                    errors.push(format!("input detach failed: {error}"));
                }
            }
            self.input_hook.take();
            self.shell_surface.clear_accelerated_paint_handler();
            self.preview_surface.clear_accelerated_paint_handler();
            self.shell_surface.clear_render_mode_handler();
            self.preview_surface.clear_render_mode_handler();
            self.shell_surface.clear_popup_state_handler();
            self.preview_surface.clear_popup_state_handler();
            if let Some(scheduler) = self.present_scheduler.take() {
                scheduler.stop();
            }

            if let Err(error) = self
                .router
                .preview
                .force_close_and_wait(Duration::from_secs(5))
            {
                errors.push(format!("preview close failed: {error}"));
            }
            if let Err(error) = self
                .router
                .shell
                .force_close_and_wait(Duration::from_secs(5))
            {
                errors.push(format!("shell close failed: {error}"));
            }

            self.renderer.take();
            if let Err(error) = self.window.close() {
                errors.push(format!("failed to close compositor window: {error}"));
            }

            if errors.is_empty() {
                Ok(())
            } else {
                Err(errors.join("; "))
            }
        }
    }

    impl Drop for Session {
        fn drop(&mut self) {
            self.closing.store(true, Ordering::Release);
            self.focused.store(false, Ordering::Release);
            self.hidden.store(true, Ordering::Release);
            self.input_hook.take();
            self.shell_surface.clear_accelerated_paint_handler();
            self.preview_surface.clear_accelerated_paint_handler();
            self.shell_surface.clear_render_mode_handler();
            self.preview_surface.clear_render_mode_handler();
            self.shell_surface.clear_popup_state_handler();
            self.preview_surface.clear_popup_state_handler();
            if let Some(scheduler) = self.present_scheduler.take() {
                scheduler.stop();
            }
            self.renderer.take();
            let _ = self.shell.close();
            let _ = self.preview.close();
        }
    }

    fn resize_session(slot: &Arc<Mutex<Option<Session>>>, physical_size: tauri::PhysicalSize<u32>) {
        let guard = slot.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let Some(session) = guard.as_ref() else {
            return;
        };
        if physical_size.width == 0 || physical_size.height == 0 {
            session.set_hidden(true);
            return;
        }
        session.set_hidden(false);
        let scale = session.window.scale_factor().unwrap_or(1.0);
        let layout = session.router.layout();
        let snapshot = LayoutSnapshot::new(
            session
                .next_layout_generation
                .fetch_add(1, Ordering::Relaxed)
                .saturating_add(1),
            scale,
            physical_size.width,
            physical_size.height,
            layout.preview,
            layout.overlays,
            layout.preview_visible,
        );
        match apply_layout_snapshot(session, snapshot) {
            Ok(true) => session.scheduler().request(),
            Ok(false) => {}
            Err(error) => {
                debug_checkpoint(format!("gpu_compositor.resize.layout_error {error}"));
            }
        }
    }

    fn apply_layout_snapshot(session: &Session, snapshot: LayoutSnapshot) -> Result<bool, String> {
        {
            let last_layout = session
                .last_layout
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if last_layout
                .as_ref()
                .is_some_and(|previous| previous.same_geometry(&snapshot))
            {
                return Ok(false);
            }
        }
        let logical_size = LogicalSize::new(
            f64::from(snapshot.window.width) / snapshot.scale,
            f64::from(snapshot.window.height) / snapshot.scale,
        );
        session
            .shell
            .set_bounds(Rect {
                position: tauri::Position::Logical(LogicalPosition::new(0.0, 0.0)),
                size: Size::Logical(logical_size),
            })
            .map_err(|error| format!("failed to resize accelerated shell: {error}"))?;
        session
            .preview
            .set_bounds(Rect {
                position: tauri::Position::Logical(LogicalPosition::new(0.0, 0.0)),
                size: Size::Logical(LogicalSize::new(
                    snapshot.preview.width.max(1.0),
                    snapshot.preview.height.max(1.0),
                )),
            })
            .map_err(|error| format!("failed to resize accelerated preview: {error}"))?;
        session.router.set_scale(snapshot.scale);
        session.router.set_layout(
            snapshot.preview,
            &snapshot.overlays,
            snapshot.preview_visible,
        );
        {
            let mut renderer = session
                .renderer()
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            renderer.resize(
                snapshot.window.width,
                snapshot.window.height,
                snapshot.preview_physical(),
            );
            renderer.set_preview_layout(
                snapshot.preview_physical(),
                snapshot.overlays_physical(),
                snapshot.preview_visible,
                snapshot.scale,
            );
        }
        debug_checkpoint(format!(
            "gpu_compositor.layout.applied generation={} scale={} window={}x{}",
            snapshot.generation, snapshot.scale, snapshot.window.width, snapshot.window.height
        ));
        *session
            .last_layout
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(snapshot);
        Ok(true)
    }

    fn apply_webview_activity(webview: &CefWebview, policy: RenderActivityPolicy) {
        if let Some(host) = webview.browser().host() {
            host.set_windowless_frame_rate(i32::from(policy.frame_rate));
            host.was_hidden(i32::from(policy.hidden));
        }
    }

    async fn inspect_accelerated(
        webview: &Webview,
    ) -> Result<(OffscreenSurface, CefWebview), String> {
        let (sender, mut receiver) = tauri::async_runtime::channel(1);
        webview
            .with_webview(move |platform| {
                if let Some(host) = platform.browser().host() {
                    host.set_windowless_frame_rate(i32::from(ACTIVE_FRAME_RATE));
                }
                let native: CefWebview = (*platform).clone();
                let _ = sender.try_send((native.offscreen_surface(), native));
            })
            .map_err(|error| format!("failed to inspect accelerated browser: {error}"))?;
        let (surface, platform) = receiver
            .recv()
            .await
            .ok_or_else(|| "CEF did not expose its accelerated browser".to_string())?;
        let surface =
            surface.ok_or_else(|| "CEF did not expose an offscreen surface".to_string())?;
        if !surface.accelerated_osr_requested() {
            return Err("CEF accelerated OSR was not requested for this browser".to_string());
        }
        Ok((surface, platform))
    }

    async fn probe_accelerated_adapter_hint(
        surface: &OffscreenSurface,
        webview: &Webview,
    ) -> Result<Option<PlatformAdapterId>, String> {
        const PROBE_TIMEOUT: Duration = Duration::from_secs(8);

        let (sender, receiver) = mpsc::sync_channel(1);
        let sent = Arc::new(AtomicBool::new(false));
        surface.set_accelerated_paint_handler({
            let sent = sent.clone();
            move |type_, info| {
                if type_ != PaintElementType::VIEW || sent.swap(true, Ordering::AcqRel) {
                    return;
                }
                let result = PlatformTextureImporter::adapter_hint_from_shared_handle(
                    accelerated_shared_texture_handle(info),
                );
                let _ = sender.try_send(result);
            }
        });
        let invalidated = invalidate(webview);
        if let Err(error) = invalidated {
            surface.clear_accelerated_paint_handler();
            return Err(error);
        }
        let received =
            tauri::async_runtime::spawn_blocking(move || receiver.recv_timeout(PROBE_TIMEOUT))
                .await
                .map_err(|error| format!("failed to join CEF adapter probe: {error}"));
        surface.clear_accelerated_paint_handler();
        match received? {
            Ok(result) => result,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                Err("timed out waiting for the first accelerated CEF frame".to_string())
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                Err("CEF adapter probe disconnected before the first frame".to_string())
            }
        }
    }

    fn invalidate(webview: &Webview) -> Result<(), String> {
        webview
            .with_webview(|platform| {
                if let Some(host) = platform.browser().host() {
                    host.invalidate(PaintElementType::VIEW);
                }
            })
            .map_err(|error| format!("failed to invalidate accelerated browser: {error}"))
    }

    fn accelerated_shared_texture_handle(info: &cef::AcceleratedPaintInfo) -> *mut c_void {
        #[cfg(windows)]
        {
            info.shared_texture_handle
        }
        #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
        {
            info.shared_texture_io_surface
        }
    }

    struct LayerTexture {
        _texture: wgpu::Texture,
        view: wgpu::TextureView,
        bind_group: wgpu::BindGroup,
        width: u32,
        height: u32,
    }

    pub(super) struct GpuCompositor {
        shell_webview: CefWebview,
        preview_webview: CefWebview,
        gpu: Option<GpuBackend>,
        recovery_telemetry: Arc<RecoveryTelemetry>,
        shell: Option<LayerTexture>,
        preview: Option<LayerTexture>,
        preview_popup: Option<LayerTexture>,
        preview_popup_rect: Option<cef::Rect>,
        preview_rect: PhysicalRect,
        overlay_rects: Vec<PhysicalRect>,
        preview_visible: bool,
        layout_scale: f64,
        stats: GpuStats,
        deferred_copies: Vec<PendingGpuCopy>,
        pending_recovery_health: Option<RecoveryHealthCheck>,
        present_readiness: Arc<(Mutex<PresentReadiness>, Condvar)>,
        shell_sequence: u64,
        #[cfg(all(
            feature = "metal-integration-tests",
            target_os = "macos",
            target_arch = "aarch64"
        ))]
        test_runtime_failure_requested: bool,
    }

    struct GpuBackend {
        _instance: wgpu::Instance,
        surface: Option<wgpu::Surface<'static>>,
        device: wgpu::Device,
        queue: wgpu::Queue,
        config: wgpu::SurfaceConfiguration,
        bind_group_layout: wgpu::BindGroupLayout,
        sampler: wgpu::Sampler,
        ingest_pipeline: wgpu::RenderPipeline,
        present_pipeline: wgpu::RenderPipeline,
        importer: PlatformTextureImporter,
        selected_adapter_id: PlatformAdapterId,
        device_health: Arc<DeviceHealth>,
    }

    struct GpuDeviceParts {
        device: wgpu::Device,
        queue: wgpu::Queue,
        config: wgpu::SurfaceConfiguration,
        bind_group_layout: wgpu::BindGroupLayout,
        sampler: wgpu::Sampler,
        ingest_pipeline: wgpu::RenderPipeline,
        present_pipeline: wgpu::RenderPipeline,
        importer: PlatformTextureImporter,
        selected_adapter_id: PlatformAdapterId,
        device_health: Arc<DeviceHealth>,
    }

    #[derive(Default)]
    struct RecoveryTelemetry {
        device_lost_count: AtomicU64,
        uncaptured_gpu_errors: AtomicU64,
    }

    struct DeviceHealth {
        recovery_requested: AtomicBool,
        last_failure: Mutex<Option<(FailureKind, String)>>,
        telemetry: Arc<RecoveryTelemetry>,
    }

    impl DeviceHealth {
        fn new(telemetry: Arc<RecoveryTelemetry>) -> Self {
            Self {
                recovery_requested: AtomicBool::new(false),
                last_failure: Mutex::new(None),
                telemetry,
            }
        }

        fn request_recovery(&self, failure: FailureKind, reason: impl Into<String>) {
            let reason = reason.into();
            if !self.recovery_requested.swap(true, Ordering::AcqRel) {
                self.telemetry
                    .device_lost_count
                    .fetch_add(1, Ordering::Relaxed);
            }
            *self
                .last_failure
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some((failure, reason));
        }

        fn take_recovery_request(&self) -> Option<(FailureKind, String)> {
            if !self.recovery_requested.swap(false, Ordering::AcqRel) {
                return None;
            }
            self.last_failure
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .take()
                .or_else(|| {
                    Some((
                        FailureKind::DeviceLost,
                        "wgpu device loss requested recovery".to_string(),
                    ))
                })
        }

        fn recovery_requested(&self) -> bool {
            self.recovery_requested.load(Ordering::Acquire)
        }
    }

    struct PendingGpuCopy {
        device: wgpu::Device,
        submission: wgpu::SubmissionIndex,
        _imported_texture: wgpu::Texture,
        _imported_view: wgpu::TextureView,
        _imported_bind_group: wgpu::BindGroup,
        layer: Layer,
        width: u32,
        height: u32,
        started_at: Instant,
    }

    struct CompletedGpuCopy {
        layer: Layer,
        width: u32,
        height: u32,
        elapsed_ms: f64,
    }

    enum GpuCopyWaitResult {
        Completed(CompletedGpuCopy),
        TimedOut(PendingGpuCopy),
        Failed(PendingGpuCopy, String),
    }

    struct RecoveryHealthCheck {
        kind: &'static str,
        preview_callbacks: u64,
        imported_frames: u64,
        presented_frames: u64,
        import_failures: u64,
        present_failures: u64,
    }

    impl PendingGpuCopy {
        fn wait(self, timeout: Duration) -> GpuCopyWaitResult {
            match self.device.poll(wgpu::PollType::Wait {
                submission_index: Some(self.submission.clone()),
                timeout: Some(timeout),
            }) {
                Ok(_) => GpuCopyWaitResult::Completed(CompletedGpuCopy {
                    layer: self.layer,
                    width: self.width,
                    height: self.height,
                    elapsed_ms: self.started_at.elapsed().as_secs_f64() * 1000.0,
                }),
                Err(wgpu::PollError::Timeout) => GpuCopyWaitResult::TimedOut(self),
                Err(error) => {
                    GpuCopyWaitResult::Failed(self, format!("GPU copy did not complete: {error}"))
                }
            }
        }
    }

    impl GpuBackend {
        async fn new(
            window: &tauri::Window<Runtime>,
            width: u32,
            height: u32,
            adapter_hint: Option<PlatformAdapterId>,
            recovery_telemetry: Arc<RecoveryTelemetry>,
        ) -> Result<Self, String> {
            let backend = RendererBackend::current();
            let mut descriptor = wgpu::InstanceDescriptor::new_without_display_handle();
            descriptor.backends = backend.required_backends();
            let instance = wgpu::Instance::new(descriptor);
            let surface = instance
                .create_surface(window.clone())
                .map_err(|error| format!("failed to create wgpu surface: {error}"))?;
            let parts = Self::create_device_parts(
                &instance,
                &surface,
                width,
                height,
                adapter_hint,
                backend,
                recovery_telemetry,
            )
            .await?;
            surface.configure(&parts.device, &parts.config);
            Ok(Self {
                _instance: instance,
                surface: Some(surface),
                device: parts.device,
                queue: parts.queue,
                config: parts.config,
                bind_group_layout: parts.bind_group_layout,
                sampler: parts.sampler,
                ingest_pipeline: parts.ingest_pipeline,
                present_pipeline: parts.present_pipeline,
                importer: parts.importer,
                selected_adapter_id: parts.selected_adapter_id,
                device_health: parts.device_health,
            })
        }

        async fn create_device_parts(
            instance: &wgpu::Instance,
            surface: &wgpu::Surface<'_>,
            width: u32,
            height: u32,
            adapter_hint: Option<PlatformAdapterId>,
            backend: RendererBackend,
            recovery_telemetry: Arc<RecoveryTelemetry>,
        ) -> Result<GpuDeviceParts, String> {
            let adapter = select_platform_adapter(instance, surface, adapter_hint, backend).await?;
            let adapter_info = adapter.get_info();
            if adapter_info.backend != backend.expected_adapter_backend() {
                return Err(format!(
                    "accelerated compositor requires {:?}, got {:?}",
                    backend.required_backends(),
                    adapter_info.backend,
                ));
            }
            let selected_adapter_id =
                PlatformTextureImporter::adapter_id_from_wgpu_adapter(&adapter)?;
            let (device, queue) = adapter
                .request_device(&wgpu::DeviceDescriptor {
                    label: Some("Ardor accelerated OSR device"),
                    ..Default::default()
                })
                .await
                .map_err(|error| format!("failed to create wgpu device: {error}"))?;
            let device_health = Arc::new(DeviceHealth::new(recovery_telemetry.clone()));
            device.set_device_lost_callback({
                let device_health = device_health.clone();
                move |reason, message| {
                    if reason == wgpu::DeviceLostReason::Destroyed {
                        return;
                    }
                    let detail = format!("device lost reason={reason:?} message={message}");
                    debug_checkpoint(format!("gpu_compositor.device_lost {detail}"));
                    device_health.request_recovery(FailureKind::DeviceLost, detail);
                }
            });
            device.on_uncaptured_error(Arc::new({
                let device_health = device_health.clone();
                move |error| {
                    let recover = matches!(
                        error,
                        wgpu::Error::Internal { .. } | wgpu::Error::OutOfMemory { .. }
                    );
                    let detail = error.to_string();
                    device_health
                        .telemetry
                        .uncaptured_gpu_errors
                        .fetch_add(1, Ordering::Relaxed);
                    debug_checkpoint(format!("gpu_compositor.device.uncaptured {detail}"));
                    if recover {
                        device_health.request_recovery(
                            FailureKind::DeviceLost,
                            format!("uncaptured GPU error: {detail}"),
                        );
                    }
                }
            }));
            let mut config = surface
                .get_default_config(&adapter, width.max(1), height.max(1))
                .ok_or_else(|| "GPU adapter cannot present to the compositor window".to_string())?;
            config.present_mode = wgpu::PresentMode::Fifo;
            config.alpha_mode = wgpu::CompositeAlphaMode::Opaque;

            let bind_group_layout =
                device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                    label: Some("Ardor compositor texture layout"),
                    entries: &[
                        wgpu::BindGroupLayoutEntry {
                            binding: 0,
                            visibility: wgpu::ShaderStages::FRAGMENT,
                            ty: wgpu::BindingType::Texture {
                                sample_type: wgpu::TextureSampleType::Float { filterable: true },
                                view_dimension: wgpu::TextureViewDimension::D2,
                                multisampled: false,
                            },
                            count: None,
                        },
                        wgpu::BindGroupLayoutEntry {
                            binding: 1,
                            visibility: wgpu::ShaderStages::FRAGMENT,
                            ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                            count: None,
                        },
                    ],
                });
            let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: Some("Ardor compositor pipeline layout"),
                bind_group_layouts: &[Some(&bind_group_layout)],
                immediate_size: 0,
            });
            let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
                label: Some("Ardor compositor shader"),
                source: wgpu::ShaderSource::Wgsl(COMPOSITOR_SHADER_WGSL.into()),
            });
            let ingest_pipeline = create_pipeline(
                &device,
                &pipeline_layout,
                &shader,
                wgpu::TextureFormat::Rgba8UnormSrgb,
                None,
                "fs_ingest",
                "Ardor compositor color ingest pipeline",
            );
            let present_pipeline = create_pipeline(
                &device,
                &pipeline_layout,
                &shader,
                config.format,
                Some(wgpu::BlendState::PREMULTIPLIED_ALPHA_BLENDING),
                "fs_present",
                "Ardor compositor present pipeline",
            );
            let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
                label: Some("Ardor compositor sampler"),
                address_mode_u: wgpu::AddressMode::ClampToEdge,
                address_mode_v: wgpu::AddressMode::ClampToEdge,
                mag_filter: wgpu::FilterMode::Linear,
                min_filter: wgpu::FilterMode::Linear,
                ..Default::default()
            });
            let importer = PlatformTextureImporter::new(selected_adapter_id)?;
            debug_checkpoint(format!(
                "gpu_compositor.device backend={:?} name={} format={:?} adapter_id={selected_adapter_id} import_platform={}",
                adapter_info.backend,
                adapter_info.name,
                config.format,
                PlatformTextureImporter::PLATFORM
            ));
            Ok(GpuDeviceParts {
                device,
                queue,
                config,
                bind_group_layout,
                sampler,
                ingest_pipeline,
                present_pipeline,
                importer,
                selected_adapter_id,
                device_health,
            })
        }
    }

    async fn select_platform_adapter(
        instance: &wgpu::Instance,
        surface: &wgpu::Surface<'_>,
        adapter_hint: Option<PlatformAdapterId>,
        backend: RendererBackend,
    ) -> Result<wgpu::Adapter, String> {
        let adapters = instance
            .enumerate_adapters(backend.required_backends())
            .await;
        let mut inspected = Vec::new();
        for adapter in adapters {
            let info = adapter.get_info();
            if info.backend != backend.expected_adapter_backend()
                || !adapter.is_surface_supported(surface)
            {
                continue;
            }
            match PlatformTextureImporter::adapter_id_from_wgpu_adapter(&adapter) {
                Ok(adapter_id) => {
                    inspected.push(format!("{}={adapter_id}", info.name));
                    if adapter_hint.is_none_or(|expected| expected == adapter_id) {
                        return Ok(adapter);
                    }
                }
                Err(error) => inspected.push(format!("{}=<error:{error}>", info.name)),
            }
        }
        Err(format!(
            "no present-capable {:?} adapter matches CEF texture source {adapter_hint:?}; inspected [{}]",
            backend.required_backends(),
            inspected.join(", ")
        ))
    }

    impl GpuCompositor {
        async fn new(
            window: tauri::Window<Runtime>,
            width: u32,
            height: u32,
            adapter_hint: Option<PlatformAdapterId>,
            shell_webview: CefWebview,
            preview_webview: CefWebview,
        ) -> Result<Self, String> {
            let recovery_telemetry = Arc::new(RecoveryTelemetry::default());
            let gpu = GpuBackend::new(
                &window,
                width,
                height,
                adapter_hint,
                recovery_telemetry.clone(),
            )
            .await?;
            Ok(Self {
                shell_webview,
                preview_webview,
                gpu: Some(gpu),
                recovery_telemetry,
                shell: None,
                preview: None,
                preview_popup: None,
                preview_popup_rect: None,
                preview_rect: PhysicalRect::default(),
                overlay_rects: Vec::new(),
                preview_visible: false,
                layout_scale: 1.0,
                stats: GpuStats::default(),
                deferred_copies: Vec::new(),
                pending_recovery_health: None,
                present_readiness: Arc::new((
                    Mutex::new(PresentReadiness::default()),
                    Condvar::new(),
                )),
                shell_sequence: 0,
                #[cfg(all(
                    feature = "metal-integration-tests",
                    target_os = "macos",
                    target_arch = "aarch64"
                ))]
                test_runtime_failure_requested: false,
            })
        }

        fn present_readiness(&self) -> Arc<(Mutex<PresentReadiness>, Condvar)> {
            self.present_readiness.clone()
        }

        fn request_full_repaint(&self) {
            for webview in [&self.shell_webview, &self.preview_webview] {
                if let Some(host) = webview.browser().host() {
                    host.invalidate(PaintElementType::VIEW);
                }
            }
        }

        fn set_preview_layout(
            &mut self,
            preview_rect: PhysicalRect,
            overlay_rects: Vec<PhysicalRect>,
            visible: bool,
            scale: f64,
        ) {
            self.preview_rect = preview_rect;
            self.overlay_rects = overlay_rects;
            self.preview_visible = visible;
            self.layout_scale = scale;
            if !visible {
                self.preview_popup = None;
                self.preview_popup_rect = None;
            }
        }

        fn set_preview_popup_rect(&mut self, rect: Option<cef::Rect>) {
            let changed = match (&self.preview_popup_rect, &rect) {
                (Some(previous), Some(next)) => {
                    previous.x != next.x
                        || previous.y != next.y
                        || previous.width != next.width
                        || previous.height != next.height
                }
                (None, None) => false,
                _ => true,
            };
            if changed {
                self.preview_popup = None;
            }
            self.preview_popup_rect = rect;
        }

        fn snapshot(&self) -> AcceleratedCompositorStats {
            let mut snapshot = self.stats.snapshot();
            snapshot.device_lost_count = self
                .recovery_telemetry
                .device_lost_count
                .load(Ordering::Relaxed);
            snapshot.uncaptured_gpu_errors = self
                .recovery_telemetry
                .uncaptured_gpu_errors
                .load(Ordering::Relaxed);
            if let Some(gpu) = self.gpu.as_ref() {
                snapshot.selected_adapter_luid = Some(gpu.selected_adapter_id.to_string());
                snapshot.texture_import_platform = Some(PlatformTextureImporter::PLATFORM);
                snapshot.backend = Some(PlatformTextureImporter::PLATFORM);
            }
            snapshot
        }

        fn gpu(&self) -> Result<&GpuBackend, String> {
            self.gpu
                .as_ref()
                .ok_or_else(|| "GPU backend is unavailable pending recovery".to_string())
        }

        fn recover_surface_loss(&mut self, reason: &str) -> Result<(), String> {
            let adapter_luid = {
                let gpu = self.gpu.as_ref().ok_or_else(|| {
                    "GPU backend is unavailable during surface recovery".to_string()
                })?;
                let surface = gpu
                    .surface
                    .as_ref()
                    .ok_or_else(|| "wgpu surface is unavailable during recovery".to_string())?;
                debug_checkpoint(format!(
                    "gpu_compositor.rebuild.start reason={reason} adapter_id={} size={}x{}",
                    gpu.selected_adapter_id, gpu.config.width, gpu.config.height
                ));
                surface.configure(&gpu.device, &gpu.config);
                gpu.selected_adapter_id
            };
            self.stats.last_error = None;
            self.stats.surface_recovery_count = self.stats.surface_recovery_count.saturating_add(1);
            self.arm_recovery_health_check("surface");
            self.request_full_repaint();
            debug_checkpoint(format!(
                "gpu_compositor.rebuild.finish reason={reason} adapter_id={adapter_luid}"
            ));
            Ok(())
        }

        fn recover_surface_failure(
            &mut self,
            failure: FailureKind,
            reason: &str,
        ) -> Result<(), String> {
            debug_assert_eq!(
                RecoveryBudget::default().decide(failure),
                RecoveryDecision::ReconfigureSurface
            );
            self.recover_surface_loss(reason)
        }

        fn recover_device_loss(
            &mut self,
            selected_adapter_id: PlatformAdapterId,
            failure: FailureKind,
            reason: &str,
        ) -> Result<(), String> {
            request_device_restart(failure, reason.to_string())?;
            if let Some(gpu) = self.gpu.take() {
                gpu.device.destroy();
            }
            self.deferred_copies.clear();
            self.shell = None;
            self.preview = None;
            self.preview_popup = None;
            debug_checkpoint(format!(
                "gpu_compositor.session_restart.requested reason={reason} adapter_id={selected_adapter_id}"
            ));
            Ok(())
        }

        fn arm_recovery_health_check(&mut self, kind: &'static str) {
            self.pending_recovery_health = Some(RecoveryHealthCheck {
                kind,
                preview_callbacks: self.stats.preview_callbacks,
                imported_frames: self.stats.imported_frames,
                presented_frames: self.stats.presented_frames,
                import_failures: self.stats.import_failures,
                present_failures: self.stats.present_failures,
            });
        }

        fn finish_recovery_health_check_if_ready(&mut self) {
            let Some(check) = self.pending_recovery_health.as_ref() else {
                return;
            };
            let preview_delta = self
                .stats
                .preview_callbacks
                .saturating_sub(check.preview_callbacks);
            let imported_delta = self
                .stats
                .imported_frames
                .saturating_sub(check.imported_frames);
            let presented_delta = self
                .stats
                .presented_frames
                .saturating_sub(check.presented_frames);
            let import_failures_delta = self
                .stats
                .import_failures
                .saturating_sub(check.import_failures);
            let present_failures_delta = self
                .stats
                .present_failures
                .saturating_sub(check.present_failures);
            if import_failures_delta > 0 || present_failures_delta > 0 {
                let kind = check.kind;
                debug_checkpoint(format!(
                    "gpu_compositor.recovery.unhealthy kind={kind} import_failures_delta={import_failures_delta} present_failures_delta={present_failures_delta}"
                ));
                self.pending_recovery_health = None;
                return;
            }
            if preview_delta == 0
                || imported_delta == 0
                || presented_delta == 0
                || self.stats.preview_rate.fps == 0
                || self.stats.present_rate.fps == 0
            {
                return;
            }
            let kind = check.kind;
            debug_checkpoint(format!(
                "gpu_compositor.recovery.healthy kind={kind} preview_delta={preview_delta} imported_delta={imported_delta} presented_delta={presented_delta} import_failures_delta={import_failures_delta} present_failures_delta={present_failures_delta} preview_fps={} present_fps={} surface_recoveries={} device_recoveries={}",
                self.stats.preview_rate.fps,
                self.stats.present_rate.fps,
                self.stats.surface_recovery_count,
                self.stats.device_recovery_count
            ));
            self.pending_recovery_health = None;
        }

        #[cfg(windows)]
        fn defer_failed_copy(&mut self, pending: PendingGpuCopy, error: String, timed_out: bool) {
            self.stats.dropped_frames = self.stats.dropped_frames.saturating_add(1);
            if timed_out {
                self.stats.copy_timeout_count = self.stats.copy_timeout_count.saturating_add(1);
            }
            self.stats.fail_import(error.clone());
            self.deferred_copies.push(pending);
            if timed_out || self.stats.consecutive_import_failures >= 3 {
                if let Some(gpu) = self.gpu.as_ref() {
                    gpu.device_health.request_recovery(
                        if timed_out {
                            FailureKind::CopyTimeout
                        } else {
                            FailureKind::RepeatedImportFailure
                        },
                        error,
                    );
                }
            }
        }

        #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
        fn drop_failed_callback_copy(
            &mut self,
            pending: PendingGpuCopy,
            error: String,
            timed_out: bool,
        ) {
            drop(pending);
            self.stats.dropped_frames = self.stats.dropped_frames.saturating_add(1);
            if timed_out {
                self.stats.copy_timeout_count = self.stats.copy_timeout_count.saturating_add(1);
            }
            self.stats.fail_import(error.clone());
            if timed_out || self.stats.consecutive_import_failures >= 3 {
                if let Some(gpu) = self.gpu.as_ref() {
                    gpu.device_health.request_recovery(
                        if timed_out {
                            FailureKind::CopyTimeout
                        } else {
                            FailureKind::RepeatedImportFailure
                        },
                        error,
                    );
                }
            }
        }

        fn recover_pending_device_loss(
            &mut self,
            shared_texture_handle: *mut c_void,
        ) -> Result<(), String> {
            let Some((failure, reason)) = self.gpu()?.device_health.take_recovery_request() else {
                return Ok(());
            };
            let selected_adapter_id = self.gpu()?.selected_adapter_id;
            let source_adapter_id =
                PlatformTextureImporter::adapter_hint_from_shared_handle(shared_texture_handle)?
                    .unwrap_or(selected_adapter_id);
            self.recover_device_loss(source_adapter_id, failure, &reason)
        }

        fn resize(&mut self, width: u32, height: u32, preview_rect: PhysicalRect) -> bool {
            if width == 0 || height == 0 {
                return false;
            }
            let Some(gpu) = self.gpu.as_mut() else {
                return false;
            };
            if gpu.config.width == width
                && gpu.config.height == height
                && self.preview_rect == preview_rect
            {
                return false;
            }
            gpu.config.width = width;
            gpu.config.height = height;
            self.preview_rect = preview_rect;
            let Some(surface) = gpu.surface.as_ref() else {
                return false;
            };
            surface.configure(&gpu.device, &gpu.config);
            true
        }

        fn begin_ingest(
            &mut self,
            layer: Layer,
            info: &cef::AcceleratedPaintInfo,
        ) -> Result<PendingGpuCopy, String> {
            if self.gpu()?.device_health.recovery_requested() {
                return Err("GPU compositor is paused pending device recovery".to_string());
            }
            let started_at = Instant::now();
            let width = info.extra.coded_size.width.max(0) as u32;
            let height = info.extra.coded_size.height.max(0) as u32;
            self.stats.callback(layer, width, height);
            if width == 0 || height == 0 {
                return Err("CEF returned a zero-sized accelerated frame".to_string());
            }
            let format = match *info.format.as_ref() {
                cef::sys::cef_color_type_t::CEF_COLOR_TYPE_BGRA_8888 => {
                    wgpu::TextureFormat::Bgra8Unorm
                }
                cef::sys::cef_color_type_t::CEF_COLOR_TYPE_RGBA_8888 => {
                    wgpu::TextureFormat::Rgba8Unorm
                }
                value => {
                    return Err(format!("unsupported CEF color format {value:?}"));
                }
            };
            self.recover_pending_device_loss(accelerated_shared_texture_handle(info))?;
            let import_result = {
                let gpu = self.gpu()?;
                gpu.importer.import_texture(
                    &gpu.device,
                    accelerated_shared_texture_handle(info),
                    format,
                    width,
                    height,
                )
            };
            let imported = match import_result {
                Ok(imported) => {
                    self.stats.platform_texture_import.adapter_luid_checks = self
                        .stats
                        .platform_texture_import
                        .adapter_luid_checks
                        .saturating_add(1);
                    imported
                }
                Err(TextureImportError::AdapterMismatch { selected, source }) => {
                    self.stats.platform_texture_import.adapter_luid_checks = self
                        .stats
                        .platform_texture_import
                        .adapter_luid_checks
                        .saturating_add(1);
                    self.stats.platform_texture_import.adapter_mismatch_count = self
                        .stats
                        .platform_texture_import
                        .adapter_mismatch_count
                        .saturating_add(1);
                    debug_checkpoint(format!(
                        "gpu_compositor.adapter.changed selected={selected} source={source}"
                    ));
                    self.recover_device_loss(
                        source,
                        FailureKind::AdapterMismatch,
                        "CEF shared texture adapter changed",
                    )?;
                    self.stats.platform_texture_import.adapter_luid_checks = self
                        .stats
                        .platform_texture_import
                        .adapter_luid_checks
                        .saturating_add(1);
                    let gpu = self.gpu()?;
                    gpu.importer
                        .import_texture(
                            &gpu.device,
                            accelerated_shared_texture_handle(info),
                            format,
                            width,
                            height,
                        )
                        .map_err(|error| {
                            format!("shared texture import after adapter recovery failed: {error}")
                        })?
                }
                Err(error) => {
                    return Err(format!("shared texture import failed: {error}"));
                }
            };
            let ImportedTexture {
                texture: imported,
                source_adapter_id,
            } = imported;
            debug_assert_eq!(source_adapter_id, Some(self.gpu()?.selected_adapter_id));
            let imported_view = imported.create_view(&wgpu::TextureViewDescriptor::default());
            let imported_bind_group = {
                let gpu = self.gpu()?;
                gpu.device.create_bind_group(&wgpu::BindGroupDescriptor {
                    label: Some("Ardor imported CEF frame"),
                    layout: &gpu.bind_group_layout,
                    entries: &[
                        wgpu::BindGroupEntry {
                            binding: 0,
                            resource: wgpu::BindingResource::TextureView(&imported_view),
                        },
                        wgpu::BindGroupEntry {
                            binding: 1,
                            resource: wgpu::BindingResource::Sampler(&gpu.sampler),
                        },
                    ],
                })
            };
            let recreate = self
                .layer(layer)
                .is_none_or(|texture| texture.width != width || texture.height != height);
            if recreate {
                let gpu = self.gpu()?;
                let texture = gpu.device.create_texture(&wgpu::TextureDescriptor {
                    label: Some(match layer {
                        Layer::Shell => "Ardor owned shell texture",
                        Layer::Preview => "Ardor owned preview texture",
                        Layer::PreviewPopup => "Ardor owned preview popup texture",
                    }),
                    size: wgpu::Extent3d {
                        width,
                        height,
                        depth_or_array_layers: 1,
                    },
                    mip_level_count: 1,
                    sample_count: 1,
                    dimension: wgpu::TextureDimension::D2,
                    // The shader outputs linear premultiplied color. An sRGB
                    // attachment encodes it with much better dark-tone precision
                    // than an 8-bit linear target, while sampling decodes it back
                    // to linear for the final blend.
                    format: wgpu::TextureFormat::Rgba8UnormSrgb,
                    usage: wgpu::TextureUsages::RENDER_ATTACHMENT
                        | wgpu::TextureUsages::TEXTURE_BINDING,
                    view_formats: &[],
                });
                let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
                let bind_group = gpu.device.create_bind_group(&wgpu::BindGroupDescriptor {
                    label: Some("Ardor owned compositor layer"),
                    layout: &gpu.bind_group_layout,
                    entries: &[
                        wgpu::BindGroupEntry {
                            binding: 0,
                            resource: wgpu::BindingResource::TextureView(&view),
                        },
                        wgpu::BindGroupEntry {
                            binding: 1,
                            resource: wgpu::BindingResource::Sampler(&gpu.sampler),
                        },
                    ],
                });
                *self.layer_mut(layer) = Some(LayerTexture {
                    _texture: texture,
                    view,
                    bind_group,
                    width,
                    height,
                });
            }

            let target_view = &self.layer(layer).expect("owned layer was initialized").view;
            let gpu = self.gpu()?;
            let mut encoder = gpu
                .device
                .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                    label: Some("Ardor accelerated OSR copy encoder"),
                });
            {
                let color_attachments = [Some(wgpu::RenderPassColorAttachment {
                    view: target_view,
                    depth_slice: None,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
                        store: wgpu::StoreOp::Store,
                    },
                })];
                let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                    label: Some("Ardor accelerated OSR GPU copy"),
                    color_attachments: &color_attachments,
                    ..Default::default()
                });
                pass.set_pipeline(&gpu.ingest_pipeline);
                pass.set_bind_group(0, &imported_bind_group, &[]);
                pass.draw(0..3, 0..1);
            }
            let submission = gpu.queue.submit([encoder.finish()]);
            Ok(PendingGpuCopy {
                device: gpu.device.clone(),
                submission,
                _imported_texture: imported,
                _imported_view: imported_view,
                _imported_bind_group: imported_bind_group,
                layer,
                width,
                height,
                started_at,
            })
        }

        fn complete_ingest(&mut self, completed: CompletedGpuCopy) {
            self.stats.imported_frames = self.stats.imported_frames.saturating_add(1);
            self.stats.consecutive_import_failures = 0;
            if completed.layer == Layer::Shell {
                self.shell_sequence = self.shell_sequence.saturating_add(1);
            }
            self.stats.last_copy_ms = completed.elapsed_ms;
            self.stats.record_copy_ms(completed.elapsed_ms);
            if self.stats.imported_frames == 1 {
                debug_checkpoint(format!(
                    "gpu_compositor.import.first layer={} size={}x{} copy_ms={:.3}",
                    completed.layer.as_str(),
                    completed.width,
                    completed.height,
                    self.stats.last_copy_ms
                ));
            }
            self.finish_recovery_health_check_if_ready();
        }

        fn layer(&self, layer: Layer) -> Option<&LayerTexture> {
            match layer {
                Layer::Shell => self.shell.as_ref(),
                Layer::Preview => self.preview.as_ref(),
                Layer::PreviewPopup => self.preview_popup.as_ref(),
            }
        }

        fn layer_mut(&mut self, layer: Layer) -> &mut Option<LayerTexture> {
            match layer {
                Layer::Shell => &mut self.shell,
                Layer::Preview => &mut self.preview,
                Layer::PreviewPopup => &mut self.preview_popup,
            }
        }

        pub(super) fn present(&mut self) {
            #[cfg(all(
                feature = "metal-integration-tests",
                target_os = "macos",
                target_arch = "aarch64"
            ))]
            if !self.test_runtime_failure_requested
                && self.stats.presented_frames > 0
                && integration_test_flag("ARDOR_TEST_METAL_RUNTIME_RECOVERY")
            {
                self.test_runtime_failure_requested = true;
                if let Some(gpu) = self.gpu.as_ref() {
                    gpu.device_health
                        .request_recovery(FailureKind::DeviceLost, "forced Metal runtime recovery");
                }
            }
            let pending_recovery = self.gpu.as_ref().and_then(|gpu| {
                gpu.device_health
                    .take_recovery_request()
                    .map(|(failure, reason)| (gpu.selected_adapter_id, failure, reason))
            });
            if let Some((selected_adapter_id, failure, reason)) = pending_recovery {
                if let Err(error) = self.recover_device_loss(selected_adapter_id, failure, &reason)
                {
                    self.stats
                        .fail_present(format!("device recovery failed: {error}"));
                }
                return;
            }
            let Some(gpu) = self.gpu.as_ref() else {
                return;
            };
            let Some(surface) = gpu.surface.as_ref() else {
                return;
            };
            let (frame, reconfigure_after_present) = match surface.get_current_texture() {
                wgpu::CurrentSurfaceTexture::Success(frame) => (frame, false),
                wgpu::CurrentSurfaceTexture::Suboptimal(frame) => (frame, true),
                wgpu::CurrentSurfaceTexture::Outdated => {
                    if let Err(error) = self.recover_surface_failure(
                        FailureKind::SurfaceOutdated,
                        "compositor surface was outdated",
                    ) {
                        self.stats
                            .fail_present(format!("surface recovery failed: {error}"));
                    }
                    return;
                }
                wgpu::CurrentSurfaceTexture::Lost => {
                    self.stats.dropped_frames = self.stats.dropped_frames.saturating_add(1);
                    if let Err(error) = self.recover_surface_failure(
                        FailureKind::SurfaceLost,
                        "compositor surface was lost",
                    ) {
                        self.stats
                            .fail_present(format!("surface recovery failed: {error}"));
                    }
                    return;
                }
                wgpu::CurrentSurfaceTexture::Timeout => {
                    // Surface acquisition timeouts are transient. Drop this
                    // frame and let the scheduler retry instead of poisoning
                    // the compositor with a permanent present failure.
                    self.stats.dropped_frames = self.stats.dropped_frames.saturating_add(1);
                    self.stats.surface_timeout_count =
                        self.stats.surface_timeout_count.saturating_add(1);
                    if let Err(error) = self.recover_surface_failure(
                        FailureKind::SurfaceTimeout,
                        "compositor surface acquisition timed out",
                    ) {
                        self.stats
                            .fail_present(format!("surface recovery failed: {error}"));
                    }
                    return;
                }
                wgpu::CurrentSurfaceTexture::Occluded => {
                    self.stats.dropped_frames = self.stats.dropped_frames.saturating_add(1);
                    if let Err(error) = self.recover_surface_failure(
                        FailureKind::Occluded,
                        "compositor surface was occluded",
                    ) {
                        self.stats
                            .fail_present(format!("surface recovery failed: {error}"));
                    }
                    return;
                }
                wgpu::CurrentSurfaceTexture::Validation => {
                    self.stats
                        .fail_present("compositor surface validation failed");
                    return;
                }
            };
            let view = frame
                .texture
                .create_view(&wgpu::TextureViewDescriptor::default());
            let mut encoder = gpu
                .device
                .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                    label: Some("Ardor compositor present encoder"),
                });
            {
                let color_attachments = [Some(wgpu::RenderPassColorAttachment {
                    view: &view,
                    depth_slice: None,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color {
                            // Linear equivalents of the intended #0b0c0e
                            // sRGB compositor background.
                            r: 0.00335,
                            g: 0.00368,
                            b: 0.00439,
                            a: 1.0,
                        }),
                        store: wgpu::StoreOp::Store,
                    },
                })];
                let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                    label: Some("Ardor compositor present"),
                    color_attachments: &color_attachments,
                    ..Default::default()
                });
                pass.set_pipeline(&gpu.present_pipeline);
                let popup_visible =
                    self.preview_popup_rect.is_some() && self.preview_popup.is_some();
                for composition_pass in composition_passes(
                    self.preview_visible,
                    popup_visible,
                    self.overlay_rects.len(),
                ) {
                    match composition_pass {
                        CompositionPass::Preview => {
                            let Some(preview) = self.preview.as_ref() else {
                                continue;
                            };
                            let rect =
                                clamp_rect(self.preview_rect, gpu.config.width, gpu.config.height);
                            if rect.width == 0 || rect.height == 0 {
                                continue;
                            }
                            pass.set_viewport(
                                rect.x as f32,
                                rect.y as f32,
                                rect.width as f32,
                                rect.height as f32,
                                0.0,
                                1.0,
                            );
                            pass.set_scissor_rect(rect.x, rect.y, rect.width, rect.height);
                            pass.set_bind_group(0, &preview.bind_group, &[]);
                            pass.draw(0..3, 0..1);
                        }
                        CompositionPass::PreviewPopup => {
                            let (Some(popup), Some(popup_rect)) = (
                                self.preview_popup.as_ref(),
                                self.preview_popup_rect.as_ref(),
                            ) else {
                                continue;
                            };
                            let placement = popup_placement(
                                self.preview_rect,
                                popup_rect.x,
                                popup_rect.y,
                                popup_rect.width,
                                popup_rect.height,
                                self.layout_scale,
                                gpu.config.width,
                                gpu.config.height,
                            );
                            if placement.scissor.width == 0
                                || placement.scissor.height == 0
                                || placement.viewport_width == 0
                                || placement.viewport_height == 0
                            {
                                continue;
                            }
                            pass.set_viewport(
                                placement.viewport_x as f32,
                                placement.viewport_y as f32,
                                placement.viewport_width as f32,
                                placement.viewport_height as f32,
                                0.0,
                                1.0,
                            );
                            pass.set_scissor_rect(
                                placement.scissor.x,
                                placement.scissor.y,
                                placement.scissor.width,
                                placement.scissor.height,
                            );
                            pass.set_bind_group(0, &popup.bind_group, &[]);
                            pass.draw(0..3, 0..1);
                        }
                        CompositionPass::ShellOutsidePreview => {
                            let Some(shell) = self.shell.as_ref() else {
                                continue;
                            };
                            pass.set_viewport(
                                0.0,
                                0.0,
                                gpu.config.width as f32,
                                gpu.config.height as f32,
                                0.0,
                                1.0,
                            );
                            pass.set_bind_group(0, &shell.bind_group, &[]);
                            let preview_rect =
                                clamp_rect(self.preview_rect, gpu.config.width, gpu.config.height);
                            for region in shell_regions_outside_preview(
                                preview_rect,
                                gpu.config.width,
                                gpu.config.height,
                            ) {
                                if region.width == 0 || region.height == 0 {
                                    continue;
                                }
                                pass.set_scissor_rect(
                                    region.x,
                                    region.y,
                                    region.width,
                                    region.height,
                                );
                                pass.draw(0..3, 0..1);
                            }
                        }
                        CompositionPass::ShellOverlay(index) => {
                            let (Some(shell), Some(region)) =
                                (self.shell.as_ref(), self.overlay_rects.get(index).copied())
                            else {
                                continue;
                            };
                            let region = clamp_rect(region, gpu.config.width, gpu.config.height);
                            if region.width == 0 || region.height == 0 {
                                continue;
                            }
                            pass.set_viewport(
                                0.0,
                                0.0,
                                gpu.config.width as f32,
                                gpu.config.height as f32,
                                0.0,
                                1.0,
                            );
                            pass.set_bind_group(0, &shell.bind_group, &[]);
                            pass.set_scissor_rect(region.x, region.y, region.width, region.height);
                            pass.draw(0..3, 0..1);
                        }
                        CompositionPass::ShellFullWindow => {
                            let Some(shell) = self.shell.as_ref() else {
                                continue;
                            };
                            pass.set_viewport(
                                0.0,
                                0.0,
                                gpu.config.width as f32,
                                gpu.config.height as f32,
                                0.0,
                                1.0,
                            );
                            pass.set_bind_group(0, &shell.bind_group, &[]);
                            pass.set_scissor_rect(0, 0, gpu.config.width, gpu.config.height);
                            pass.draw(0..3, 0..1);
                        }
                    }
                }
            }
            gpu.queue.submit([encoder.finish()]);
            frame.present();
            if self.shell_sequence > 0 {
                let (readiness, condition) = &*self.present_readiness;
                readiness
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .record_present(Layer::Shell, self.shell_sequence);
                condition.notify_all();
            }
            if reconfigure_after_present {
                if let Some(surface) = gpu.surface.as_ref() {
                    surface.configure(&gpu.device, &gpu.config);
                }
            }
            self.stats.presented_frames = self.stats.presented_frames.saturating_add(1);
            self.stats.present_rate.tick();
            self.finish_recovery_health_check_if_ready();
            if self.stats.presented_frames == 1 {
                debug_checkpoint("gpu_compositor.present.first");
            }
        }
    }

    fn ingest_accelerated_frame(
        renderer: &Arc<Mutex<GpuCompositor>>,
        present_scheduler: &PresentScheduler,
        layer: Layer,
        info: &cef::AcceleratedPaintInfo,
    ) {
        let pending = {
            renderer
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .begin_ingest(layer, info)
        };
        let completed = match pending {
            Ok(pending) => pending.wait(GPU_COPY_WAIT_BUDGET),
            Err(error) => {
                let mut renderer = renderer
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                if renderer
                    .gpu
                    .as_ref()
                    .is_some_and(|gpu| gpu.device_health.recovery_requested())
                {
                    renderer.stats.dropped_frames = renderer.stats.dropped_frames.saturating_add(1);
                    drop(renderer);
                    present_scheduler.request();
                } else {
                    renderer.stats.fail_import(error.clone());
                    if renderer.stats.consecutive_import_failures >= 3 {
                        if let Some(gpu) = renderer.gpu.as_ref() {
                            gpu.device_health
                                .request_recovery(FailureKind::RepeatedImportFailure, error);
                            drop(renderer);
                            present_scheduler.request();
                        }
                    }
                }
                return;
            }
        };
        let mut renderer = renderer
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        match completed {
            GpuCopyWaitResult::Completed(completed) => {
                renderer.complete_ingest(completed);
                drop(renderer);
                present_scheduler.request();
            }
            GpuCopyWaitResult::TimedOut(pending) => {
                let error = format!(
                    "GPU copy exceeded the {} ms callback budget",
                    GPU_COPY_WAIT_BUDGET.as_millis()
                );
                #[cfg(windows)]
                renderer.defer_failed_copy(pending, error, true);
                #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
                renderer.drop_failed_callback_copy(pending, error, true);
                drop(renderer);
                present_scheduler.request();
            }
            GpuCopyWaitResult::Failed(pending, error) => {
                #[cfg(windows)]
                renderer.defer_failed_copy(pending, error, false);
                #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
                renderer.drop_failed_callback_copy(pending, error, false);
                drop(renderer);
                present_scheduler.request();
            }
        }
    }

    fn create_pipeline(
        device: &wgpu::Device,
        layout: &wgpu::PipelineLayout,
        shader: &wgpu::ShaderModule,
        format: wgpu::TextureFormat,
        blend: Option<wgpu::BlendState>,
        fragment_entry_point: &'static str,
        label: &'static str,
    ) -> wgpu::RenderPipeline {
        device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some(label),
            layout: Some(layout),
            vertex: wgpu::VertexState {
                module: shader,
                entry_point: Some("vs_main"),
                compilation_options: Default::default(),
                buffers: &[],
            },
            primitive: wgpu::PrimitiveState::default(),
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            fragment: Some(wgpu::FragmentState {
                module: shader,
                entry_point: Some(fragment_entry_point),
                compilation_options: Default::default(),
                targets: &[Some(wgpu::ColorTargetState {
                    format,
                    blend,
                    write_mask: wgpu::ColorWrites::ALL,
                })],
            }),
            multiview_mask: None,
            cache: None,
        })
    }

    #[derive(Default)]
    struct PlatformTextureImportStats {
        adapter_luid_checks: u64,
        adapter_mismatch_count: u64,
    }

    #[derive(Default)]
    struct GpuStats {
        shell_callbacks: u64,
        preview_callbacks: u64,
        imported_frames: u64,
        presented_frames: u64,
        import_failures: u64,
        consecutive_import_failures: u8,
        present_failures: u64,
        shell_width: u32,
        shell_height: u32,
        preview_width: u32,
        preview_height: u32,
        last_copy_ms: f64,
        copy_ms_samples: VecDeque<f64>,
        dropped_frames: u64,
        surface_recovery_count: u64,
        device_recovery_count: u64,
        surface_timeout_count: u64,
        copy_timeout_count: u64,
        platform_texture_import: PlatformTextureImportStats,
        last_error: Option<String>,
        shell_rate: RateCounter,
        preview_rate: RateCounter,
        present_rate: RateCounter,
    }

    impl GpuStats {
        const COPY_SAMPLE_CAPACITY: usize = 240;

        fn callback(&mut self, layer: Layer, width: u32, height: u32) {
            match layer {
                Layer::Shell => {
                    self.shell_callbacks = self.shell_callbacks.saturating_add(1);
                    self.shell_width = width;
                    self.shell_height = height;
                    self.shell_rate.tick();
                    if self.shell_callbacks == 1 {
                        debug_checkpoint(format!(
                            "gpu_compositor.callback.first layer=shell size={width}x{height}"
                        ));
                    }
                }
                Layer::Preview => {
                    self.preview_callbacks = self.preview_callbacks.saturating_add(1);
                    self.preview_width = width;
                    self.preview_height = height;
                    self.preview_rate.tick();
                    if self.preview_callbacks == 1 {
                        debug_checkpoint(format!(
                            "gpu_compositor.callback.first layer=preview size={width}x{height}"
                        ));
                    }
                }
                Layer::PreviewPopup => {}
            }
        }

        fn fail_import(&mut self, error: impl Into<String>) {
            let error = error.into();
            self.import_failures = self.import_failures.saturating_add(1);
            self.consecutive_import_failures = self.consecutive_import_failures.saturating_add(1);
            self.last_error = Some(error.clone());
            debug_checkpoint(format!("gpu_compositor.import.error {error}"));
        }

        fn fail_present(&mut self, error: impl Into<String>) {
            let error = error.into();
            self.present_failures = self.present_failures.saturating_add(1);
            self.last_error = Some(error.clone());
            debug_checkpoint(format!("gpu_compositor.present.error {error}"));
        }

        fn record_copy_ms(&mut self, value: f64) {
            if self.copy_ms_samples.len() == Self::COPY_SAMPLE_CAPACITY {
                self.copy_ms_samples.pop_front();
            }
            self.copy_ms_samples.push_back(value);
        }

        fn copy_percentile(&self, percentile: f64) -> f64 {
            if self.copy_ms_samples.is_empty() {
                return 0.0;
            }
            let mut samples: Vec<_> = self.copy_ms_samples.iter().copied().collect();
            samples.sort_by(f64::total_cmp);
            let rank = ((samples.len() - 1) as f64 * percentile.clamp(0.0, 1.0)).round() as usize;
            samples[rank]
        }

        fn snapshot(&self) -> AcceleratedCompositorStats {
            AcceleratedCompositorStats {
                backend: None,
                mode: CompositorMode::default(),
                shell_callbacks: self.shell_callbacks,
                preview_callbacks: self.preview_callbacks,
                imported_frames: self.imported_frames,
                presented_frames: self.presented_frames,
                import_failures: self.import_failures,
                present_failures: self.present_failures,
                shell_fps: self.shell_rate.fps,
                preview_fps: self.preview_rate.fps,
                present_fps: self.present_rate.fps,
                shell_width: self.shell_width,
                shell_height: self.shell_height,
                preview_width: self.preview_width,
                preview_height: self.preview_height,
                last_copy_ms: self.last_copy_ms,
                copy_ms_p50: self.copy_percentile(0.50),
                copy_ms_p95: self.copy_percentile(0.95),
                dropped_frames: self.dropped_frames,
                coalesced_frames: 0,
                surface_recovery_count: self.surface_recovery_count,
                device_recovery_count: self.device_recovery_count,
                device_lost_count: 0,
                surface_timeout_count: self.surface_timeout_count,
                copy_timeout_count: self.copy_timeout_count,
                uncaptured_gpu_errors: 0,
                adapter_luid_checks: self.platform_texture_import.adapter_luid_checks,
                adapter_mismatch_count: self.platform_texture_import.adapter_mismatch_count,
                selected_adapter_luid: None,
                texture_import_platform: None,
                last_error: self.last_error.clone(),
            }
        }
    }

    #[derive(Default)]
    struct RateCounter {
        started_at: Option<Instant>,
        frames: u32,
        fps: u32,
    }

    impl RateCounter {
        fn tick(&mut self) {
            let now = Instant::now();
            let started_at = self.started_at.get_or_insert(now);
            self.frames = self.frames.saturating_add(1);
            let elapsed = now.duration_since(*started_at);
            if elapsed >= Duration::from_millis(700) {
                self.fps = ((self.frames as f64 / elapsed.as_secs_f64()).round() as u32).min(1000);
                self.frames = 0;
                self.started_at = Some(now);
            }
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn copy_latency_percentiles_use_the_bounded_recent_window() {
            let mut stats = GpuStats::default();
            for value in 1..=GpuStats::COPY_SAMPLE_CAPACITY + 20 {
                stats.record_copy_ms(value as f64);
            }
            assert_eq!(stats.copy_ms_samples.len(), GpuStats::COPY_SAMPLE_CAPACITY);
            assert_eq!(stats.copy_percentile(0.50), 141.0);
            assert_eq!(stats.copy_percentile(0.95), 248.0);
        }

        #[test]
        fn device_health_coalesces_recovery_requests() {
            let telemetry = Arc::new(RecoveryTelemetry::default());
            let health = DeviceHealth::new(telemetry.clone());
            health.request_recovery(FailureKind::DeviceLost, "first");
            health.request_recovery(FailureKind::CopyTimeout, "latest");
            assert_eq!(telemetry.device_lost_count.load(Ordering::Relaxed), 1);
            assert_eq!(
                health.take_recovery_request(),
                Some((FailureKind::CopyTimeout, "latest".to_string()))
            );
            assert!(health.take_recovery_request().is_none());
        }
    }
}
