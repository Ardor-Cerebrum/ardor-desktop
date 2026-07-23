#[cfg(windows)]
use super::{
    is_allowed_sidebar_navigation, BrowserBounds, BrowserOverlay, SidebarBrowserAction,
    SidebarBrowserInput, SidebarBrowserInputKind, SidebarBrowserState,
    DEVICE_PERMISSION_DEFENSE_IN_DEPTH,
};
#[cfg(windows)]
use crate::runtime::{
    DesktopAppHandle as AppHandle, DesktopRuntime as Runtime, DesktopWebview as Webview,
};
#[cfg(windows)]
use serde::Serialize;

#[cfg(windows)]
#[path = "windows_gpu_compositor/texture_import.rs"]
mod texture_import;

const SHELL_LABEL_PREFIX: &str = "offscreen-browser-gpu-shell-";
const PREVIEW_LABEL_PREFIX: &str = "offscreen-browser-gpu-preview-";
#[cfg(windows)]
const INITIAL_PREVIEW_URL: &str = "about:blank";

#[cfg(windows)]
fn debug_checkpoint(message: impl AsRef<str>) {
    eprintln!("[sidebar-compositor] {}", message.as_ref());
}

pub(crate) fn is_shell_label(label: &str) -> bool {
    label.starts_with(SHELL_LABEL_PREFIX)
}

pub(crate) fn is_preview_label(label: &str) -> bool {
    label.starts_with(PREVIEW_LABEL_PREFIX)
}

#[cfg(windows)]
pub(crate) fn shell_label(generation: u64) -> String {
    format!("{SHELL_LABEL_PREFIX}{generation}")
}

#[cfg(windows)]
pub(crate) fn window_label(generation: u64) -> String {
    format!("gpu-compositor-window-{generation}")
}

#[derive(Default)]
pub struct AcceleratedCompositorState {
    #[cfg(windows)]
    inner: windows_impl::StateInner,
}

