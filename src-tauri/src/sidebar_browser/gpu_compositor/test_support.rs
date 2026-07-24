use super::{
    geometry::{clamp_rect, shell_regions_outside_preview, PhysicalRect},
    renderer::{composition_passes, CompositionPass, COMPOSITOR_SHADER_WGSL},
};
use crate::sidebar_browser::{CommandBackend, CompositorModeState, ModeEvent};
#[cfg(feature = "metal-integration-tests")]
use crate::{
    runtime::DesktopAppHandle as AppHandle,
    sidebar_browser::{mode_lock, BrowserBounds, BrowserOverlay, SidebarBrowserState},
};
use objc2::{rc::Retained, MainThreadMarker, MainThreadOnly};
use objc2_app_kit::{
    NSApplication, NSApplicationActivationPolicy, NSBackingStoreType, NSView, NSWindow,
    NSWindowStyleMask,
};
use objc2_foundation::{NSPoint, NSRect, NSSize};
#[cfg(feature = "metal-integration-tests")]
use std::sync::{Mutex, OnceLock};
use std::{
    ptr::NonNull,
    sync::mpsc,
    time::{Duration, Instant},
};
#[cfg(feature = "metal-integration-tests")]
use tauri::{LogicalSize, Manager};

const PROBE_WIDTH: u32 = 640;
const PROBE_HEIGHT: u32 = 480;
const BYTES_PER_PIXEL: u32 = 4;
const READBACK_BYTES_PER_ROW: u32 = PROBE_WIDTH * BYTES_PER_PIXEL;
const GPU_WAIT_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Clone, Copy, Debug)]
pub struct ProbeRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl ProbeRect {
    pub const fn new(x: f64, y: f64, width: f64, height: f64) -> Self {
        Self {
            x,
            y,
            width,
            height,
        }
    }

    fn physical(self) -> PhysicalRect {
        PhysicalRect {
            x: self.x.round().max(0.0) as u32,
            y: self.y.round().max(0.0) as u32,
            width: self.width.round().max(0.0) as u32,
            height: self.height.round().max(0.0) as u32,
        }
    }
}

pub struct CompositionProbeResult {
    pub backend: &'static str,
    pub render_mode: &'static str,
    pixels: Vec<[u8; 4]>,
    width: u32,
}

impl CompositionProbeResult {
    pub fn pixel(&self, x: u32, y: u32) -> [u8; 4] {
        assert!(x < self.width, "probe x coordinate is outside the frame");
        let index = y
            .checked_mul(self.width)
            .and_then(|row| row.checked_add(x))
            .expect("probe pixel index overflow") as usize;
        self.pixels[index]
    }
}

pub struct LifecycleStressReport {
    pub completed_iterations: u32,
    pub stale_callbacks: u64,
    pub close_timeouts: u64,
    pub mixed_mode_transitions: u64,
    pub fatal_errors: u64,
    pub copy_ms_p95: f64,
    pub foreground_target_fps: u8,
    pub background_target_fps: u8,
    pub hidden_target_fps: u8,
}

#[cfg(feature = "metal-integration-tests")]
#[derive(Clone, Debug)]
pub struct CefLifecycleStressReport {
    pub completed_iterations: u32,
    pub stale_callbacks: u64,
    pub close_timeouts: u64,
    pub mixed_mode_transitions: u64,
    pub fatal_errors: u64,
    pub copy_ms_p95: f64,
    pub foreground_target_fps: u8,
    pub background_target_fps: u8,
    pub hidden_target_fps: u8,
}

#[cfg(feature = "metal-integration-tests")]
type StoredCefLifecycleResult = Result<CefLifecycleStressReport, String>;
#[cfg(feature = "metal-integration-tests")]
static CEF_LIFECYCLE_RESULT: OnceLock<Mutex<Option<StoredCefLifecycleResult>>> = OnceLock::new();

