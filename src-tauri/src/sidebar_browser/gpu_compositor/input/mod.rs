use super::geometry::LogicalRect;

#[cfg(any(windows, all(target_os = "macos", target_arch = "aarch64")))]
use crate::runtime::DesktopRuntime as Runtime;
#[cfg(any(test, windows, all(target_os = "macos", target_arch = "aarch64")))]
use std::collections::HashMap;
#[cfg(any(windows, all(target_os = "macos", target_arch = "aarch64")))]
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc, Mutex,
};
#[cfg(all(
    test,
    not(any(windows, all(target_os = "macos", target_arch = "aarch64")))
))]
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc, Mutex,
};
#[cfg(any(test, windows, all(target_os = "macos", target_arch = "aarch64")))]
use tauri_runtime_cef::OffscreenCursor;
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

#[cfg(any(test, windows, all(target_os = "macos", target_arch = "aarch64")))]
pub(super) const FOCUSED_SHELL: u64 = 0;
#[cfg(test)]
pub(super) const FOCUSED_PREVIEW: u64 = 1;
#[cfg(any(test, windows, all(target_os = "macos", target_arch = "aarch64")))]
const HOVERED_NONE: u64 = u64::MAX;
#[cfg(any(test, windows, all(target_os = "macos", target_arch = "aarch64")))]
const CAPTURED_NONE: u64 = u64::MAX;

#[cfg(any(test, windows, all(target_os = "macos", target_arch = "aarch64")))]
type CursorSink = Arc<dyn Fn(OffscreenCursor) + Send + Sync + 'static>;

#[cfg(any(test, windows, all(target_os = "macos", target_arch = "aarch64")))]
struct CursorRoutingState {
    hovered: AtomicU64,
    cursors: Mutex<HashMap<u64, OffscreenCursor>>,
    sink: CursorSink,
}

#[cfg(any(test, windows, all(target_os = "macos", target_arch = "aarch64")))]
impl CursorRoutingState {
    fn new<F>(sink: F) -> Self
    where
        F: Fn(OffscreenCursor) + Send + Sync + 'static,
    {
        let mut cursors = HashMap::new();
        cursors.insert(FOCUSED_SHELL, OffscreenCursor::default());
        Self {
            hovered: AtomicU64::new(HOVERED_NONE),
            cursors: Mutex::new(cursors),
            sink: Arc::new(sink),
        }
    }

    fn update(&self, target: u64, cursor: OffscreenCursor) {
        let changed = {
            let mut cursors = self
                .cursors
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if cursors.get(&target).copied().unwrap_or_default() == cursor {
                false
            } else {
                cursors.insert(target, cursor);
                true
            }
        };
        if changed && self.hovered.load(Ordering::Acquire) == target {
            (self.sink)(cursor);
        }
    }

    fn hover(&self, target: u64) -> u64 {
        let previous = self.hovered.swap(target, Ordering::AcqRel);
        if previous == target {
            return previous;
        }
        let cursor = self
            .cursors
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(&target)
            .copied()
            .unwrap_or_default();
        (self.sink)(cursor);
        previous
    }

    fn remove(&self, target: u64) {
        self.cursors
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(&target);
        if self.hovered.load(Ordering::Acquire) == target {
            self.leave();
        }
    }

    fn leave(&self) -> u64 {
        let previous = self.hovered.swap(HOVERED_NONE, Ordering::AcqRel);
        if previous != HOVERED_NONE {
            (self.sink)(OffscreenCursor::default());
        }
        previous
    }
}