#[cfg(windows)]
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcceleratedCompositorStats {
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

#[cfg(windows)]
pub fn start_device_recovery_coordinator(app: AppHandle) {
    windows_impl::start_device_recovery_coordinator(app);
}

impl AcceleratedCompositorState {
    #[cfg(windows)]
    pub async fn start(&self, app: &AppHandle) -> Result<u64, String> {
        let url = tauri::Url::parse(INITIAL_PREVIEW_URL).expect("valid blank preview URL");
        self.inner.open(app, url).await
    }

    #[cfg(windows)]
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

    #[cfg(windows)]
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

    #[cfg(windows)]
    pub fn close_preview(&self, generation: u64) -> Result<bool, String> {
        self.inner.close_preview(generation)
    }

    #[cfg(windows)]
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

    #[cfg(windows)]
    pub fn input_preview(&self, input: super::SidebarBrowserInput) -> bool {
        self.inner.input_preview(input)
    }
}

#[cfg(windows)]
mod windows_impl {
    use super::*;
    use cef::{ImplBrowser, ImplBrowserHost, PaintElementType};
    use std::{
        collections::{HashMap, VecDeque},
        ffi::c_void,
        sync::{
            atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering},
            mpsc, Arc, Condvar, Mutex, OnceLock,
        },
        thread::{self, JoinHandle},
        time::{Duration, Instant},
    };
    use tauri::{
        webview::{NewWindowResponse, WebviewBuilder},
        window::WindowBuilder,
        LogicalPosition, LogicalSize, Manager, Rect, Size, WebviewUrl, WindowEvent,
    };
    use tauri_runtime_cef::{OffscreenSurface, Webview as CefWebview};
    use texture_import::{
        AdapterLuid, ImportedTexture, TextureImportError, TextureImporter,
        WindowsDx12TextureImporter,
    };

    const WINDOW_WIDTH: f64 = 1440.0;
    const WINDOW_HEIGHT: f64 = 900.0;
    const WINDOW_MIN_WIDTH: f64 = 1024.0;
    const WINDOW_MIN_HEIGHT: f64 = 720.0;
    const SUBCLASS_ID: usize = 0x4152_444f_5247_5055;
    const FOCUSED_SHELL: u8 = 0;
    const FOCUSED_PREVIEW: u8 = 1;
    const ACTIVE_FRAME_RATE: u8 = 60;
    const BACKGROUND_FRAME_RATE: u8 = 15;
    const HIDDEN_FRAME_RATE: u8 = 1;
    const GPU_COPY_WAIT_BUDGET: Duration = Duration::from_millis(50);
    static DEVICE_RECOVERY_TX: OnceLock<mpsc::Sender<String>> = OnceLock::new();
    static DEVICE_RESTART_PENDING: AtomicBool = AtomicBool::new(false);

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    struct RenderActivityPolicy {
        frame_rate: u8,
        hidden: bool,
    }

    fn render_activity_policy(focused: bool, hidden: bool) -> RenderActivityPolicy {
        if hidden {
            RenderActivityPolicy {
                frame_rate: HIDDEN_FRAME_RATE,
                hidden: true,
            }
        } else if focused {
            RenderActivityPolicy {
                frame_rate: ACTIVE_FRAME_RATE,
                hidden: false,
            }
        } else {
            RenderActivityPolicy {
                frame_rate: BACKGROUND_FRAME_RATE,
                hidden: false,
            }
        }
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
    }

    struct PendingPreview {
        generation: u64,
        url: Option<tauri::Url>,
        bounds: BrowserBounds,
        visible: bool,
        overlays: Vec<BrowserOverlay>,
    }

    impl StateInner {
        pub async fn open(&self, app: &AppHandle, url: tauri::Url) -> Result<u64, String> {
            let _operation = self.operations.lock().await;
            self.open_locked(app, url).await
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

            let (shell_surface, shell_platform) = inspect_accelerated(&shell).await?;
            let (preview_surface, preview_platform) = inspect_accelerated(&preview).await?;
            let adapter_luid = probe_accelerated_adapter_luid(&preview_surface, &preview).await?;
            debug_checkpoint(format!(
                "gpu_compositor.adapter.probed source=preview luid={adapter_luid}"
            ));
            let renderer = Arc::new(Mutex::new(
                GpuCompositor::new(
                    window.clone(),
                    physical_size.width,
                    physical_size.height,
                    adapter_luid,
                    shell_platform.clone(),
                    preview_platform.clone(),
                )
                .await?,
            ));
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
            let input_hook = InputHook::install(&window, router.clone())?;
            let present_scheduler = PresentScheduler::start(renderer.clone())?;

            {
                let renderer = renderer.clone();
                let present_scheduler = present_scheduler.clone();
                shell_surface.set_accelerated_paint_handler(move |type_, info| {
                    if type_ == PaintElementType::VIEW {
                        ingest_accelerated_frame(&renderer, &present_scheduler, Layer::Shell, info);
                    }
                });
            }
            {
                let renderer = renderer.clone();
                let present_scheduler = present_scheduler.clone();
                preview_surface.set_accelerated_paint_handler(move |type_, info| {
                    if type_ == PaintElementType::VIEW {
                        ingest_accelerated_frame(
                            &renderer,
                            &present_scheduler,
                            Layer::Preview,
                            info,
                        );
                    }
                });
            }

            invalidate(&shell)?;
            invalidate(&preview)?;

            let session = Session {
                generation,
                active_preview_generation: AtomicU64::new(0),
                preview_visible: AtomicBool::new(false),
                window: window.clone(),
                shell,
                preview,
                shell_surface,
                preview_surface,
                renderer: renderer.clone(),
                present_scheduler,
                router: router.clone(),
                focused: AtomicBool::new(true),
                hidden: AtomicBool::new(false),
                last_layout: Mutex::new(None),
                _input_hook: input_hook,
            };
            *self
                .session
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(session);
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

            let session_slot = self.session.clone();
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
                WindowEvent::Destroyed => {
                    debug_checkpoint("gpu_compositor.window.destroyed");
                    session_slot
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner())
                        .take();
                }
                _ => {}
            });

            window
                .show()
                .map_err(|error| format!("failed to show compositor window: {error}"))?;
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
            let scale = session.router.scale();
            session.router.set_layout(rect, &overlay_rects, visible);
            session.preview_visible.store(visible, Ordering::Release);
            session
                .preview
                .set_bounds(Rect {
                    position: tauri::Position::Logical(LogicalPosition::new(0.0, 0.0)),
                    size: Size::Logical(LogicalSize::new(
                        rect.width.max(1.0),
                        rect.height.max(1.0),
                    )),
                })
                .map_err(|error| format!("failed to resize accelerated preview: {error}"))?;
            session
                .renderer
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .set_preview_layout(
                    rect.to_physical(scale),
                    overlay_rects
                        .into_iter()
                        .map(|overlay| overlay.to_physical(scale))
                        .collect(),
                    visible,
                );
            session.present_scheduler.request();
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
            session.router.set_layout(
                LogicalRect {
                    x: 0.0,
                    y: 0.0,
                    width: 1.0,
                    height: 1.0,
                },
                &[],
                false,
            );
            session
                .preview
                .navigate(tauri::Url::parse(INITIAL_PREVIEW_URL).expect("valid blank URL"))
                .map_err(|error| format!("failed to clear accelerated preview: {error}"))?;
            session
                .renderer
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .set_preview_layout(PhysicalRect::default(), Vec::new(), false);
            session.present_scheduler.request();
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
            let url = self
                .current_url
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .clone()
                .ok_or_else(|| "device recovery has no active compositor URL".to_string())?;
            debug_checkpoint(format!(
                "gpu_compositor.session_restart.start reason={reason}"
            ));
            self.close_locked()?;
            thread::sleep(Duration::from_millis(200));
            let generation = self.open_locked(app, url).await?;
            let snapshot =
                wait_for_rendering(self, "rendering after device session restart", |snapshot| {
                    snapshot.preview_fps > 0
                        && snapshot.present_fps > 0
                        && snapshot.imported_frames > 0
                        && snapshot.presented_frames > 0
                        && snapshot.import_failures == 0
                        && snapshot.present_failures == 0
                })?;
            let device_recoveries = self
                .device_restart_count
                .fetch_add(1, Ordering::Relaxed)
                .saturating_add(1);
            debug_checkpoint(format!(
                "gpu_compositor.recovery.healthy kind=device preview_delta={} imported_delta={} presented_delta={} import_failures_delta=0 present_failures_delta=0 preview_fps={} present_fps={} surface_recoveries={} device_recoveries={device_recoveries}",
                snapshot.preview_callbacks,
                snapshot.imported_frames,
                snapshot.presented_frames,
                snapshot.preview_fps,
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
            session
                .window
                .close()
                .map_err(|error| format!("failed to close compositor window: {error}"))?;
            drop(session);
            Ok(true)
        }

        pub fn stats(&self) -> Option<AcceleratedCompositorStats> {
            let guard = self
                .session
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let session = guard.as_ref()?;
            let mut snapshot = session
                .renderer
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .snapshot();
            snapshot.device_recovery_count = snapshot
                .device_recovery_count
                .saturating_add(self.device_restart_count.load(Ordering::Relaxed));
            snapshot.coalesced_frames = session.present_scheduler.coalesced_frames();
            let now = Instant::now();
            let mut last_stats_log = self
                .last_stats_log
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if last_stats_log
                .is_none_or(|last_logged| now.duration_since(last_logged) >= Duration::from_secs(2))
            {
                debug_checkpoint(format!(
                    "gpu_compositor.stats shell_fps={} preview_fps={} present_fps={} copy_ms={:.3} copy_p95_ms={:.3} imported={} dropped={} coalesced={} recoveries={} failures={} adapter_luid={}",
                    snapshot.shell_fps,
                    snapshot.preview_fps,
                    snapshot.present_fps,
                    snapshot.last_copy_ms,
                    snapshot.copy_ms_p95,
                    snapshot.imported_frames,
                    snapshot.dropped_frames,
                    snapshot.coalesced_frames,
                    snapshot.surface_recovery_count.saturating_add(snapshot.device_recovery_count),
                    snapshot.import_failures.saturating_add(snapshot.present_failures)
                    ,snapshot.selected_adapter_luid.as_deref().unwrap_or("unknown")
                ));
                *last_stats_log = Some(now);
            }
            Some(snapshot)
        }
    }

    fn request_device_restart(reason: impl Into<String>) -> Result<(), String> {
        if DEVICE_RESTART_PENDING.swap(true, Ordering::AcqRel) {
            return Ok(());
        }
        let reason = reason.into();
        let Some(sender) = DEVICE_RECOVERY_TX.get() else {
            DEVICE_RESTART_PENDING.store(false, Ordering::Release);
            return Err("device recovery coordinator is not initialized".to_string());
        };
        sender.send(reason).map_err(|error| {
            DEVICE_RESTART_PENDING.store(false, Ordering::Release);
            format!("failed to schedule compositor session restart: {error}")
        })
    }

    pub fn start_device_recovery_coordinator(app: AppHandle) {
        if DEVICE_RECOVERY_TX.get().is_some() {
            return;
        }
        let (sender, receiver) = mpsc::channel::<String>();
        if DEVICE_RECOVERY_TX.set(sender).is_err() {
            return;
        }
        let _ = thread::Builder::new()
            .name("ardor-gpu-recovery".to_string())
            .spawn(move || {
                while let Ok(reason) = receiver.recv() {
                    let result = tauri::async_runtime::block_on(async {
                        let state = app.state::<SidebarBrowserState>();
                        state.compositor.inner.restart_current(&app, &reason).await
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

    fn wait_for_rendering(
        state: &StateInner,
        description: &str,
        predicate: impl Fn(&AcceleratedCompositorStats) -> bool,
    ) -> Result<AcceleratedCompositorStats, String> {
        let deadline = Instant::now() + Duration::from_secs(30);
        while Instant::now() < deadline {
            if let Some(snapshot) = state.stats() {
                if predicate(&snapshot) {
                    return Ok(snapshot);
                }
            }
            thread::sleep(Duration::from_millis(100));
        }
        Err(format!("timed out waiting for {description}"))
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
        renderer: Arc<Mutex<GpuCompositor>>,
        present_scheduler: Arc<PresentScheduler>,
        router: Arc<InputRouter>,
        focused: AtomicBool,
        hidden: AtomicBool,
        last_layout: Mutex<Option<LayoutSignature>>,
        _input_hook: InputHook,
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
            let policy = render_activity_policy(
                self.focused.load(Ordering::Acquire),
                self.hidden.load(Ordering::Acquire),
            );
            apply_webview_activity(&self.router.shell, policy);
            apply_webview_activity(&self.router.preview, policy);
            self.present_scheduler.set_frame_rate(policy.frame_rate);
            debug_checkpoint(format!(
                "gpu_compositor.activity focused={} hidden={} frame_rate={}",
                self.focused.load(Ordering::Relaxed),
                policy.hidden,
                policy.frame_rate
            ));
        }
    }

    impl Drop for Session {
        fn drop(&mut self) {
            self.focused.store(false, Ordering::Release);
            self.hidden.store(true, Ordering::Release);
            self.apply_render_activity();
            self.shell_surface.clear_accelerated_paint_handler();
            self.preview_surface.clear_accelerated_paint_handler();
            self.present_scheduler.stop();
            let _ = self.shell.close();
            let _ = self.preview.close();
        }
    }

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    struct LayoutSignature {
        width: u32,
        height: u32,
        scale_bits: u64,
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
        let signature = LayoutSignature {
            width: physical_size.width,
            height: physical_size.height,
            scale_bits: scale.to_bits(),
        };
        {
            let last_layout = session
                .last_layout
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if last_layout.as_ref() == Some(&signature) {
                return;
            }
        }
        let logical_size = physical_size.to_logical::<f64>(scale);
        let (preview, overlay_rects, preview_visible) = session.router.layout();
        session.router.set_scale(scale);
        let shell_bounds = session.shell.set_bounds(Rect {
            position: tauri::Position::Logical(LogicalPosition::new(0.0, 0.0)),
            size: Size::Logical(logical_size),
        });
        let preview_bounds = session.preview.set_bounds(Rect {
            position: tauri::Position::Logical(LogicalPosition::new(0.0, 0.0)),
            size: Size::Logical(LogicalSize::new(preview.width, preview.height)),
        });
        if shell_bounds.is_ok() && preview_bounds.is_ok() {
            *session
                .last_layout
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(signature);
        } else {
            debug_checkpoint(format!(
                "gpu_compositor.resize.bounds_error shell={shell_bounds:?} preview={preview_bounds:?}"
            ));
        }
        let resized = session
            .renderer
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .resize(
                physical_size.width,
                physical_size.height,
                preview.to_physical(scale),
            );
        session
            .renderer
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .set_preview_layout(
                preview.to_physical(scale),
                overlay_rects
                    .into_iter()
                    .map(|overlay| overlay.to_physical(scale))
                    .collect(),
                preview_visible,
            );
        if resized {
            session.present_scheduler.request();
        }
    }

    fn apply_webview_activity(webview: &CefWebview, policy: RenderActivityPolicy) {
        if let Some(host) = webview.browser().host() {
            host.set_windowless_frame_rate(i32::from(policy.frame_rate));
            host.was_hidden(i32::from(policy.hidden));
        }
    }

    struct PresentScheduler {
        state: Arc<PresentSchedulerState>,
        thread: Mutex<Option<JoinHandle<()>>>,
    }

    struct PresentSchedulerState {
        running: AtomicBool,
        frame_rate: AtomicU8,
        dirty: Mutex<bool>,
        coalesced_frames: AtomicU64,
        wake: Condvar,
    }

    impl PresentScheduler {
        fn start(renderer: Arc<Mutex<GpuCompositor>>) -> Result<Arc<Self>, String> {
            let state = Arc::new(PresentSchedulerState {
                running: AtomicBool::new(true),
                frame_rate: AtomicU8::new(ACTIVE_FRAME_RATE),
                dirty: Mutex::new(false),
                coalesced_frames: AtomicU64::new(0),
                wake: Condvar::new(),
            });
            let thread_state = state.clone();
            let thread = thread::Builder::new()
                .name("ardor-gpu-present".to_string())
                .spawn(move || run_present_loop(renderer, thread_state))
                .map_err(|error| format!("failed to spawn GPU present scheduler: {error}"))?;
            Ok(Arc::new(Self {
                state,
                thread: Mutex::new(Some(thread)),
            }))
        }

        fn request(&self) {
            if !self.state.running.load(Ordering::Acquire) {
                return;
            }
            let mut dirty = self
                .state
                .dirty
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if *dirty {
                self.state.coalesced_frames.fetch_add(1, Ordering::Relaxed);
            }
            *dirty = true;
            drop(dirty);
            self.state.wake.notify_one();
        }

        fn coalesced_frames(&self) -> u64 {
            self.state.coalesced_frames.load(Ordering::Relaxed)
        }

        fn set_frame_rate(&self, frame_rate: u8) {
            let frame_rate = frame_rate.clamp(HIDDEN_FRAME_RATE, ACTIVE_FRAME_RATE);
            if self.state.frame_rate.swap(frame_rate, Ordering::AcqRel) != frame_rate {
                *self
                    .state
                    .dirty
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner()) = true;
                self.state.wake.notify_all();
            }
        }

        fn stop(&self) {
            if self.state.running.swap(false, Ordering::AcqRel) {
                self.state.wake.notify_all();
            }
            let thread = self
                .thread
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .take();
            if let Some(thread) = thread {
                let _ = thread.join();
            }
        }
    }

    impl Drop for PresentScheduler {
        fn drop(&mut self) {
            self.stop();
        }
    }

    fn run_present_loop(renderer: Arc<Mutex<GpuCompositor>>, state: Arc<PresentSchedulerState>) {
        let mut next_present = Instant::now();
        let mut last_frame_rate = state.frame_rate.load(Ordering::Acquire);

        while state.running.load(Ordering::Acquire) {
            let mut dirty = state
                .dirty
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            while !*dirty && state.running.load(Ordering::Acquire) {
                dirty = state
                    .wake
                    .wait(dirty)
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
            }
            if !state.running.load(Ordering::Acquire) {
                break;
            }

            loop {
                let now = Instant::now();
                let frame_rate = state.frame_rate.load(Ordering::Acquire).max(1);
                if frame_rate != last_frame_rate {
                    next_present = now;
                    last_frame_rate = frame_rate;
                }
                if now >= next_present {
                    break;
                }
                let timeout = next_present.saturating_duration_since(now);
                let (guard, _) = state
                    .wake
                    .wait_timeout(dirty, timeout)
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                dirty = guard;
                if !state.running.load(Ordering::Acquire) {
                    return;
                }
            }

            let frame_interval = Duration::from_secs_f64(1.0 / f64::from(last_frame_rate));
            *dirty = false;
            drop(dirty);
            renderer
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .present();
            next_present += frame_interval;
            let now = Instant::now();
            if next_present < now {
                next_present = now;
            }
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

    async fn probe_accelerated_adapter_luid(
        surface: &OffscreenSurface,
        webview: &Webview,
    ) -> Result<AdapterLuid, String> {
        const PROBE_TIMEOUT: Duration = Duration::from_secs(8);

        let (sender, receiver) = mpsc::sync_channel(1);
        let sent = Arc::new(AtomicBool::new(false));
        surface.set_accelerated_paint_handler({
            let sent = sent.clone();
            move |type_, info| {
                if type_ != PaintElementType::VIEW || sent.swap(true, Ordering::AcqRel) {
                    return;
                }
                let result = WindowsDx12TextureImporter::adapter_id_from_shared_handle(
                    info.shared_texture_handle,
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

    #[derive(Clone, Copy, Debug)]
    struct LogicalRect {
        x: f64,
        y: f64,
        width: f64,
        height: f64,
    }

    impl LogicalRect {
        fn contains(self, x: f64, y: f64) -> bool {
            x >= self.x && y >= self.y && x < self.x + self.width && y < self.y + self.height
        }

        fn to_physical(self, scale: f64) -> PhysicalRect {
            PhysicalRect {
                x: (self.x * scale).round().max(0.0) as u32,
                y: (self.y * scale).round().max(0.0) as u32,
                width: (self.width * scale).round().max(1.0) as u32,
                height: (self.height * scale).round().max(1.0) as u32,
            }
        }
    }

    impl From<BrowserBounds> for LogicalRect {
        fn from(bounds: BrowserBounds) -> Self {
            Self {
                x: bounds.x,
                y: bounds.y,
                width: bounds.width,
                height: bounds.height,
            }
        }
    }

    #[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
    struct PhysicalRect {
        x: u32,
        y: u32,
        width: u32,
        height: u32,
    }

    #[derive(Clone, Copy)]
    enum Layer {
        Shell,
        Preview,
    }

    impl Layer {
        fn as_str(self) -> &'static str {
            match self {
                Self::Shell => "shell",
                Self::Preview => "preview",
            }
        }
    }

    const COMPOSITOR_SHADER_WGSL: &str = r#"
struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) index: u32) -> VertexOutput {
  var positions = array<vec2<f32>, 3>(
    vec2<f32>(-1.0,  3.0),
    vec2<f32>(-1.0, -1.0),
    vec2<f32>( 3.0, -1.0),
  );
  var uvs = array<vec2<f32>, 3>(
    vec2<f32>(0.0, -1.0),
    vec2<f32>(0.0,  1.0),
    vec2<f32>(2.0,  1.0),
  );
  var output: VertexOutput;
  output.position = vec4<f32>(positions[index], 0.0, 1.0);
  output.uv = uvs[index];
  return output;
}

@group(0) @binding(0) var source_texture: texture_2d<f32>;
@group(0) @binding(1) var source_sampler: sampler;

fn srgb_to_linear(value: vec3<f32>) -> vec3<f32> {
  let low = value / vec3<f32>(12.92);
  let high = pow(
    (value + vec3<f32>(0.055)) / vec3<f32>(1.055),
    vec3<f32>(2.4),
  );
  return select(low, high, value > vec3<f32>(0.04045));
}

@fragment
fn fs_ingest(input: VertexOutput) -> @location(0) vec4<f32> {
  let encoded = textureSample(source_texture, source_sampler, input.uv);
  if encoded.a <= 0.00001 {
    return vec4<f32>(0.0);
  }

  // Chromium OSR surfaces contain premultiplied sRGB values. Convert once
  // while ingesting a changed frame; the hot presentation pass stays trivial.
  let straight_srgb = clamp(encoded.rgb / encoded.a, vec3<f32>(0.0), vec3<f32>(1.0));
  let straight_linear = srgb_to_linear(straight_srgb);
  return vec4<f32>(straight_linear * encoded.a, encoded.a);
}

@fragment
fn fs_present(input: VertexOutput) -> @location(0) vec4<f32> {
  return textureSample(source_texture, source_sampler, input.uv);
}
"#;

    struct LayerTexture {
        _texture: wgpu::Texture,
        view: wgpu::TextureView,
        bind_group: wgpu::BindGroup,
        width: u32,
        height: u32,
    }

    struct GpuCompositor {
        shell_webview: CefWebview,
        preview_webview: CefWebview,
        gpu: Option<GpuBackend>,
        recovery_telemetry: Arc<RecoveryTelemetry>,
        shell: Option<LayerTexture>,
        preview: Option<LayerTexture>,
        preview_rect: PhysicalRect,
        overlay_rects: Vec<PhysicalRect>,
        preview_visible: bool,
        stats: GpuStats,
        deferred_copies: Vec<PendingGpuCopy>,
        pending_recovery_health: Option<RecoveryHealthCheck>,
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
        importer: WindowsDx12TextureImporter,
        selected_adapter_luid: AdapterLuid,
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
        importer: WindowsDx12TextureImporter,
        selected_adapter_luid: AdapterLuid,
        device_health: Arc<DeviceHealth>,
    }

    #[derive(Default)]
    struct RecoveryTelemetry {
        device_lost_count: AtomicU64,
        uncaptured_gpu_errors: AtomicU64,
    }

    struct DeviceHealth {
        recovery_requested: AtomicBool,
        last_reason: Mutex<Option<String>>,
        telemetry: Arc<RecoveryTelemetry>,
    }

    impl DeviceHealth {
        fn new(telemetry: Arc<RecoveryTelemetry>) -> Self {
            Self {
                recovery_requested: AtomicBool::new(false),
                last_reason: Mutex::new(None),
                telemetry,
            }
        }

        fn request_recovery(&self, reason: impl Into<String>) {
            let reason = reason.into();
            if !self.recovery_requested.swap(true, Ordering::AcqRel) {
                self.telemetry
                    .device_lost_count
                    .fetch_add(1, Ordering::Relaxed);
            }
            *self
                .last_reason
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(reason);
        }

        fn take_recovery_reason(&self) -> Option<String> {
            if !self.recovery_requested.swap(false, Ordering::AcqRel) {
                return None;
            }
            self.last_reason
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .take()
                .or_else(|| Some("wgpu device loss requested recovery".to_string()))
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
            selected_adapter_luid: AdapterLuid,
            recovery_telemetry: Arc<RecoveryTelemetry>,
        ) -> Result<Self, String> {
            let mut descriptor = wgpu::InstanceDescriptor::new_without_display_handle();
            descriptor.backends = wgpu::Backends::DX12;
            let instance = wgpu::Instance::new(descriptor);
            let surface = instance
                .create_surface(window.clone())
                .map_err(|error| format!("failed to create wgpu surface: {error}"))?;
            let parts = Self::create_device_parts(
                &instance,
                &surface,
                width,
                height,
                selected_adapter_luid,
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
                selected_adapter_luid: parts.selected_adapter_luid,
                device_health: parts.device_health,
            })
        }

        async fn create_device_parts(
            instance: &wgpu::Instance,
            surface: &wgpu::Surface<'_>,
            width: u32,
            height: u32,
            selected_adapter_luid: AdapterLuid,
            recovery_telemetry: Arc<RecoveryTelemetry>,
        ) -> Result<GpuDeviceParts, String> {
            let adapter = select_adapter_by_luid(instance, surface, selected_adapter_luid).await?;
            let adapter_info = adapter.get_info();
            if adapter_info.backend != wgpu::Backend::Dx12 {
                return Err(format!(
                    "accelerated compositor requires DX12, got {:?}",
                    adapter_info.backend
                ));
            }
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
                    device_health.request_recovery(detail);
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
                        device_health.request_recovery(format!("uncaptured GPU error: {detail}"));
                    }
                }
            }));
            let mut config = surface
                .get_default_config(&adapter, width.max(1), height.max(1))
                .ok_or_else(|| {
                    "DX12 adapter cannot present to the compositor window".to_string()
                })?;
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
            let importer = WindowsDx12TextureImporter::new(selected_adapter_luid)?;
            debug_checkpoint(format!(
                "gpu_compositor.device backend={:?} name={} format={:?} adapter_luid={selected_adapter_luid} import_platform={}",
                adapter_info.backend,
                adapter_info.name,
                config.format,
                WindowsDx12TextureImporter::PLATFORM
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
                selected_adapter_luid,
                device_health,
            })
        }
    }

    async fn select_adapter_by_luid(
        instance: &wgpu::Instance,
        surface: &wgpu::Surface<'_>,
        selected_adapter_luid: AdapterLuid,
    ) -> Result<wgpu::Adapter, String> {
        let adapters = instance.enumerate_adapters(wgpu::Backends::DX12).await;
        let mut inspected = Vec::new();
        for adapter in adapters {
            let info = adapter.get_info();
            if info.backend != wgpu::Backend::Dx12 || !adapter.is_surface_supported(surface) {
                continue;
            }
            match WindowsDx12TextureImporter::adapter_id_from_wgpu_adapter(&adapter) {
                Ok(adapter_luid) => {
                    inspected.push(format!("{}={adapter_luid}", info.name));
                    if adapter_luid == selected_adapter_luid {
                        return Ok(adapter);
                    }
                }
                Err(error) => inspected.push(format!("{}=<error:{error}>", info.name)),
            }
        }
        Err(format!(
            "no present-capable DX12 adapter matches CEF adapter LUID {selected_adapter_luid}; inspected [{}]",
            inspected.join(", ")
        ))
    }

    impl GpuCompositor {
        async fn new(
            window: tauri::Window<Runtime>,
            width: u32,
            height: u32,
            selected_adapter_luid: AdapterLuid,
            shell_webview: CefWebview,
            preview_webview: CefWebview,
        ) -> Result<Self, String> {
            let recovery_telemetry = Arc::new(RecoveryTelemetry::default());
            let gpu = GpuBackend::new(
                &window,
                width,
                height,
                selected_adapter_luid,
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
                preview_rect: PhysicalRect::default(),
                overlay_rects: Vec::new(),
                preview_visible: false,
                stats: GpuStats::default(),
                deferred_copies: Vec::new(),
                pending_recovery_health: None,
            })
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
        ) {
            self.preview_rect = preview_rect;
            self.overlay_rects = overlay_rects;
            self.preview_visible = visible;
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
                snapshot.selected_adapter_luid = Some(gpu.selected_adapter_luid.to_string());
                snapshot.texture_import_platform = Some(WindowsDx12TextureImporter::PLATFORM);
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
                    "gpu_compositor.rebuild.start reason={reason} adapter_luid={} size={}x{}",
                    gpu.selected_adapter_luid, gpu.config.width, gpu.config.height
                ));
                surface.configure(&gpu.device, &gpu.config);
                gpu.selected_adapter_luid
            };
            self.stats.last_error = None;
            self.stats.surface_recovery_count = self.stats.surface_recovery_count.saturating_add(1);
            self.arm_recovery_health_check("surface");
            self.request_full_repaint();
            debug_checkpoint(format!(
                "gpu_compositor.rebuild.finish reason={reason} adapter_luid={adapter_luid}"
            ));
            Ok(())
        }

        fn recover_device_loss(
            &mut self,
            selected_adapter_luid: AdapterLuid,
            reason: &str,
        ) -> Result<(), String> {
            request_device_restart(reason.to_string())?;
            if let Some(gpu) = self.gpu.take() {
                gpu.device.destroy();
            }
            self.deferred_copies.clear();
            self.shell = None;
            self.preview = None;
            debug_checkpoint(format!(
                "gpu_compositor.session_restart.requested reason={reason} adapter_luid={selected_adapter_luid}"
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

        fn defer_failed_copy(&mut self, pending: PendingGpuCopy, error: String, timed_out: bool) {
            self.stats.dropped_frames = self.stats.dropped_frames.saturating_add(1);
            if timed_out {
                self.stats.copy_timeout_count = self.stats.copy_timeout_count.saturating_add(1);
            }
            self.stats.fail_import(error.clone());
            self.deferred_copies.push(pending);
            if let Some(gpu) = self.gpu.as_ref() {
                gpu.device_health.request_recovery(error);
            }
        }

        fn recover_pending_device_loss(
            &mut self,
            shared_texture_handle: *mut c_void,
        ) -> Result<(), String> {
            let Some(reason) = self.gpu()?.device_health.take_recovery_reason() else {
                return Ok(());
            };
            let source_adapter_luid =
                WindowsDx12TextureImporter::adapter_id_from_shared_handle(shared_texture_handle)?;
            self.recover_device_loss(source_adapter_luid, &reason)
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
            self.recover_pending_device_loss(info.shared_texture_handle)?;
            let import_result = {
                let gpu = self.gpu()?;
                gpu.importer.import_texture(
                    &gpu.device,
                    info.shared_texture_handle,
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
                    self.recover_device_loss(source, "CEF shared texture adapter changed")?;
                    self.stats.platform_texture_import.adapter_luid_checks = self
                        .stats
                        .platform_texture_import
                        .adapter_luid_checks
                        .saturating_add(1);
                    let gpu = self.gpu()?;
                    gpu.importer
                        .import_texture(
                            &gpu.device,
                            info.shared_texture_handle,
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
                source_adapter_luid,
            } = imported;
            debug_assert_eq!(source_adapter_luid, self.gpu()?.selected_adapter_luid);
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
            }
        }

        fn layer_mut(&mut self, layer: Layer) -> &mut Option<LayerTexture> {
            match layer {
                Layer::Shell => &mut self.shell,
                Layer::Preview => &mut self.preview,
            }
        }

        fn present(&mut self) {
            let pending_recovery = self.gpu.as_ref().and_then(|gpu| {
                gpu.device_health
                    .take_recovery_reason()
                    .map(|reason| (gpu.selected_adapter_luid, reason))
            });
            if let Some((selected_adapter_luid, reason)) = pending_recovery {
                if let Err(error) = self.recover_device_loss(selected_adapter_luid, &reason) {
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
                    if let Some(surface) = gpu.surface.as_ref() {
                        surface.configure(&gpu.device, &gpu.config);
                    }
                    return;
                }
                wgpu::CurrentSurfaceTexture::Lost => {
                    self.stats.dropped_frames = self.stats.dropped_frames.saturating_add(1);
                    if let Err(error) = self.recover_surface_loss("compositor surface was lost") {
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
                    return;
                }
                wgpu::CurrentSurfaceTexture::Occluded => {
                    self.stats.dropped_frames = self.stats.dropped_frames.saturating_add(1);
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
                if self.preview_visible {
                    if let Some(preview) = self.preview.as_ref() {
                        let rect =
                            clamp_rect(self.preview_rect, gpu.config.width, gpu.config.height);
                        if rect.width > 0 && rect.height > 0 {
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
                    }
                }
                if let Some(shell) = self.shell.as_ref() {
                    pass.set_viewport(
                        0.0,
                        0.0,
                        gpu.config.width as f32,
                        gpu.config.height as f32,
                        0.0,
                        1.0,
                    );
                    pass.set_bind_group(0, &shell.bind_group, &[]);
                    let mut regions = if self.preview_visible {
                        shell_regions_outside_preview(
                            clamp_rect(self.preview_rect, gpu.config.width, gpu.config.height),
                            gpu.config.width,
                            gpu.config.height,
                        )
                    } else {
                        vec![PhysicalRect {
                            x: 0,
                            y: 0,
                            width: gpu.config.width,
                            height: gpu.config.height,
                        }]
                    };
                    if self.preview_visible {
                        regions.extend(self.overlay_rects.iter().copied());
                    }
                    for region in regions {
                        let region = clamp_rect(region, gpu.config.width, gpu.config.height);
                        if region.width == 0 || region.height == 0 {
                            continue;
                        }
                        pass.set_scissor_rect(region.x, region.y, region.width, region.height);
                        pass.draw(0..3, 0..1);
                    }
                }
            }
            gpu.queue.submit([encoder.finish()]);
            frame.present();
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
                    renderer.stats.fail_import(error);
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
                renderer.defer_failed_copy(
                    pending,
                    format!(
                        "GPU copy exceeded the {} ms callback budget",
                        GPU_COPY_WAIT_BUDGET.as_millis()
                    ),
                    true,
                );
                drop(renderer);
                present_scheduler.request();
            }
            GpuCopyWaitResult::Failed(pending, error) => {
                renderer.defer_failed_copy(pending, error, false);
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

    fn clamp_rect(rect: PhysicalRect, width: u32, height: u32) -> PhysicalRect {
        let x = rect.x.min(width);
        let y = rect.y.min(height);
        PhysicalRect {
            x,
            y,
            width: rect.width.min(width.saturating_sub(x)),
            height: rect.height.min(height.saturating_sub(y)),
        }
    }

    fn shell_regions_outside_preview(
        preview: PhysicalRect,
        width: u32,
        height: u32,
    ) -> Vec<PhysicalRect> {
        let right = preview.x.saturating_add(preview.width).min(width);
        let bottom = preview.y.saturating_add(preview.height).min(height);
        [
            PhysicalRect {
                x: 0,
                y: 0,
                width,
                height: preview.y.min(height),
            },
            PhysicalRect {
                x: 0,
                y: bottom,
                width,
                height: height.saturating_sub(bottom),
            },
            PhysicalRect {
                x: 0,
                y: preview.y.min(height),
                width: preview.x.min(width),
                height: bottom.saturating_sub(preview.y.min(height)),
            },
            PhysicalRect {
                x: right,
                y: preview.y.min(height),
                width: width.saturating_sub(right),
                height: bottom.saturating_sub(preview.y.min(height)),
            },
        ]
        .into_iter()
        .filter(|region| region.width > 0 && region.height > 0)
        .collect()
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
            }
        }

        fn fail_import(&mut self, error: impl Into<String>) {
            let error = error.into();
            self.import_failures = self.import_failures.saturating_add(1);
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

    struct InputRouter {
        shell: CefWebview,
        preview: CefWebview,
        shell_surface: OffscreenSurface,
        preview_surface: OffscreenSurface,
        preview_rect: Mutex<LogicalRect>,
        overlay_rects: Mutex<Vec<LogicalRect>>,
        scale_bits: AtomicU64,
        preview_visible: AtomicBool,
        focused: AtomicU8,
    }

    impl InputRouter {
        fn new(
            shell: CefWebview,
            preview: CefWebview,
            shell_surface: OffscreenSurface,
            preview_surface: OffscreenSurface,
            preview_rect: LogicalRect,
            scale: f64,
        ) -> Self {
            Self {
                shell,
                preview,
                shell_surface,
                preview_surface,
                preview_rect: Mutex::new(preview_rect),
                overlay_rects: Mutex::new(Vec::new()),
                scale_bits: AtomicU64::new(scale.to_bits()),
                preview_visible: AtomicBool::new(false),
                focused: AtomicU8::new(FOCUSED_SHELL),
            }
        }

        fn set_layout(&self, rect: LogicalRect, overlays: &[LogicalRect], visible: bool) {
            *self
                .preview_rect
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()) = rect;
            *self
                .overlay_rects
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()) = overlays.to_vec();
            self.preview_visible.store(visible, Ordering::Release);
        }

        fn set_scale(&self, scale: f64) {
            self.scale_bits.store(scale.to_bits(), Ordering::Release);
        }

        fn layout(&self) -> (LogicalRect, Vec<LogicalRect>, bool) {
            let rect = *self
                .preview_rect
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let overlays = self
                .overlay_rects
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .clone();
            (rect, overlays, self.preview_visible.load(Ordering::Acquire))
        }

        fn scale(&self) -> f64 {
            f64::from_bits(self.scale_bits.load(Ordering::Acquire)).max(0.01)
        }

        fn update_screen_origins(&self, hwnd: *mut c_void) {
            let mut client_origin = WinPoint { x: 0, y: 0 };
            if unsafe { ClientToScreen(hwnd, &mut client_origin) } == 0 {
                return;
            }

            let scale = self.scale();
            let preview_rect = *self
                .preview_rect
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            self.shell_surface
                .set_screen_origin(client_origin.x, client_origin.y);
            self.preview_surface.set_screen_origin(
                client_origin
                    .x
                    .saturating_add(logical_to_physical(preview_rect.x, scale)),
                client_origin
                    .y
                    .saturating_add(logical_to_physical(preview_rect.y, scale)),
            );
        }

        fn route(&self, physical_x: i32, physical_y: i32) -> RoutedMouse<'_> {
            let scale = self.scale();
            let x = f64::from(physical_x) / scale;
            let y = f64::from(physical_y) / scale;
            let rect = *self
                .preview_rect
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let obscured = self
                .overlay_rects
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .iter()
                .any(|overlay| overlay.contains(x, y));
            if self.preview_visible.load(Ordering::Acquire) && !obscured && rect.contains(x, y) {
                RoutedMouse {
                    target: &self.preview,
                    focus: FOCUSED_PREVIEW,
                    x: (x - rect.x).round() as i32,
                    y: (y - rect.y).round() as i32,
                }
            } else {
                RoutedMouse {
                    target: &self.shell,
                    focus: FOCUSED_SHELL,
                    x: x.round() as i32,
                    y: y.round() as i32,
                }
            }
        }

        fn focus(&self, target: u8) {
            self.focused.store(target, Ordering::Release);
            self.shell.set_offscreen_focus(target == FOCUSED_SHELL);
            self.preview.set_offscreen_focus(target == FOCUSED_PREVIEW);
        }

        fn focused_webview(&self) -> &CefWebview {
            if self.focused.load(Ordering::Acquire) == FOCUSED_PREVIEW {
                &self.preview
            } else {
                &self.shell
            }
        }
    }

    struct RoutedMouse<'a> {
        target: &'a CefWebview,
        focus: u8,
        x: i32,
        y: i32,
    }

    fn logical_to_physical(value: f64, scale: f64) -> i32 {
        (value * scale)
            .round()
            .clamp(f64::from(i32::MIN), f64::from(i32::MAX)) as i32
    }

    static INPUT_ROUTERS: OnceLock<Mutex<HashMap<usize, Arc<InputRouter>>>> = OnceLock::new();

    struct InputHook {
        hwnd: *mut c_void,
        window: tauri::Window<Runtime>,
    }

    unsafe impl Send for InputHook {}
    unsafe impl Sync for InputHook {}

    impl InputHook {
        fn install(
            window: &tauri::Window<Runtime>,
            router: Arc<InputRouter>,
        ) -> Result<Self, String> {
            let hwnd = window
                .hwnd()
                .map_err(|error| format!("failed to read compositor HWND: {error}"))?
                .0;
            if hwnd.is_null() {
                return Err("compositor HWND is null".to_string());
            }
            let (sender, receiver) = std::sync::mpsc::sync_channel(1);
            let hwnd_key = hwnd as usize;
            window
                .run_on_main_thread(move || {
                    INPUT_ROUTERS
                        .get_or_init(|| Mutex::new(HashMap::new()))
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner())
                        .insert(hwnd_key, router);
                    let installed = unsafe {
                        SetWindowSubclass(
                            hwnd_key as *mut c_void,
                            Some(compositor_subclass_proc),
                            SUBCLASS_ID,
                            0,
                        )
                    };
                    let result = if installed == 0 {
                        INPUT_ROUTERS
                            .get()
                            .expect("input router map was initialized")
                            .lock()
                            .unwrap_or_else(|poisoned| poisoned.into_inner())
                            .remove(&hwnd_key);
                        Err(format!(
                            "failed to subclass compositor window: {}",
                            std::io::Error::last_os_error()
                        ))
                    } else {
                        Ok(())
                    };
                    let _ = sender.send(result);
                })
                .map_err(|error| format!("failed to schedule compositor input hook: {error}"))?;
            receiver
                .recv()
                .map_err(|_| "compositor input hook task was cancelled".to_string())??;
            Ok(Self {
                hwnd,
                window: window.clone(),
            })
        }
    }

    impl Drop for InputHook {
        fn drop(&mut self) {
            let hwnd_key = self.hwnd as usize;
            let _ = self.window.run_on_main_thread(move || {
                if let Some(routers) = INPUT_ROUTERS.get() {
                    routers
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner())
                        .remove(&hwnd_key);
                }
                unsafe {
                    RemoveWindowSubclass(
                        hwnd_key as *mut c_void,
                        Some(compositor_subclass_proc),
                        SUBCLASS_ID,
                    );
                }
            });
        }
    }

    #[repr(C)]
    struct WinPoint {
        x: i32,
        y: i32,
    }

    #[repr(C)]
    struct TrackMouseEvent {
        size: u32,
        flags: u32,
        hwnd_track: *mut c_void,
        hover_time: u32,
    }

    type SubclassProc = unsafe extern "system" fn(
        hwnd: *mut c_void,
        message: u32,
        wparam: usize,
        lparam: isize,
        id: usize,
        data: usize,
    ) -> isize;

    #[link(name = "comctl32")]
    unsafe extern "system" {
        fn SetWindowSubclass(
            hwnd: *mut c_void,
            proc: Option<SubclassProc>,
            id: usize,
            data: usize,
        ) -> i32;
        fn RemoveWindowSubclass(hwnd: *mut c_void, proc: Option<SubclassProc>, id: usize) -> i32;
        fn DefSubclassProc(hwnd: *mut c_void, message: u32, wparam: usize, lparam: isize) -> isize;
    }

    #[link(name = "user32")]
    unsafe extern "system" {
        fn TrackMouseEvent(event: *mut TrackMouseEvent) -> i32;
        fn ClientToScreen(hwnd: *mut c_void, point: *mut WinPoint) -> i32;
        fn ScreenToClient(hwnd: *mut c_void, point: *mut WinPoint) -> i32;
        fn GetKeyState(virtual_key: i32) -> i16;
    }

    const WM_SETFOCUS: u32 = 0x0007;
    const WM_KILLFOCUS: u32 = 0x0008;
    const WM_KEYDOWN: u32 = 0x0100;
    const WM_KEYUP: u32 = 0x0101;
    const WM_CHAR: u32 = 0x0102;
    const WM_SYSKEYDOWN: u32 = 0x0104;
    const WM_SYSKEYUP: u32 = 0x0105;
    const WM_MOUSEMOVE: u32 = 0x0200;
    const WM_LBUTTONDOWN: u32 = 0x0201;
    const WM_LBUTTONUP: u32 = 0x0202;
    const WM_RBUTTONDOWN: u32 = 0x0204;
    const WM_RBUTTONUP: u32 = 0x0205;
    const WM_MOUSEWHEEL: u32 = 0x020a;
    const WM_MOUSELEAVE: u32 = 0x02a3;
    const WM_NCDESTROY: u32 = 0x0082;
    const TME_LEAVE: u32 = 0x0000_0002;
    const VK_SHIFT: i32 = 0x10;
    const VK_CONTROL: i32 = 0x11;
    const VK_MENU: i32 = 0x12;

    unsafe extern "system" fn compositor_subclass_proc(
        hwnd: *mut c_void,
        message: u32,
        wparam: usize,
        lparam: isize,
        _id: usize,
        _data: usize,
    ) -> isize {
        let router = INPUT_ROUTERS.get().and_then(|routers| {
            routers
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .get(&(hwnd as usize))
                .cloned()
        });
        if let Some(router) = router {
            match message {
                WM_SETFOCUS => router.focus(router.focused.load(Ordering::Acquire)),
                WM_KILLFOCUS => {
                    router.shell.set_offscreen_focus(false);
                    router.preview.set_offscreen_focus(false);
                }
                WM_MOUSEMOVE | WM_LBUTTONDOWN | WM_LBUTTONUP | WM_RBUTTONDOWN | WM_RBUTTONUP => {
                    router.update_screen_origins(hwnd);
                    let (x, y) = lparam_point(lparam);
                    let routed = router.route(x, y);
                    let event = cef::MouseEvent {
                        x: routed.x,
                        y: routed.y,
                        modifiers: mouse_modifiers(wparam),
                    };
                    match message {
                        WM_MOUSEMOVE => {
                            let mut track = TrackMouseEvent {
                                size: std::mem::size_of::<TrackMouseEvent>() as u32,
                                flags: TME_LEAVE,
                                hwnd_track: hwnd,
                                hover_time: 0,
                            };
                            TrackMouseEvent(&mut track);
                            routed.target.send_offscreen_mouse_move(event, false);
                        }
                        WM_LBUTTONDOWN => {
                            router.focus(routed.focus);
                            routed.target.send_offscreen_mouse_click(
                                event,
                                cef::MouseButtonType::LEFT,
                                false,
                                1,
                            );
                        }
                        WM_LBUTTONUP => routed.target.send_offscreen_mouse_click(
                            event,
                            cef::MouseButtonType::LEFT,
                            true,
                            1,
                        ),
                        WM_RBUTTONDOWN => {
                            router.focus(routed.focus);
                            routed.target.send_offscreen_mouse_click(
                                event,
                                cef::MouseButtonType::RIGHT,
                                false,
                                1,
                            );
                        }
                        WM_RBUTTONUP => routed.target.send_offscreen_mouse_click(
                            event,
                            cef::MouseButtonType::RIGHT,
                            true,
                            1,
                        ),
                        _ => {}
                    }
                }
                WM_MOUSELEAVE => {
                    let target = router.focused_webview();
                    target.send_offscreen_mouse_move(cef::MouseEvent::default(), true);
                }
                WM_MOUSEWHEEL => {
                    router.update_screen_origins(hwnd);
                    let (screen_x, screen_y) = lparam_point(lparam);
                    let mut point = WinPoint {
                        x: screen_x,
                        y: screen_y,
                    };
                    ScreenToClient(hwnd, &mut point);
                    let routed = router.route(point.x, point.y);
                    routed.target.send_offscreen_mouse_wheel(
                        cef::MouseEvent {
                            x: routed.x,
                            y: routed.y,
                            modifiers: mouse_modifiers(wparam),
                        },
                        0,
                        high_word_signed(wparam) as i32,
                    );
                }
                WM_KEYDOWN | WM_SYSKEYDOWN | WM_KEYUP | WM_SYSKEYUP | WM_CHAR => {
                    let modifiers = keyboard_modifiers();
                    let target = router.focused_webview();
                    if message == WM_CHAR {
                        let character = (wparam & 0xffff) as u16;
                        target.send_offscreen_key_event(cef::KeyEvent {
                            type_: cef::KeyEventType::CHAR,
                            modifiers,
                            windows_key_code: i32::from(character),
                            character,
                            unmodified_character: character,
                            ..Default::default()
                        });
                    } else {
                        let key_up = matches!(message, WM_KEYUP | WM_SYSKEYUP);
                        target.send_offscreen_key_event(cef::KeyEvent {
                            type_: if key_up {
                                cef::KeyEventType::KEYUP
                            } else {
                                cef::KeyEventType::RAWKEYDOWN
                            },
                            modifiers,
                            windows_key_code: wparam as i32,
                            native_key_code: lparam as i32,
                            is_system_key: i32::from(matches!(
                                message,
                                WM_SYSKEYDOWN | WM_SYSKEYUP
                            )),
                            ..Default::default()
                        });
                    }
                }
                WM_NCDESTROY => {
                    if let Some(routers) = INPUT_ROUTERS.get() {
                        routers
                            .lock()
                            .unwrap_or_else(|poisoned| poisoned.into_inner())
                            .remove(&(hwnd as usize));
                    }
                }
                _ => {}
            }
        }
        DefSubclassProc(hwnd, message, wparam, lparam)
    }

    fn lparam_point(lparam: isize) -> (i32, i32) {
        let packed = lparam as u32;
        (
            (packed as u16 as i16) as i32,
            ((packed >> 16) as u16 as i16) as i32,
        )
    }

    fn high_word_signed(value: usize) -> i16 {
        ((value >> 16) as u16) as i16
    }

    fn mouse_modifiers(wparam: usize) -> u32 {
        const SHIFT_DOWN: u32 = 1 << 1;
        const CONTROL_DOWN: u32 = 1 << 2;
        const LEFT_MOUSE_BUTTON: u32 = 1 << 4;
        const RIGHT_MOUSE_BUTTON: u32 = 1 << 6;
        let mut modifiers = 0;
        if wparam & 0x0004 != 0 {
            modifiers |= SHIFT_DOWN;
        }
        if wparam & 0x0008 != 0 {
            modifiers |= CONTROL_DOWN;
        }
        if wparam & 0x0001 != 0 {
            modifiers |= LEFT_MOUSE_BUTTON;
        }
        if wparam & 0x0002 != 0 {
            modifiers |= RIGHT_MOUSE_BUTTON;
        }
        modifiers
    }

    fn keyboard_modifiers() -> u32 {
        const SHIFT_DOWN: u32 = 1 << 1;
        const CONTROL_DOWN: u32 = 1 << 2;
        const ALT_DOWN: u32 = 1 << 3;
        let mut modifiers = 0;
        unsafe {
            if GetKeyState(VK_SHIFT) < 0 {
                modifiers |= SHIFT_DOWN;
            }
            if GetKeyState(VK_CONTROL) < 0 {
                modifiers |= CONTROL_DOWN;
            }
            if GetKeyState(VK_MENU) < 0 {
                modifiers |= ALT_DOWN;
            }
        }
        modifiers
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn render_activity_keeps_overlays_at_full_rate() {
            assert_eq!(
                render_activity_policy(true, false),
                RenderActivityPolicy {
                    frame_rate: 60,
                    hidden: false,
                }
            );
        }

        #[test]
        fn render_activity_throttles_background_and_hidden_windows() {
            assert_eq!(render_activity_policy(false, false).frame_rate, 15);
            assert_eq!(render_activity_policy(true, true).frame_rate, 1);
            assert!(render_activity_policy(false, true).hidden);
        }

        #[test]
        fn shell_regions_cover_only_the_area_outside_preview() {
            let preview = PhysicalRect {
                x: 200,
                y: 100,
                width: 600,
                height: 500,
            };
            let regions = shell_regions_outside_preview(preview, 1000, 700);
            let covered_area: u32 = regions
                .iter()
                .map(|region| region.width * region.height)
                .sum();

            assert_eq!(covered_area, 1000 * 700 - 600 * 500);
            assert!(regions.iter().all(|region| {
                let horizontal_overlap =
                    region.x < preview.x + preview.width && preview.x < region.x + region.width;
                let vertical_overlap =
                    region.y < preview.y + preview.height && preview.y < region.y + region.height;
                !(horizontal_overlap && vertical_overlap)
            }));
        }

        #[test]
        fn shell_regions_clamp_preview_at_window_edges() {
            let regions = shell_regions_outside_preview(
                PhysicalRect {
                    x: 900,
                    y: 650,
                    width: 400,
                    height: 300,
                },
                1000,
                700,
            );
            let covered_area: u32 = regions
                .iter()
                .map(|region| region.width * region.height)
                .sum();

            assert_eq!(covered_area, 1000 * 700 - 100 * 50);
        }

        #[test]
        fn present_shader_does_not_repeat_color_conversion() {
            let present = COMPOSITOR_SHADER_WGSL
                .split("fn fs_present")
                .nth(1)
                .expect("present shader entry point");
            assert!(!present.contains("pow("));
            assert!(!present.contains("srgb_to_linear"));
            assert!(present.contains("textureSample"));
        }

        #[test]
        fn ingest_uses_an_srgb_intermediate_for_dark_tone_precision() {
            assert!(COMPOSITOR_SHADER_WGSL.contains("fn fs_ingest"));
            assert!(COMPOSITOR_SHADER_WGSL.contains("srgb_to_linear"));
        }

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
            health.request_recovery("first");
            health.request_recovery("latest");
            assert_eq!(telemetry.device_lost_count.load(Ordering::Relaxed), 1);
            assert_eq!(health.take_recovery_reason().as_deref(), Some("latest"));
            assert!(health.take_recovery_reason().is_none());
        }
    }
}