#[cfg(feature = "metal-integration-tests")]
pub fn take_cef_lifecycle_stress_result() -> Option<StoredCefLifecycleResult> {
    CEF_LIFECYCLE_RESULT
        .get_or_init(|| Mutex::new(None))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .take()
}

#[cfg(feature = "metal-integration-tests")]
pub(crate) fn store_cef_lifecycle_stress_result(result: StoredCefLifecycleResult) {
    *CEF_LIFECYCLE_RESULT
        .get_or_init(|| Mutex::new(None))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(result);
}

#[cfg(feature = "metal-integration-tests")]
pub(crate) async fn run_cef_lifecycle_stress(
    app: &AppHandle,
    iterations: u32,
) -> Result<CefLifecycleStressReport, String> {
    if iterations == 0 {
        return Err("CEF lifecycle stress requires at least one iteration".to_string());
    }

    let state = app.state::<SidebarBrowserState>();
    let mut report = CefLifecycleStressReport {
        completed_iterations: 0,
        stale_callbacks: 0,
        close_timeouts: 0,
        mixed_mode_transitions: 0,
        fatal_errors: 0,
        copy_ms_p95: 0.0,
        foreground_target_fps: 60,
        background_target_fps: 15,
        hidden_target_fps: 1,
    };
    let mut copy_p95_samples = Vec::with_capacity(iterations as usize);

    for iteration in 0..iterations {
        super::reset_test_stale_callback_count();
        let generation = match state.start_compositor(app).await {
            Ok(generation) => generation,
            Err(error) => {
                report.fatal_errors = report.fatal_errors.saturating_add(1);
                reset_test_mode(&state);
                eprintln!(
                    "[sidebar-compositor] lifecycle.start.error iteration={} error={error}",
                    iteration + 1
                );
                continue;
            }
        };
        if state
            .wait_for_first_shell_present(generation, Duration::from_secs(30))
            .await
            .is_err()
        {
            report.fatal_errors = report.fatal_errors.saturating_add(1);
        }
        if mode_lock(&state).command_backend() != CommandBackend::Gpu {
            report.mixed_mode_transitions = report.mixed_mode_transitions.saturating_add(1);
        }

        let preview_generation = u64::from(iteration).saturating_add(1);
        let first_bounds = BrowserBounds {
            x: 80.0 + f64::from(iteration % 7),
            y: 60.0,
            width: 420.0,
            height: 320.0,
        };
        let overlays = vec![BrowserOverlay {
            bounds: BrowserBounds {
                x: 170.0,
                y: 110.0,
                width: 100.0,
                height: 70.0,
            },
            corner_radius: 8.0,
        }];
        let preview_callbacks_before = state
            .compositor
            .inner
            .stats()
            .map_or(0, |stats| stats.preview_callbacks);
        let iteration_result = (|| -> Result<(), String> {
            state.compositor.open_preview(
                preview_generation,
                tauri::Url::parse(&format!(
                    "data:text/html,<body style=background:rgb({},{},{})>ardor-lifecycle-{iteration}</body>",
                    iteration % 255,
                    (iteration + 85) % 255,
                    (iteration + 170) % 255
                ))
                .expect("valid lifecycle URL"),
                first_bounds,
                overlays.clone(),
            )?;
            state.compositor.layout_preview(
                preview_generation,
                BrowserBounds {
                    x: first_bounds.x + 12.0,
                    y: first_bounds.y + 8.0,
                    width: 404.0,
                    height: 304.0,
                },
                true,
                overlays,
            )?;
            let window_label = super::window_label(generation);
            let window = app
                .get_window(&window_label)
                .ok_or_else(|| format!("lifecycle window {window_label} disappeared"))?;
            window
                .set_size(LogicalSize::new(1280.0, 800.0))
                .map_err(|error| format!("failed to resize lifecycle window: {error}"))?;
            let resize_deadline = Instant::now() + Duration::from_secs(2);
            loop {
                let scale = window
                    .scale_factor()
                    .map_err(|error| format!("failed to read lifecycle scale: {error}"))?;
                let logical = window
                    .inner_size()
                    .map_err(|error| format!("failed to read lifecycle size: {error}"))?
                    .to_logical::<f64>(scale);
                if (logical.width - 1280.0).abs() < 1.0 && (logical.height - 800.0).abs() < 1.0 {
                    break;
                }
                if Instant::now() >= resize_deadline {
                    return Err(format!(
                        "lifecycle resize did not settle: {}x{}",
                        logical.width, logical.height
                    ));
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            state.compositor.layout_preview(
                preview_generation,
                BrowserBounds {
                    x: first_bounds.x + 20.0,
                    y: first_bounds.y + 12.0,
                    width: 396.0,
                    height: 296.0,
                },
                true,
                vec![BrowserOverlay {
                    bounds: BrowserBounds {
                        x: 190.0,
                        y: 130.0,
                        width: 96.0,
                        height: 64.0,
                    },
                    corner_radius: 10.0,
                }],
            )?;
            let callback_deadline = Instant::now() + Duration::from_secs(5);
            loop {
                if state.compositor.inner.stats().is_some_and(|stats| {
                    stats.preview_callbacks > preview_callbacks_before
                        && stats.import_failures == 0
                        && stats.present_failures == 0
                }) {
                    break;
                }
                if Instant::now() >= callback_deadline {
                    return Err(
                        "preview did not paint a healthy frame after lifecycle navigation"
                            .to_string(),
                    );
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            state.compositor.close_preview(preview_generation)?;
            Ok(())
        })();
        if let Err(error) = iteration_result {
            report.fatal_errors = report.fatal_errors.saturating_add(1);
            eprintln!(
                "[sidebar-compositor] lifecycle.iteration.error iteration={} error={error}",
                iteration + 1
            );
        }

        if let Some(stats) = state.compositor.inner.stats() {
            copy_p95_samples.push(stats.copy_ms_p95);
            if stats.import_failures > 0 || stats.present_failures > 0 {
                report.fatal_errors = report.fatal_errors.saturating_add(1);
            }
        } else {
            report.fatal_errors = report.fatal_errors.saturating_add(1);
        }

        match state.compositor.stop().await {
            Ok(true) => {}
            Ok(false) => {
                report.fatal_errors = report.fatal_errors.saturating_add(1);
            }
            Err(error) => {
                if error.contains("timed out waiting for CEF on_before_close") {
                    report.close_timeouts = report.close_timeouts.saturating_add(1);
                } else {
                    report.fatal_errors = report.fatal_errors.saturating_add(1);
                }
                eprintln!(
                    "[sidebar-compositor] lifecycle.close.error iteration={} error={error}",
                    iteration + 1
                );
            }
        }
        report.stale_callbacks = report
            .stale_callbacks
            .saturating_add(super::take_test_stale_callback_count());
        if mode_lock(&state).transition(ModeEvent::Close).is_err()
            || mode_lock(&state).command_backend() != CommandBackend::Unavailable
        {
            report.mixed_mode_transitions = report.mixed_mode_transitions.saturating_add(1);
        }
        reset_test_mode(&state);

        let shell_label = super::shell_label(generation);
        let window_label = super::window_label(generation);
        if app.get_webview(&shell_label).is_some() || app.get_window(&window_label).is_some() {
            report.fatal_errors = report.fatal_errors.saturating_add(1);
        } else {
            report.completed_iterations = report.completed_iterations.saturating_add(1);
        }
    }

    report.copy_ms_p95 = percentile(&copy_p95_samples, 0.95);
    Ok(report)
}

#[cfg(feature = "metal-integration-tests")]
fn reset_test_mode(state: &SidebarBrowserState) {
    *mode_lock(state) = CompositorModeState::default();
}

pub fn run_metal_composition_probe(
    shell_rgba: [u8; 4],
    preview_rgba: [u8; 4],
    preview: ProbeRect,
    overlays: Vec<ProbeRect>,
) -> Result<CompositionProbeResult, String> {
    let probe = pollster::block_on(MetalProbe::new())?;
    let frame = probe.render(shell_rgba, preview_rgba, preview, &overlays)?;
    Ok(CompositionProbeResult {
        backend: "macos-metal-iosurface",
        render_mode: "native-compositor",
        pixels: frame.pixels,
        width: PROBE_WIDTH,
    })
}

pub fn run_metal_lifecycle_stress(iterations: u32) -> Result<LifecycleStressReport, String> {
    if iterations == 0 {
        return Err("lifecycle stress requires at least one iteration".to_string());
    }

    let probe = pollster::block_on(MetalProbe::new())?;
    let mut completed_iterations = 0;
    let mut stale_callbacks = 0;
    let mut close_timeouts = 0;
    let mut mixed_mode_transitions = 0;
    let mut fatal_errors = 0;
    let mut copy_times = Vec::with_capacity(iterations as usize);

    for iteration in 0..iterations {
        let mut mode = CompositorModeState::default();
        if mode.transition(ModeEvent::StartGpu).is_err()
            || mode.transition(ModeEvent::FirstShellPresent).is_err()
            || mode.command_backend() != CommandBackend::Gpu
        {
            mixed_mode_transitions += 1;
            continue;
        }

        let generation = u64::from(iteration) + 1;
        let mut callback_gate = CallbackGenerationGate::new(generation);
        if !callback_gate.accept(generation) {
            fatal_errors += 1;
            continue;
        }

        let offset = f64::from(iteration % 7);
        let preview = ProbeRect::new(80.0 + offset, 60.0 + offset, 420.0, 320.0);
        let overlays = [ProbeRect::new(170.0, 110.0, 100.0, 70.0)];
        match probe.render([11, 12, 14, 255], [245, 245, 245, 255], preview, &overlays) {
            Ok(frame) => copy_times.push(frame.copy_ms),
            Err(_) => {
                fatal_errors += 1;
                continue;
            }
        }

        callback_gate.close();
        if callback_gate.accept(generation) {
            stale_callbacks += 1;
        }
        let close_barrier = tauri_runtime_cef::BrowserCloseState::default();
        close_barrier.mark_closed();
        if !close_barrier.wait(Duration::from_millis(50)) {
            close_timeouts += 1;
        }
        if mode.transition(ModeEvent::Close).is_err()
            || mode.command_backend() != CommandBackend::Unavailable
        {
            mixed_mode_transitions += 1;
            continue;
        }
        completed_iterations += 1;
    }

    Ok(LifecycleStressReport {
        completed_iterations,
        stale_callbacks,
        close_timeouts,
        mixed_mode_transitions,
        fatal_errors,
        copy_ms_p95: percentile(&copy_times, 0.95),
        foreground_target_fps: 60,
        background_target_fps: 15,
        hidden_target_fps: 1,
    })
}

struct CallbackGenerationGate {
    generation: u64,
    closing: bool,
}

impl CallbackGenerationGate {
    const fn new(generation: u64) -> Self {
        Self {
            generation,
            closing: false,
        }
    }

    const fn accept(&self, callback_generation: u64) -> bool {
        !self.closing && self.generation == callback_generation
    }

    fn close(&mut self) {
        self.closing = true;
    }
}

struct MetalProbe {
    surface: wgpu::Surface<'static>,
    _instance: wgpu::Instance,
    surface_config: wgpu::SurfaceConfiguration,
    _window: AppKitProbeWindow,
    device: wgpu::Device,
    queue: wgpu::Queue,
    bind_group_layout: wgpu::BindGroupLayout,
    sampler: wgpu::Sampler,
    pipeline: wgpu::RenderPipeline,
    surface_pipeline: wgpu::RenderPipeline,
}

struct ProbeFrame {
    pixels: Vec<[u8; 4]>,
    copy_ms: f64,
}

struct AppKitProbeWindow {
    window: Retained<NSWindow>,
    view: Retained<NSView>,
}

impl AppKitProbeWindow {
    fn new() -> Result<Self, String> {
        let mtm = MainThreadMarker::new()
            .ok_or_else(|| "WindowServer probe must run on the AppKit main thread".to_string())?;
        let app = NSApplication::sharedApplication(mtm);
        let _ = app.setActivationPolicy(NSApplicationActivationPolicy::Regular);
        app.activate();
        let window = unsafe {
            NSWindow::initWithContentRect_styleMask_backing_defer(
                NSWindow::alloc(mtm),
                NSRect::new(
                    NSPoint::new(0.0, 0.0),
                    NSSize::new(f64::from(PROBE_WIDTH), f64::from(PROBE_HEIGHT)),
                ),
                NSWindowStyleMask::Titled | NSWindowStyleMask::Closable,
                NSBackingStoreType::Buffered,
                false,
            )
        };
        unsafe { window.setReleasedWhenClosed(false) };
        let view = window
            .contentView()
            .ok_or_else(|| "WindowServer probe window has no content view".to_string())?;
        window.makeKeyAndOrderFront(None);
        app.updateWindows();
        Ok(Self { window, view })
    }

    fn surface_target(&self) -> wgpu::SurfaceTargetUnsafe {
        let ns_view = NonNull::from(&*self.view).cast();
        wgpu::SurfaceTargetUnsafe::RawHandle {
            raw_display_handle: Some(wgpu::rwh::AppKitDisplayHandle::new().into()),
            raw_window_handle: wgpu::rwh::AppKitWindowHandle::new(ns_view).into(),
        }
    }
}

impl Drop for AppKitProbeWindow {
    fn drop(&mut self) {
        self.window.close();
    }
}

impl MetalProbe {
    async fn new() -> Result<Self, String> {
        let window = AppKitProbeWindow::new()?;
        let mut descriptor = wgpu::InstanceDescriptor::new_without_display_handle();
        descriptor.backends = wgpu::Backends::METAL;
        let instance = wgpu::Instance::new(descriptor);
        let surface = unsafe { instance.create_surface_unsafe(window.surface_target()) }
            .map_err(|error| format!("failed to create WindowServer Metal surface: {error}"))?;
        let adapter = instance
            .enumerate_adapters(wgpu::Backends::METAL)
            .await
            .into_iter()
            .find(|adapter| {
                adapter.get_info().backend == wgpu::Backend::Metal
                    && adapter.is_surface_supported(&surface)
            })
            .ok_or_else(|| {
                "WindowServer probe could not find a present-capable Metal adapter".to_string()
            })?;
        let (device, queue) = adapter
            .request_device(&wgpu::DeviceDescriptor {
                label: Some("Ardor Metal integration probe"),
                ..Default::default()
            })
            .await
            .map_err(|error| format!("failed to create Metal probe device: {error}"))?;
        let mut surface_config = surface
            .get_default_config(&adapter, PROBE_WIDTH, PROBE_HEIGHT)
            .ok_or_else(|| "Metal adapter cannot configure the WindowServer surface".to_string())?;
        surface_config.present_mode = wgpu::PresentMode::Fifo;
        surface_config.alpha_mode = wgpu::CompositeAlphaMode::Opaque;
        surface.configure(&device, &surface_config);
        let bind_group_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("Ardor Metal probe texture layout"),
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
            label: Some("Ardor Metal probe pipeline layout"),
            bind_group_layouts: &[Some(&bind_group_layout)],
            immediate_size: 0,
        });
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("Ardor production compositor shader probe"),
            source: wgpu::ShaderSource::Wgsl(COMPOSITOR_SHADER_WGSL.into()),
        });
        let pipeline = create_probe_pipeline(
            &device,
            &pipeline_layout,
            &shader,
            wgpu::TextureFormat::Rgba8UnormSrgb,
            "Ardor Metal integration readback pipeline",
        );
        let surface_pipeline = create_probe_pipeline(
            &device,
            &pipeline_layout,
            &shader,
            surface_config.format,
            "Ardor Metal integration WindowServer pipeline",
        );
        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("Ardor Metal probe sampler"),
            address_mode_u: wgpu::AddressMode::ClampToEdge,
            address_mode_v: wgpu::AddressMode::ClampToEdge,
            mag_filter: wgpu::FilterMode::Nearest,
            min_filter: wgpu::FilterMode::Nearest,
            ..Default::default()
        });
        Ok(Self {
            surface,
            _instance: instance,
            surface_config,
            _window: window,
            device,
            queue,
            bind_group_layout,
            sampler,
            pipeline,
            surface_pipeline,
        })
    }

    fn render(
        &self,
        shell_rgba: [u8; 4],
        preview_rgba: [u8; 4],
        preview: ProbeRect,
        overlays: &[ProbeRect],
    ) -> Result<ProbeFrame, String> {
        let shell = self.solid_texture(shell_rgba, "Ardor probe shell");
        let preview_texture = self.solid_texture(preview_rgba, "Ardor probe preview");
        let preview_popup_texture =
            self.solid_texture([0, 255, 0, 255], "Ardor probe preview popup");
        let shell_bind_group = self.bind_group(&shell, "Ardor probe shell bind group");
        let preview_bind_group =
            self.bind_group(&preview_texture, "Ardor probe preview bind group");
        let preview_popup_bind_group = self.bind_group(
            &preview_popup_texture,
            "Ardor probe preview popup bind group",
        );
        let output = self.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("Ardor Metal composition probe output"),
            size: wgpu::Extent3d {
                width: PROBE_WIDTH,
                height: PROBE_HEIGHT,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8UnormSrgb,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
            view_formats: &[],
        });
        let output_view = output.create_view(&wgpu::TextureViewDescriptor::default());
        let readback = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Ardor Metal probe readback"),
            size: u64::from(READBACK_BYTES_PER_ROW) * u64::from(PROBE_HEIGHT),
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        let preview_rect = clamp_rect(preview.physical(), PROBE_WIDTH, PROBE_HEIGHT);
        let preview_popup_rect = clamp_rect(
            PhysicalRect {
                x: preview_rect
                    .x
                    .saturating_add(preview_rect.width.saturating_sub(40)),
                y: preview_rect
                    .y
                    .saturating_add(preview_rect.height.saturating_sub(40)),
                width: 120,
                height: 100,
            },
            PROBE_WIDTH,
            PROBE_HEIGHT,
        );
        let overlay_rects = overlays
            .iter()
            .copied()
            .map(ProbeRect::physical)
            .map(|rect| clamp_rect(rect, PROBE_WIDTH, PROBE_HEIGHT))
            .collect::<Vec<_>>();
        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("Ardor Metal composition probe encoder"),
            });
        encode_composition(
            &mut encoder,
            &output_view,
            &self.pipeline,
            &shell_bind_group,
            &preview_bind_group,
            &preview_popup_bind_group,
            preview_rect,
            preview_popup_rect,
            &overlay_rects,
            "Ardor Metal production composition readback",
        );
        let surface_frame = match self.surface.get_current_texture() {
            wgpu::CurrentSurfaceTexture::Success(frame)
            | wgpu::CurrentSurfaceTexture::Suboptimal(frame) => frame,
            wgpu::CurrentSurfaceTexture::Outdated | wgpu::CurrentSurfaceTexture::Lost => {
                self.surface.configure(&self.device, &self.surface_config);
                return Err("WindowServer Metal surface required reconfiguration".to_string());
            }
            wgpu::CurrentSurfaceTexture::Timeout => {
                return Err("WindowServer Metal surface acquisition timed out".to_string());
            }
            wgpu::CurrentSurfaceTexture::Occluded => {
                return Err("WindowServer Metal probe window was occluded".to_string());
            }
            wgpu::CurrentSurfaceTexture::Validation => {
                return Err("WindowServer Metal surface validation failed".to_string());
            }
        };
        let surface_view = surface_frame
            .texture
            .create_view(&wgpu::TextureViewDescriptor::default());
        encode_composition(
            &mut encoder,
            &surface_view,
            &self.surface_pipeline,
            &shell_bind_group,
            &preview_bind_group,
            &preview_popup_bind_group,
            preview_rect,
            preview_popup_rect,
            &overlay_rects,
            "Ardor Metal production WindowServer composition",
        );
        encoder.copy_texture_to_buffer(
            wgpu::TexelCopyTextureInfo {
                texture: &output,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            wgpu::TexelCopyBufferInfo {
                buffer: &readback,
                layout: wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(READBACK_BYTES_PER_ROW),
                    rows_per_image: Some(PROBE_HEIGHT),
                },
            },
            wgpu::Extent3d {
                width: PROBE_WIDTH,
                height: PROBE_HEIGHT,
                depth_or_array_layers: 1,
            },
        );

        let started_at = Instant::now();
        let submission = self.queue.submit([encoder.finish()]);
        surface_frame.present();
        let slice = readback.slice(..);
        let (mapped_sender, mapped_receiver) = mpsc::sync_channel(1);
        slice.map_async(wgpu::MapMode::Read, move |result| {
            let _ = mapped_sender.send(result);
        });
        self.device
            .poll(wgpu::PollType::Wait {
                submission_index: Some(submission),
                timeout: Some(GPU_WAIT_TIMEOUT),
            })
            .map_err(|error| format!("Metal probe GPU wait failed: {error}"))?;
        mapped_receiver
            .recv_timeout(GPU_WAIT_TIMEOUT)
            .map_err(|error| format!("Metal probe readback callback timed out: {error}"))?
            .map_err(|error| format!("Metal probe readback map failed: {error}"))?;
        let copy_ms = started_at.elapsed().as_secs_f64() * 1000.0;
        let mapped = slice.get_mapped_range();
        let pixels = mapped
            .chunks_exact(BYTES_PER_PIXEL as usize)
            .map(|pixel| [pixel[0], pixel[1], pixel[2], pixel[3]])
            .collect();
        drop(mapped);
        readback.unmap();
        Ok(ProbeFrame { pixels, copy_ms })
    }

    fn solid_texture(&self, rgba: [u8; 4], label: &'static str) -> wgpu::Texture {
        let texture = self.device.create_texture(&wgpu::TextureDescriptor {
            label: Some(label),
            size: wgpu::Extent3d {
                width: 1,
                height: 1,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8UnormSrgb,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });
        self.queue.write_texture(
            wgpu::TexelCopyTextureInfo {
                texture: &texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            &rgba,
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(BYTES_PER_PIXEL),
                rows_per_image: Some(1),
            },
            wgpu::Extent3d {
                width: 1,
                height: 1,
                depth_or_array_layers: 1,
            },
        );
        texture
    }

    fn bind_group(&self, texture: &wgpu::Texture, label: &'static str) -> wgpu::BindGroup {
        let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
        self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some(label),
            layout: &self.bind_group_layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(&view),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::Sampler(&self.sampler),
                },
            ],
        })
    }
}

