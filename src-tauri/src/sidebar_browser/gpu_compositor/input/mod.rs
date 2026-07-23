use super::geometry::LogicalRect;

#[cfg(any(windows, all(target_os = "macos", target_arch = "aarch64")))]
use crate::runtime::DesktopRuntime as Runtime;
#[cfg(any(windows, all(target_os = "macos", target_arch = "aarch64")))]
use std::sync::{
    atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering},
    Arc, Mutex,
};
#[cfg(any(windows, all(target_os = "macos", target_arch = "aarch64")))]
use tauri_runtime_cef::{OffscreenSurface, Webview as CefWebview};

#[cfg(any(all(target_os = "macos", target_arch = "aarch64"), test))]
mod macos;
#[cfg(windows)]
mod windows;

#[cfg(windows)]
pub(super) use windows::WindowsInputHook as PlatformInputHook;

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
pub(crate) use macos::MacosInputHook as PlatformInputHook;

#[cfg(any(windows, all(target_os = "macos", target_arch = "aarch64")))]
pub(super) const FOCUSED_SHELL: u8 = 0;
#[cfg(any(windows, all(target_os = "macos", target_arch = "aarch64")))]
pub(super) const FOCUSED_PREVIEW: u8 = 1;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum InputTarget {
    Shell,
    Preview,
}

#[derive(Clone, Debug)]
pub(super) struct InputLayout {
    pub(super) preview: LogicalRect,
    pub(super) overlays: Vec<LogicalRect>,
    pub(super) preview_visible: bool,
}

impl InputLayout {
    pub(super) fn target_at(&self, x: f64, y: f64) -> InputTarget {
        let obscured = self.overlays.iter().any(|overlay| overlay.contains(x, y));
        if self.preview_visible && self.preview.contains(x, y) && !obscured {
            InputTarget::Preview
        } else {
            InputTarget::Shell
        }
    }
}

#[cfg(any(windows, all(target_os = "macos", target_arch = "aarch64")))]
pub(super) trait NativeInputHook: Sized {
    fn install(window: &tauri::Window<Runtime>, router: Arc<InputRouter>) -> Result<Self, String>;
}

#[cfg(any(windows, all(target_os = "macos", target_arch = "aarch64")))]
pub(super) struct InputRouter {
    pub(super) shell: CefWebview,
    pub(super) preview: CefWebview,
    pub(super) shell_surface: OffscreenSurface,
    pub(super) preview_surface: OffscreenSurface,
    preview_rect: Mutex<LogicalRect>,
    overlay_rects: Mutex<Vec<LogicalRect>>,
    scale_bits: AtomicU64,
    preview_visible: AtomicBool,
    pub(super) focused: AtomicU8,
}

#[cfg(any(windows, all(target_os = "macos", target_arch = "aarch64")))]
impl InputRouter {
    pub(super) fn new(
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

    pub(super) fn set_layout(&self, rect: LogicalRect, overlays: &[LogicalRect], visible: bool) {
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

    pub(super) fn set_scale(&self, scale: f64) {
        self.scale_bits.store(scale.to_bits(), Ordering::Release);
    }

    pub(super) fn layout(&self) -> InputLayout {
        InputLayout {
            preview: *self
                .preview_rect
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()),
            overlays: self
                .overlay_rects
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .clone(),
            preview_visible: self.preview_visible.load(Ordering::Acquire),
        }
    }

    pub(super) fn scale(&self) -> f64 {
        f64::from_bits(self.scale_bits.load(Ordering::Acquire)).max(0.01)
    }

    pub(super) fn route(&self, physical_x: i32, physical_y: i32) -> RoutedMouse<'_> {
        let scale = self.scale();
        let x = f64::from(physical_x) / scale;
        let y = f64::from(physical_y) / scale;
        let layout = self.layout();
        match layout.target_at(x, y) {
            InputTarget::Preview => RoutedMouse {
                target: &self.preview,
                focus: FOCUSED_PREVIEW,
                x: (x - layout.preview.x).round() as i32,
                y: (y - layout.preview.y).round() as i32,
            },
            InputTarget::Shell => RoutedMouse {
                target: &self.shell,
                focus: FOCUSED_SHELL,
                x: x.round() as i32,
                y: y.round() as i32,
            },
        }
    }

    pub(super) fn focus(&self, target: u8) {
        self.focused.store(target, Ordering::Release);
        self.shell.set_offscreen_focus(target == FOCUSED_SHELL);
        self.preview.set_offscreen_focus(target == FOCUSED_PREVIEW);
    }

    pub(super) fn focused_webview(&self) -> &CefWebview {
        if self.focused.load(Ordering::Acquire) == FOCUSED_PREVIEW {
            &self.preview
        } else {
            &self.shell
        }
    }
}

#[cfg(any(windows, all(target_os = "macos", target_arch = "aarch64")))]
pub(super) struct RoutedMouse<'a> {
    pub(super) target: &'a CefWebview,
    pub(super) focus: u8,
    pub(super) x: i32,
    pub(super) y: i32,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn overlay_points_route_to_shell_before_preview() {
        let layout = InputLayout {
            preview: LogicalRect::new(100.0, 50.0, 400.0, 300.0),
            overlays: vec![LogicalRect::new(180.0, 90.0, 120.0, 80.0)],
            preview_visible: true,
        };

        assert_eq!(layout.target_at(120.0, 70.0), InputTarget::Preview);
        assert_eq!(layout.target_at(200.0, 100.0), InputTarget::Shell);
        assert_eq!(layout.target_at(20.0, 20.0), InputTarget::Shell);
    }
}