#[cfg(any(test, windows, all(target_os = "macos", target_arch = "aarch64")))]
const fn focus_after_visibility_change(current: u64, visible: bool) -> u64 {
    if visible {
        current
    } else {
        FOCUSED_SHELL
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum InputTarget {
    Shell,
    Preview(u64),
}

#[derive(Clone, Debug)]
pub(super) struct PreviewInputLayout {
    pub(super) generation: u64,
    pub(super) rect: LogicalRect,
    pub(super) overlays: Vec<LogicalRect>,
    pub(super) visible: bool,
}

#[derive(Clone, Debug)]
pub(super) struct InputLayout {
    pub(super) previews: Vec<PreviewInputLayout>,
}

impl InputLayout {
    pub(super) fn target_at(&self, x: f64, y: f64) -> InputTarget {
        let shell_is_visible = self
            .previews
            .iter()
            .filter(|preview| preview.visible)
            .flat_map(|preview| &preview.overlays)
            .any(|overlay| overlay.contains(x, y));
        if shell_is_visible {
            return InputTarget::Shell;
        }

        for preview in self.previews.iter().rev() {
            if preview.visible && preview.rect.contains(x, y) {
                return InputTarget::Preview(preview.generation);
            }
        }
        InputTarget::Shell
    }
}

#[cfg(any(windows, all(target_os = "macos", target_arch = "aarch64")))]
pub(super) trait NativeInputHook: Sized {
    fn install(window: &tauri::Window<Runtime>, router: Arc<InputRouter>) -> Result<Self, String>;
    fn detach(&mut self) -> Result<(), String>;
}

#[cfg(any(windows, all(target_os = "macos", target_arch = "aarch64")))]
#[derive(Clone)]
pub(super) struct PreviewInput {
    pub(super) webview: CefWebview,
    pub(super) surface: OffscreenSurface,
    rect: LogicalRect,
    overlays: Vec<LogicalRect>,
    visible: bool,
}

#[cfg(any(windows, all(target_os = "macos", target_arch = "aarch64")))]
pub(super) struct InputRouter {
    pub(super) shell: CefWebview,
    pub(super) shell_surface: OffscreenSurface,
    previews: Mutex<HashMap<u64, PreviewInput>>,
    scale_bits: AtomicU64,
    pub(super) focused: AtomicU64,
    captured: AtomicU64,
    cursor: CursorRoutingState,
}

#[cfg(any(windows, all(target_os = "macos", target_arch = "aarch64")))]
impl InputRouter {
    pub(super) fn new(
        shell: CefWebview,
        shell_surface: OffscreenSurface,
        scale: f64,
        cursor_sink: impl Fn(OffscreenCursor) + Send + Sync + 'static,
    ) -> Self {
        Self {
            shell,
            shell_surface,
            previews: Mutex::new(HashMap::new()),
            scale_bits: AtomicU64::new(scale.to_bits()),
            focused: AtomicU64::new(FOCUSED_SHELL),
            captured: AtomicU64::new(CAPTURED_NONE),
            cursor: CursorRoutingState::new(cursor_sink),
        }
    }

    pub(super) fn install_cursor_handlers(self: &Arc<Self>) {
        let router = Arc::downgrade(self);
        self.shell_surface.set_cursor_change_handler(move |cursor| {
            if let Some(router) = router.upgrade() {
                router.cursor.update(FOCUSED_SHELL, cursor);
            }
        });
    }

    pub(super) fn add_preview(
        self: &Arc<Self>,
        generation: u64,
        webview: CefWebview,
        surface: OffscreenSurface,
        rect: LogicalRect,
    ) {
        self.previews
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(
                generation,
                PreviewInput {
                    webview,
                    surface: surface.clone(),
                    rect,
                    overlays: Vec::new(),
                    visible: false,
                },
            );
        let router = Arc::downgrade(self);
        surface.set_cursor_change_handler(move |cursor| {
            if let Some(router) = router.upgrade() {
                router.cursor.update(generation, cursor);
            }
        });
    }

    pub(super) fn clear_cursor_handlers(&self) {
        self.shell_surface.clear_cursor_change_handler();
        for preview in self
            .previews
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .values()
        {
            preview.surface.clear_cursor_change_handler();
        }
    }

    pub(super) fn remove_preview(&self, generation: u64) -> Option<PreviewInput> {
        let preview = self
            .previews
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(&generation);
        if let Some(preview) = preview.as_ref() {
            preview.surface.clear_cursor_change_handler();
        }
        self.cursor.remove(generation);
        if self.captured.load(Ordering::Acquire) == generation {
            self.release_capture();
        }
        if self.focused.load(Ordering::Acquire) == generation {
            self.focus(FOCUSED_SHELL);
        }
        preview
    }

    pub(super) fn set_layout(
        &self,
        generation: u64,
        rect: LogicalRect,
        overlays: &[LogicalRect],
        visible: bool,
    ) -> bool {
        let mut previews = self
            .previews
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let Some(preview) = previews.get_mut(&generation) else {
            return false;
        };
        preview.rect = rect;
        preview.overlays = overlays.to_vec();
        preview.visible = visible;
        drop(previews);
        let current_focus = self.focused.load(Ordering::Acquire);
        let next_focus = if current_focus == generation {
            focus_after_visibility_change(current_focus, visible)
        } else {
            current_focus
        };
        if next_focus != current_focus {
            self.focus(next_focus);
        }
        if !visible && self.captured.load(Ordering::Acquire) == generation {
            self.release_capture();
        }
        true
    }

    pub(super) fn set_scale(&self, scale: f64) {
        self.scale_bits.store(scale.to_bits(), Ordering::Release);
    }

    pub(super) fn layout(&self) -> InputLayout {
        let mut previews = self
            .previews
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .iter()
            .map(|(&generation, preview)| PreviewInputLayout {
                generation,
                rect: preview.rect,
                overlays: preview.overlays.clone(),
                visible: preview.visible,
            })
            .collect::<Vec<_>>();
        previews.sort_by_key(|preview| preview.generation);
        InputLayout { previews }
    }

    pub(super) fn preview_entries(&self) -> Vec<(u64, OffscreenSurface, LogicalRect)> {
        self.previews
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .iter()
            .map(|(&generation, preview)| (generation, preview.surface.clone(), preview.rect))
            .collect()
    }

    pub(super) fn preview_webviews(&self) -> Vec<CefWebview> {
        self.previews
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .values()
            .map(|preview| preview.webview.clone())
            .collect()
    }

    pub(super) fn scale(&self) -> f64 {
        f64::from_bits(self.scale_bits.load(Ordering::Acquire)).max(0.01)
    }

    pub(super) fn route(&self, physical_x: i32, physical_y: i32) -> RoutedMouse {
        let scale = self.scale();
        let x = f64::from(physical_x) / scale;
        let y = f64::from(physical_y) / scale;
        let layout = self.layout();
        let captured = self.captured.load(Ordering::Acquire);
        let target = if captured == CAPTURED_NONE {
            layout.target_at(x, y)
        } else if captured == FOCUSED_SHELL {
            InputTarget::Shell
        } else {
            InputTarget::Preview(captured)
        };
        let routed = match target {
            InputTarget::Preview(generation) => {
                let previews = self
                    .previews
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                let Some(preview) = previews.get(&generation) else {
                    return RoutedMouse {
                        target: self.shell.clone(),
                        focus: FOCUSED_SHELL,
                        x: x.round() as i32,
                        y: y.round() as i32,
                    };
                };
                RoutedMouse {
                    target: preview.webview.clone(),
                    focus: generation,
                    x: (x - preview.rect.x).round() as i32,
                    y: (y - preview.rect.y).round() as i32,
                }
            }
            InputTarget::Shell => RoutedMouse {
                target: self.shell.clone(),
                focus: FOCUSED_SHELL,
                x: x.round() as i32,
                y: y.round() as i32,
            },
        };
        let previous_hover = self.cursor.hover(routed.focus);
        if previous_hover != HOVERED_NONE && previous_hover != routed.focus {
            self.send_mouse_leave(previous_hover);
        }
        routed
    }

    pub(super) fn capture(&self, target: u64) {
        self.captured.store(target, Ordering::Release);
    }

    pub(super) fn release_capture(&self) {
        self.captured.store(CAPTURED_NONE, Ordering::Release);
    }

    pub(super) fn leave(&self) {
        self.send_mouse_leave(self.cursor.leave());
    }

    fn send_mouse_leave(&self, target: u64) {
        let target = match target {
            FOCUSED_SHELL => Some(self.shell.clone()),
            HOVERED_NONE => None,
            generation => self
                .previews
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .get(&generation)
                .map(|preview| preview.webview.clone()),
        };
        if let Some(target) = target {
            target.send_offscreen_mouse_move(cef::MouseEvent::default(), true);
        }
    }

    pub(super) fn focus(&self, target: u64) {
        self.focused.store(target, Ordering::Release);
        self.shell.set_offscreen_focus(false);
        let target_preview = {
            let previews = self
                .previews
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            for preview in previews.values() {
                preview.webview.set_offscreen_focus(false);
            }
            previews.get(&target).map(|preview| preview.webview.clone())
        };
        if target == FOCUSED_SHELL {
            self.shell.set_offscreen_focus(true);
        } else if let Some(target_preview) = target_preview {
            // CEF focus is shared by the offscreen browser hosts. The target
            // must be focused after every other host has been blurred; a
            // HashMap iteration that mixes true and false leaves whichever
            // host happens to be processed last as the effective target.
            target_preview.set_offscreen_focus(true);
        }
    }

    pub(super) fn blur(&self) {
        self.shell.set_offscreen_focus(false);
        for preview in self
            .previews
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .values()
        {
            preview.webview.set_offscreen_focus(false);
        }
    }

    pub(super) fn focused_webview(&self) -> CefWebview {
        let focused = self.focused.load(Ordering::Acquire);
        self.previews
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(&focused)
            .map(|preview| preview.webview.clone())
            .unwrap_or_else(|| self.shell.clone())
    }
}

#[cfg(any(windows, all(target_os = "macos", target_arch = "aarch64")))]
pub(super) struct RoutedMouse {
    pub(super) target: CefWebview,
    pub(super) focus: u64,
    pub(super) x: i32,
    pub(super) y: i32,
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};
    use tauri::CursorIcon;
    use tauri_runtime_cef::OffscreenCursor;

    #[test]
    fn overlays_and_points_outside_preview_route_to_shell() {
        let layout = InputLayout {
            previews: vec![PreviewInputLayout {
                generation: 7,
                rect: LogicalRect::new(100.0, 50.0, 400.0, 300.0),
                overlays: vec![
                    LogicalRect::new(180.0, 90.0, 120.0, 80.0),
                    LogicalRect::new(500.0, 330.0, 30.0, 30.0),
                ],
                visible: true,
            }],
        };

        assert_eq!(layout.target_at(120.0, 70.0), InputTarget::Preview(7));
        assert_eq!(layout.target_at(200.0, 100.0), InputTarget::Shell);
        assert_eq!(layout.target_at(20.0, 20.0), InputTarget::Shell);
        assert_eq!(layout.target_at(540.0, 360.0), InputTarget::Shell);
        assert_eq!(layout.target_at(510.0, 340.0), InputTarget::Shell);
    }

    #[test]
    fn multiple_previews_route_independently_and_topmost_wins() {
        let layout = InputLayout {
            previews: vec![
                PreviewInputLayout {
                    generation: 11,
                    rect: LogicalRect::new(0.0, 0.0, 200.0, 200.0),
                    overlays: Vec::new(),
                    visible: true,
                },
                PreviewInputLayout {
                    generation: 22,
                    rect: LogicalRect::new(150.0, 0.0, 200.0, 200.0),
                    overlays: Vec::new(),
                    visible: true,
                },
            ],
        };

        assert_eq!(layout.target_at(50.0, 50.0), InputTarget::Preview(11));
        assert_eq!(layout.target_at(175.0, 50.0), InputTarget::Preview(22));
        assert_eq!(layout.target_at(300.0, 50.0), InputTarget::Preview(22));
    }

    #[test]
    fn shell_overlay_blocks_input_to_every_overlapped_preview() {
        let layout = InputLayout {
            previews: vec![
                PreviewInputLayout {
                    generation: 11,
                    rect: LogicalRect::new(0.0, 0.0, 200.0, 200.0),
                    overlays: Vec::new(),
                    visible: true,
                },
                PreviewInputLayout {
                    generation: 22,
                    rect: LogicalRect::new(100.0, 0.0, 200.0, 200.0),
                    overlays: vec![LogicalRect::new(125.0, 25.0, 50.0, 50.0)],
                    visible: true,
                },
            ],
        };

        assert_eq!(layout.target_at(150.0, 50.0), InputTarget::Shell);
    }

    #[test]
    fn hiding_preview_resets_logical_focus_to_shell() {
        assert_eq!(
            focus_after_visibility_change(FOCUSED_PREVIEW, false),
            FOCUSED_SHELL
        );
        assert_eq!(
            focus_after_visibility_change(FOCUSED_PREVIEW, true),
            FOCUSED_PREVIEW
        );
        assert_eq!(
            focus_after_visibility_change(FOCUSED_SHELL, false),
            FOCUSED_SHELL
        );
    }

    #[test]
    fn cursor_routing_follows_hovered_surface_and_ignores_stale_callbacks() {
        let observed = Arc::new(Mutex::new(Vec::new()));
        let observed_for_sink = observed.clone();
        let cursors = CursorRoutingState::new(move |cursor| {
            observed_for_sink
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .push(cursor);
        });

        cursors.update(
            FOCUSED_SHELL,
            OffscreenCursor::visible(CursorIcon::ColResize),
        );
        assert!(observed.lock().unwrap().is_empty());

        cursors.hover(FOCUSED_SHELL);
        cursors.update(
            FOCUSED_PREVIEW,
            OffscreenCursor::visible(CursorIcon::RowResize),
        );
        cursors.hover(FOCUSED_PREVIEW);
        cursors.update(FOCUSED_SHELL, OffscreenCursor::visible(CursorIcon::Grab));
        cursors.leave();

        assert_eq!(
            *observed.lock().unwrap(),
            vec![
                OffscreenCursor::visible(CursorIcon::ColResize),
                OffscreenCursor::visible(CursorIcon::RowResize),
                OffscreenCursor::default(),
            ]
        );
    }

    #[test]
    fn active_surface_cursor_changes_are_applied_immediately() {
        let observed = Arc::new(Mutex::new(Vec::new()));
        let observed_for_sink = observed.clone();
        let cursors = CursorRoutingState::new(move |cursor| {
            observed_for_sink
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .push(cursor);
        });

        cursors.hover(FOCUSED_SHELL);
        observed.lock().unwrap().clear();
        cursors.update(FOCUSED_SHELL, OffscreenCursor::visible(CursorIcon::Move));
        cursors.update(FOCUSED_PREVIEW, OffscreenCursor::visible(CursorIcon::Text));

        assert_eq!(
            *observed.lock().unwrap(),
            vec![OffscreenCursor::visible(CursorIcon::Move)]
        );
    }
}