fn create_probe_pipeline(
    device: &wgpu::Device,
    layout: &wgpu::PipelineLayout,
    shader: &wgpu::ShaderModule,
    format: wgpu::TextureFormat,
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
            entry_point: Some("fs_present"),
            compilation_options: Default::default(),
            targets: &[Some(wgpu::ColorTargetState {
                format,
                blend: Some(wgpu::BlendState::PREMULTIPLIED_ALPHA_BLENDING),
                write_mask: wgpu::ColorWrites::ALL,
            })],
        }),
        multiview_mask: None,
        cache: None,
    })
}

#[allow(clippy::too_many_arguments)]
fn encode_composition(
    encoder: &mut wgpu::CommandEncoder,
    view: &wgpu::TextureView,
    pipeline: &wgpu::RenderPipeline,
    shell_bind_group: &wgpu::BindGroup,
    preview_bind_group: &wgpu::BindGroup,
    preview_popup_bind_group: &wgpu::BindGroup,
    preview_rect: PhysicalRect,
    preview_popup_rect: PhysicalRect,
    overlay_rects: &[PhysicalRect],
    label: &'static str,
) {
    let color_attachments = [Some(wgpu::RenderPassColorAttachment {
        view,
        depth_slice: None,
        resolve_target: None,
        ops: wgpu::Operations {
            load: wgpu::LoadOp::Clear(wgpu::Color::BLACK),
            store: wgpu::StoreOp::Store,
        },
    })];
    let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
        label: Some(label),
        color_attachments: &color_attachments,
        ..Default::default()
    });
    pass.set_pipeline(pipeline);
    for composition_pass in composition_passes(true, true, overlay_rects.len()) {
        match composition_pass {
            CompositionPass::Preview => {
                if !empty(preview_rect) {
                    set_rect(&mut pass, preview_rect);
                    pass.set_bind_group(0, preview_bind_group, &[]);
                    pass.draw(0..3, 0..1);
                }
            }
            CompositionPass::PreviewPopup => {
                if !empty(preview_popup_rect) {
                    set_rect(&mut pass, preview_popup_rect);
                    pass.set_bind_group(0, preview_popup_bind_group, &[]);
                    pass.draw(0..3, 0..1);
                }
            }
            CompositionPass::ShellOutsidePreview => {
                pass.set_viewport(0.0, 0.0, PROBE_WIDTH as f32, PROBE_HEIGHT as f32, 0.0, 1.0);
                pass.set_bind_group(0, shell_bind_group, &[]);
                for region in shell_regions_outside_preview(preview_rect, PROBE_WIDTH, PROBE_HEIGHT)
                {
                    pass.set_scissor_rect(region.x, region.y, region.width, region.height);
                    pass.draw(0..3, 0..1);
                }
            }
            CompositionPass::ShellOverlay(index) => {
                if let Some(region) = overlay_rects.get(index).copied().filter(|r| !empty(*r)) {
                    pass.set_viewport(0.0, 0.0, PROBE_WIDTH as f32, PROBE_HEIGHT as f32, 0.0, 1.0);
                    pass.set_bind_group(0, shell_bind_group, &[]);
                    pass.set_scissor_rect(region.x, region.y, region.width, region.height);
                    pass.draw(0..3, 0..1);
                }
            }
            CompositionPass::ShellFullWindow => {
                pass.set_viewport(0.0, 0.0, PROBE_WIDTH as f32, PROBE_HEIGHT as f32, 0.0, 1.0);
                pass.set_bind_group(0, shell_bind_group, &[]);
                pass.set_scissor_rect(0, 0, PROBE_WIDTH, PROBE_HEIGHT);
                pass.draw(0..3, 0..1);
            }
        }
    }
}

fn set_rect(pass: &mut wgpu::RenderPass<'_>, rect: PhysicalRect) {
    pass.set_viewport(
        rect.x as f32,
        rect.y as f32,
        rect.width as f32,
        rect.height as f32,
        0.0,
        1.0,
    );
    pass.set_scissor_rect(rect.x, rect.y, rect.width, rect.height);
}

const fn empty(rect: PhysicalRect) -> bool {
    rect.width == 0 || rect.height == 0
}

fn percentile(values: &[f64], percentile: f64) -> f64 {
    if values.is_empty() {
        return f64::INFINITY;
    }
    let mut values = values.to_vec();
    values.sort_by(f64::total_cmp);
    let rank = ((values.len() - 1) as f64 * percentile.clamp(0.0, 1.0)).round() as usize;
    values[rank]
}
