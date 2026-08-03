use std::sync::{
  Arc, Condvar, Mutex,
  atomic::{AtomicBool, AtomicU64, Ordering},
};

use cef::*;
use tauri_runtime::{dpi::Rect, window::CursorIcon};

const BYTES_PER_PIXEL: usize = 4;
const MAX_FRAME_BYTES: usize = 64 * 1024 * 1024;
type AudioStateHandler = Arc<dyn Fn(bool) + Send + Sync + 'static>;
type CursorChangeHandler = Arc<dyn Fn(OffscreenCursor) + Send + Sync + 'static>;
type AcceleratedPaintHandler =
  Arc<dyn Fn(PaintElementType, &AcceleratedPaintInfo) + Send + Sync + 'static>;
type RenderModeHandler = Arc<dyn Fn(OffscreenRenderMode) + Send + Sync + 'static>;
type PopupStateHandler = Arc<dyn Fn(Option<cef::Rect>) + Send + Sync + 'static>;

struct CallbackSlot<T> {
  state: Mutex<CallbackSlotState<T>>,
  quiescent: Condvar,
}

struct CallbackSlotState<T> {
  handler: Option<T>,
  in_flight: usize,
}

impl<T> Default for CallbackSlot<T> {
  fn default() -> Self {
    Self {
      state: Mutex::new(CallbackSlotState {
        handler: None,
        in_flight: 0,
      }),
      quiescent: Condvar::new(),
    }
  }
}

impl<T: Clone> CallbackSlot<T> {
  fn set(&self, handler: T) {
    self.state.lock().unwrap().handler = Some(handler);
  }

  fn clear(&self) {
    let mut state = self.state.lock().unwrap();
    state.handler = None;
    while state.in_flight != 0 {
      state = self.quiescent.wait(state).unwrap();
    }
  }

  fn invoke<R>(&self, invoke: impl FnOnce(&T) -> R) -> Option<R> {
    let handler = {
      let mut state = self.state.lock().unwrap();
      let handler = state.handler.clone()?;
      state.in_flight += 1;
      handler
    };
    let _invocation = CallbackInvocation { slot: self };
    Some(invoke(&handler))
  }
}

struct CallbackInvocation<'a, T> {
  slot: &'a CallbackSlot<T>,
}

impl<T> Drop for CallbackInvocation<'_, T> {
  fn drop(&mut self) {
    let mut state = self.slot.state.lock().unwrap();
    state.in_flight -= 1;
    if state.in_flight == 0 {
      self.slot.quiescent.notify_all();
    }
  }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct OffscreenCursor {
  pub icon: CursorIcon,
  pub visible: bool,
}

impl Default for OffscreenCursor {
  fn default() -> Self {
    Self::visible(CursorIcon::Default)
  }
}

impl OffscreenCursor {
  pub const fn visible(icon: CursorIcon) -> Self {
    Self {
      icon,
      visible: true,
    }
  }

  pub const fn hidden() -> Self {
    Self {
      icon: CursorIcon::Default,
      visible: false,
    }
  }

  pub(crate) fn from_cef(cursor: CursorType) -> Self {
    let icon = match cursor {
      CursorType::POINTER => CursorIcon::Default,
      CursorType::CROSS => CursorIcon::Crosshair,
      CursorType::HAND => CursorIcon::Hand,
      CursorType::IBEAM => CursorIcon::Text,
      CursorType::WAIT => CursorIcon::Wait,
      CursorType::HELP => CursorIcon::Help,
      CursorType::EASTRESIZE => CursorIcon::EResize,
      CursorType::NORTHRESIZE => CursorIcon::NResize,
      CursorType::NORTHEASTRESIZE => CursorIcon::NeResize,
      CursorType::NORTHWESTRESIZE => CursorIcon::NwResize,
      CursorType::SOUTHRESIZE => CursorIcon::SResize,
      CursorType::SOUTHEASTRESIZE => CursorIcon::SeResize,
      CursorType::SOUTHWESTRESIZE => CursorIcon::SwResize,
      CursorType::WESTRESIZE => CursorIcon::WResize,
      CursorType::NORTHSOUTHRESIZE => CursorIcon::NsResize,
      CursorType::EASTWESTRESIZE => CursorIcon::EwResize,
      CursorType::NORTHEASTSOUTHWESTRESIZE => CursorIcon::NeswResize,
      CursorType::NORTHWESTSOUTHEASTRESIZE => CursorIcon::NwseResize,
      CursorType::COLUMNRESIZE => CursorIcon::ColResize,
      CursorType::ROWRESIZE => CursorIcon::RowResize,
      CursorType::MIDDLEPANNING
      | CursorType::EASTPANNING
      | CursorType::NORTHPANNING
      | CursorType::NORTHEASTPANNING
      | CursorType::NORTHWESTPANNING
      | CursorType::SOUTHPANNING
      | CursorType::SOUTHEASTPANNING
      | CursorType::SOUTHWESTPANNING
      | CursorType::WESTPANNING
      | CursorType::MIDDLE_PANNING_VERTICAL
      | CursorType::MIDDLE_PANNING_HORIZONTAL => CursorIcon::AllScroll,
      CursorType::MOVE | CursorType::DND_MOVE => CursorIcon::Move,
      CursorType::VERTICALTEXT => CursorIcon::VerticalText,
      CursorType::CELL => CursorIcon::Cell,
      CursorType::CONTEXTMENU => CursorIcon::ContextMenu,
      CursorType::ALIAS | CursorType::DND_LINK => CursorIcon::Alias,
      CursorType::PROGRESS => CursorIcon::Progress,
      CursorType::NODROP | CursorType::DND_NONE => CursorIcon::NoDrop,
      CursorType::COPY | CursorType::DND_COPY => CursorIcon::Copy,
      CursorType::NOTALLOWED => CursorIcon::NotAllowed,
      CursorType::ZOOMIN => CursorIcon::ZoomIn,
      CursorType::ZOOMOUT => CursorIcon::ZoomOut,
      CursorType::GRAB => CursorIcon::Grab,
      CursorType::GRABBING => CursorIcon::Grabbing,
      CursorType::NONE => return Self::hidden(),
      CursorType::CUSTOM | _ => CursorIcon::Default,
    };
    Self::visible(icon)
  }
}

/// Observable audio activity for a CEF browser, independent of how it renders.
///
/// Native child webviews and offscreen surfaces share this type so callers do
/// not need to keep CPU-frame rendering enabled just to receive audio events.
#[derive(Clone, Default)]
pub struct BrowserAudioState {
  state: Arc<BrowserAudioStateInner>,
}

#[derive(Default)]
struct BrowserAudioStateInner {
  playing: AtomicBool,
  handler: Mutex<Option<AudioStateHandler>>,
}

impl std::fmt::Debug for BrowserAudioState {
  fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    formatter
      .debug_struct("BrowserAudioState")
      .field("playing", &self.is_playing())
      .finish_non_exhaustive()
  }
}

impl BrowserAudioState {
  pub fn is_playing(&self) -> bool {
    self.state.playing.load(Ordering::Acquire)
  }

  pub fn set_handler<F>(&self, handler: F)
  where
    F: Fn(bool) + Send + Sync + 'static,
  {
    let handler: AudioStateHandler = Arc::new(handler);
    *self.state.handler.lock().unwrap() = Some(handler.clone());
    handler(self.is_playing());
  }

  pub fn clear_handler(&self) {
    self.state.handler.lock().unwrap().take();
  }

  pub(crate) fn set_playing(&self, playing: bool) {
    if self.state.playing.swap(playing, Ordering::AcqRel) == playing {
      return;
    }
    let handler = self.state.handler.lock().unwrap().clone();
    if let Some(handler) = handler {
      handler(playing);
    }
  }
}

#[derive(Clone, Debug)]
pub struct OffscreenFrame {
  pub sequence: u64,
  pub width: u32,
  pub height: u32,
  pub scale: f64,
  pub rgba: Arc<[u8]>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum OffscreenRenderMode {
  CpuFrame,
  NativeCompositor,
}

impl OffscreenRenderMode {
  pub fn as_str(self) -> &'static str {
    match self {
      Self::CpuFrame => "cpu-frame",
      Self::NativeCompositor => "native-compositor",
    }
  }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct AcceleratedPaintStats {
  pub count: u64,
  pub width: u32,
  pub height: u32,
}

#[derive(Clone)]
pub struct OffscreenSurface {
  state: Arc<Mutex<OffscreenState>>,
  next_sequence: Arc<AtomicU64>,
  audio: BrowserAudioState,
  cursor: Arc<Mutex<OffscreenCursor>>,
  cursor_change_handler: Arc<CallbackSlot<CursorChangeHandler>>,
  accelerated_paint_handler: Arc<CallbackSlot<AcceleratedPaintHandler>>,
  render_mode_handler: Arc<CallbackSlot<RenderModeHandler>>,
  popup_state_handler: Arc<CallbackSlot<PopupStateHandler>>,
}

impl std::fmt::Debug for OffscreenSurface {
  fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    formatter
      .debug_struct("OffscreenSurface")
      .field("bounds", &self.bounds())
      .field("scale", &self.scale())
      .field("visible", &self.is_visible())
      .field("cursor", &self.cursor())
      .field("render_mode", &self.render_mode())
      .field(
        "accelerated_osr_requested",
        &self.accelerated_osr_requested(),
      )
      .finish_non_exhaustive()
  }
}

#[derive(Debug)]
struct OffscreenState {
  logical_bounds: Rect,
  screen_origin_x: i32,
  screen_origin_y: i32,
  scale: f64,
  visible: bool,
  render_mode: OffscreenRenderMode,
  accelerated_osr_requested: bool,
  accelerated_paint_stats: AcceleratedPaintStats,
  frame: Option<OffscreenFrame>,
  view_bgra: Vec<u8>,
  view_width: u32,
  view_height: u32,
  popup_bgra: Option<PopupBuffer>,
}

#[derive(Clone, Debug)]
struct PopupBuffer {
  rect: cef::Rect,
  bgra: Vec<u8>,
  width: u32,
  height: u32,
}

impl OffscreenSurface {
  pub(crate) fn new(logical_bounds: Rect, scale: f64, accelerated_osr_requested: bool) -> Self {
    Self {
      state: Arc::new(Mutex::new(OffscreenState {
        logical_bounds,
        screen_origin_x: 0,
        screen_origin_y: 0,
        scale,
        visible: true,
        render_mode: OffscreenRenderMode::CpuFrame,
        accelerated_osr_requested,
        accelerated_paint_stats: AcceleratedPaintStats {
          count: 0,
          width: 0,
          height: 0,
        },
        frame: None,
        view_bgra: Vec::new(),
        view_width: 0,
        view_height: 0,
        popup_bgra: None,
      })),
      next_sequence: Arc::new(AtomicU64::new(1)),
      audio: BrowserAudioState::default(),
      cursor: Arc::new(Mutex::new(OffscreenCursor::default())),
      cursor_change_handler: Arc::new(CallbackSlot::default()),
      accelerated_paint_handler: Arc::new(CallbackSlot::default()),
      render_mode_handler: Arc::new(CallbackSlot::default()),
      popup_state_handler: Arc::new(CallbackSlot::default()),
    }
  }

  pub fn bounds(&self) -> Rect {
    self.state.lock().unwrap().logical_bounds
  }

  pub fn scale(&self) -> f64 {
    self.state.lock().unwrap().scale
  }

  pub fn is_visible(&self) -> bool {
    self.state.lock().unwrap().visible
  }

  pub fn render_mode(&self) -> OffscreenRenderMode {
    self.state.lock().unwrap().render_mode
  }

  pub fn accelerated_osr_requested(&self) -> bool {
    self.state.lock().unwrap().accelerated_osr_requested
  }

  pub fn accelerated_paint_stats(&self) -> AcceleratedPaintStats {
    self.state.lock().unwrap().accelerated_paint_stats
  }

  pub(crate) fn set_bounds(&self, logical_bounds: Rect, scale: f64) {
    let mut state = self.state.lock().unwrap();
    state.logical_bounds = logical_bounds;
    state.scale = scale;
  }

  /// Updates the top-left corner of this offscreen view in the platform screen
  /// units expected by CEF. Windows/Linux use physical pixels while macOS uses
  /// screen DIPs. CEF requests this translation when positioning native
  /// context menus, select popups and other OSR UI outside the rendered texture.
  pub fn set_screen_origin(&self, x: i32, y: i32) {
    let mut state = self.state.lock().unwrap();
    state.screen_origin_x = x;
    state.screen_origin_y = y;
  }

  pub(crate) fn set_visible(&self, visible: bool) {
    self.state.lock().unwrap().visible = visible;
  }

  pub fn latest_frame(&self) -> Option<OffscreenFrame> {
    self.state.lock().unwrap().frame.clone()
  }

  pub fn latest_frame_after(&self, sequence: u64) -> Option<OffscreenFrame> {
    self
      .latest_frame()
      .filter(|frame| frame.sequence > sequence)
  }

  pub fn is_audio_playing(&self) -> bool {
    self.audio.is_playing()
  }

  pub fn set_audio_state_handler<F>(&self, handler: F)
  where
    F: Fn(bool) + Send + Sync + 'static,
  {
    self.audio.set_handler(handler);
  }

  pub fn clear_audio_state_handler(&self) {
    self.audio.clear_handler();
  }

  pub fn cursor(&self) -> OffscreenCursor {
    *self.cursor.lock().unwrap()
  }

  pub fn set_cursor_change_handler<F>(&self, handler: F)
  where
    F: Fn(OffscreenCursor) + Send + Sync + 'static,
  {
    let handler: CursorChangeHandler = Arc::new(handler);
    self.cursor_change_handler.set(handler);
    self
      .cursor_change_handler
      .invoke(|handler| handler(self.cursor()));
  }

  pub fn clear_cursor_change_handler(&self) {
    self.cursor_change_handler.clear();
  }

  pub(crate) fn set_cursor_from_cef(&self, cursor: CursorType) {
    let cursor = OffscreenCursor::from_cef(cursor);
    let changed = {
      let mut current = self.cursor.lock().unwrap();
      if *current == cursor {
        false
      } else {
        *current = cursor;
        true
      }
    };
    if !changed {
      return;
    }
    self.cursor_change_handler.invoke(|handler| handler(cursor));
  }

  /// Installs a callback that runs while CEF's accelerated paint resource is
  /// still valid. Callers must import or copy the shared texture before the
  /// callback returns; retaining `AcceleratedPaintInfo` is invalid.
  pub fn set_accelerated_paint_handler<F>(&self, handler: F)
  where
    F: Fn(PaintElementType, &AcceleratedPaintInfo) + Send + Sync + 'static,
  {
    self.accelerated_paint_handler.set(Arc::new(handler));
  }

  pub fn clear_accelerated_paint_handler(&self) {
    self.accelerated_paint_handler.clear();
  }

  pub fn set_render_mode_handler<F>(&self, handler: F)
  where
    F: Fn(OffscreenRenderMode) + Send + Sync + 'static,
  {
    self.render_mode_handler.set(Arc::new(handler));
  }

  pub fn clear_render_mode_handler(&self) {
    self.render_mode_handler.clear();
  }

  pub fn set_popup_state_handler<F>(&self, handler: F)
  where
    F: Fn(Option<cef::Rect>) + Send + Sync + 'static,
  {
    self.popup_state_handler.set(Arc::new(handler));
  }

  pub fn clear_popup_state_handler(&self) {
    self.popup_state_handler.clear();
  }

  pub(crate) fn audio_state(&self) -> BrowserAudioState {
    self.audio.clone()
  }

  pub(crate) fn view_rect(&self, rect: Option<&mut cef::Rect>) {
    let Some(rect) = rect else {
      return;
    };
    let state = self.state.lock().unwrap();
    let size = state.logical_bounds.size.to_logical::<u32>(state.scale);
    rect.x = 0;
    rect.y = 0;
    rect.width = size.width.max(1) as i32;
    rect.height = size.height.max(1) as i32;
  }

  pub(crate) fn screen_point(
    &self,
    view_x: i32,
    view_y: i32,
    screen_x: Option<&mut i32>,
    screen_y: Option<&mut i32>,
  ) -> i32 {
    let (Some(screen_x), Some(screen_y)) = (screen_x, screen_y) else {
      return 0;
    };
    let state = self.state.lock().unwrap();
    *screen_x = state
      .screen_origin_x
      .saturating_add(screen_x_coordinate_delta(view_x, state.scale));
    *screen_y = state
      .screen_origin_y
      .saturating_add(screen_y_coordinate_delta(view_y, state.scale));
    1
  }

  pub(crate) fn screen_info(&self, screen_info: Option<&mut cef::ScreenInfo>) -> i32 {
    let Some(screen_info) = screen_info else {
      return 0;
    };
    let state = self.state.lock().unwrap();
    let size = state.logical_bounds.size.to_logical::<u32>(state.scale);
    let rect = cef::Rect {
      x: 0,
      y: 0,
      width: size.width.max(1) as i32,
      height: size.height.max(1) as i32,
    };
    screen_info.device_scale_factor = state.scale as f32;
    screen_info.depth = 24;
    screen_info.depth_per_component = 8;
    screen_info.is_monochrome = 0;
    screen_info.rect = rect.clone();
    screen_info.available_rect = rect;
    1
  }

  pub(crate) fn on_popup_show(&self, show: bool) {
    if !show {
      let mut state = self.state.lock().unwrap();
      if state.popup_bgra.take().is_some() {
        publish_current_view(&mut state, &self.next_sequence);
      }
      drop(state);
      self.popup_state_handler.invoke(|handler| handler(None));
    }
  }

  pub(crate) fn on_popup_size(&self, rect: Option<&cef::Rect>) {
    let Some(rect) = rect else {
      return;
    };
    let width = rect.width.max(0) as u32;
    let height = rect.height.max(0) as u32;
    let Some(len) = checked_frame_len(width, height) else {
      self.state.lock().unwrap().popup_bgra = None;
      return;
    };
    self.state.lock().unwrap().popup_bgra = Some(PopupBuffer {
      rect: rect.clone(),
      bgra: vec![0; len],
      width,
      height,
    });
    self
      .popup_state_handler
      .invoke(|handler| handler(Some(rect.clone())));
  }

  pub(crate) fn on_paint(
    &self,
    type_: PaintElementType,
    buffer: *const u8,
    width: i32,
    height: i32,
  ) {
    if buffer.is_null() || width <= 0 || height <= 0 {
      return;
    }
    let width = width as u32;
    let height = height as u32;
    let Some(len) = checked_frame_len(width, height) else {
      return;
    };
    let bytes = unsafe { std::slice::from_raw_parts(buffer, len) };

    match type_ {
      PaintElementType::VIEW => self.copy_view(bytes, width, height),
      PaintElementType::POPUP => self.copy_popup(bytes, width, height),
      _ => {}
    }
  }

  pub(crate) fn on_accelerated_paint(
    &self,
    type_: PaintElementType,
    info: Option<&cef::AcceleratedPaintInfo>,
  ) {
    if !matches!(type_, PaintElementType::VIEW | PaintElementType::POPUP) {
      return;
    }
    let Some(info) = info else {
      return;
    };
    if type_ == PaintElementType::VIEW {
      let mut state = self.state.lock().unwrap();
      state.render_mode = OffscreenRenderMode::NativeCompositor;
      state.accelerated_paint_stats.count = state.accelerated_paint_stats.count.saturating_add(1);
      state.accelerated_paint_stats.width = info.extra.coded_size.width.max(0) as u32;
      state.accelerated_paint_stats.height = info.extra.coded_size.height.max(0) as u32;
    }
    self
      .accelerated_paint_handler
      .invoke(|handler| handler(type_, info));
  }

  fn copy_view(&self, bytes: &[u8], width: u32, height: u32) {
    let mut state = self.state.lock().unwrap();
    let changed = state.render_mode != OffscreenRenderMode::CpuFrame;
    state.render_mode = OffscreenRenderMode::CpuFrame;
    state.view_bgra.clear();
    state.view_bgra.extend_from_slice(bytes);
    state.view_width = width;
    state.view_height = height;
    publish_current_view(&mut state, &self.next_sequence);
    drop(state);
    if changed {
      self
        .render_mode_handler
        .invoke(|handler| handler(OffscreenRenderMode::CpuFrame));
    }
  }

  fn copy_popup(&self, bytes: &[u8], width: u32, height: u32) {
    let mut state = self.state.lock().unwrap();
    if let Some(popup) = state.popup_bgra.as_mut() {
      popup.width = width;
      popup.height = height;
      popup.bgra.clear();
      popup.bgra.extend_from_slice(bytes);
    } else {
      state.popup_bgra = Some(PopupBuffer {
        rect: cef::Rect {
          x: 0,
          y: 0,
          width: width as i32,
          height: height as i32,
        },
        bgra: bytes.to_vec(),
        width,
        height,
      });
    }
    if state.view_bgra.is_empty() {
      return;
    }
    publish_current_view(&mut state, &self.next_sequence);
  }
}

#[cfg(target_os = "macos")]
const fn screen_x_coordinate_delta(view_coordinate: i32, _scale: f64) -> i32 {
  view_coordinate
}

#[cfg(target_os = "macos")]
const fn screen_y_coordinate_delta(view_coordinate: i32, _scale: f64) -> i32 {
  view_coordinate.saturating_neg()
}

#[cfg(not(target_os = "macos"))]
fn screen_x_coordinate_delta(view_coordinate: i32, scale: f64) -> i32 {
  scale_dip_to_physical(view_coordinate, scale)
}

#[cfg(not(target_os = "macos"))]
fn screen_y_coordinate_delta(view_coordinate: i32, scale: f64) -> i32 {
  scale_dip_to_physical(view_coordinate, scale)
}

#[cfg(not(target_os = "macos"))]
fn scale_dip_to_physical(value: i32, scale: f64) -> i32 {
  (f64::from(value) * scale)
    .round()
    .clamp(f64::from(i32::MIN), f64::from(i32::MAX)) as i32
}

fn checked_frame_len(width: u32, height: u32) -> Option<usize> {
  width
    .checked_mul(height)?
    .checked_mul(BYTES_PER_PIXEL as u32)
    .map(|len| len as usize)
    .filter(|len| *len <= MAX_FRAME_BYTES)
}

fn publish_frame(
  state: &mut OffscreenState,
  next_sequence: &AtomicU64,
  mut bgra: Vec<u8>,
  width: u32,
  height: u32,
) {
  bgra_to_rgba(&mut bgra);
  state.frame = Some(OffscreenFrame {
    sequence: next_sequence.fetch_add(1, Ordering::Relaxed),
    width,
    height,
    scale: state.scale,
    rgba: Arc::from(bgra),
  });
}

fn publish_current_view(state: &mut OffscreenState, next_sequence: &AtomicU64) {
  if checked_frame_len(state.view_width, state.view_height) != Some(state.view_bgra.len()) {
    return;
  }
  let width = state.view_width;
  let height = state.view_height;
  let mut composed = state.view_bgra.clone();
  compose_popup(
    &mut composed,
    width,
    height,
    state.scale,
    state.popup_bgra.as_ref(),
  );
  publish_frame(state, next_sequence, composed, width, height);
}

fn bgra_to_rgba(bytes: &mut [u8]) {
  for pixel in bytes.chunks_exact_mut(BYTES_PER_PIXEL) {
    pixel.swap(0, 2);
  }
}

fn compose_popup(
  view: &mut [u8],
  view_width: u32,
  view_height: u32,
  scale: f64,
  popup: Option<&PopupBuffer>,
) {
  let Some(popup) = popup else {
    return;
  };
  if popup.bgra.is_empty() || view_width == 0 || view_height == 0 {
    return;
  }

  let popup_x = (f64::from(popup.rect.x) * scale).round() as i32;
  let popup_y = (f64::from(popup.rect.y) * scale).round() as i32;
  let x0 = popup_x.max(0) as u32;
  let y0 = popup_y.max(0) as u32;
  let x1 = (popup_x + popup.width as i32).clamp(0, view_width as i32) as u32;
  let y1 = (popup_y + popup.height as i32).clamp(0, view_height as i32) as u32;
  if x0 >= x1 || y0 >= y1 {
    return;
  }

  for y in y0..y1 {
    let dst = ((y * view_width + x0) as usize) * BYTES_PER_PIXEL;
    let src_x = (x0 as i32 - popup_x).max(0) as u32;
    let src_y = (y as i32 - popup_y).max(0) as u32;
    let src = ((src_y * popup.width + src_x) as usize) * BYTES_PER_PIXEL;
    for pixel in 0..(x1 - x0) as usize {
      let dst = dst + pixel * BYTES_PER_PIXEL;
      let src = src + pixel * BYTES_PER_PIXEL;
      blend_premultiplied_bgra(
        &mut view[dst..dst + BYTES_PER_PIXEL],
        &popup.bgra[src..src + BYTES_PER_PIXEL],
      );
    }
  }
}

fn blend_premultiplied_bgra(destination: &mut [u8], source: &[u8]) {
  let alpha = u32::from(source[3]);
  if alpha == 0 {
    return;
  }
  if alpha == 255 {
    destination.copy_from_slice(source);
    return;
  }

  let inverse_alpha = 255 - alpha;
  for channel in 0..3 {
    let blended =
      u32::from(source[channel]) + (u32::from(destination[channel]) * inverse_alpha + 127) / 255;
    destination[channel] = blended.min(255) as u8;
  }
  destination[3] = (alpha + (u32::from(destination[3]) * inverse_alpha + 127) / 255).min(255) as u8;
}

cef::wrap_render_handler! {
  pub(crate) struct OffscreenRenderHandler {
    surface: OffscreenSurface,
  }

  impl RenderHandler {
    fn view_rect(&self, _browser: Option<&mut Browser>, rect: Option<&mut cef::Rect>) {
      self.surface.view_rect(rect);
    }

    fn screen_point(
      &self,
      _browser: Option<&mut Browser>,
      view_x: std::os::raw::c_int,
      view_y: std::os::raw::c_int,
      screen_x: Option<&mut std::os::raw::c_int>,
      screen_y: Option<&mut std::os::raw::c_int>,
    ) -> std::os::raw::c_int {
      self
        .surface
        .screen_point(view_x, view_y, screen_x, screen_y)
    }

    fn screen_info(
      &self,
      _browser: Option<&mut Browser>,
      screen_info: Option<&mut cef::ScreenInfo>,
    ) -> std::os::raw::c_int {
      self.surface.screen_info(screen_info)
    }

    fn on_popup_show(&self, _browser: Option<&mut Browser>, show: std::os::raw::c_int) {
      self.surface.on_popup_show(show != 0);
    }

    fn on_popup_size(&self, _browser: Option<&mut Browser>, rect: Option<&cef::Rect>) {
      self.surface.on_popup_size(rect);
    }

    fn on_paint(
      &self,
      _browser: Option<&mut Browser>,
      type_: PaintElementType,
      _dirty_rects: Option<&[cef::Rect]>,
      buffer: *const u8,
      width: std::os::raw::c_int,
      height: std::os::raw::c_int,
    ) {
      self.surface.on_paint(type_, buffer, width, height);
    }

    fn on_accelerated_paint(
      &self,
      _browser: Option<&mut Browser>,
      type_: PaintElementType,
      _dirty_rects: Option<&[cef::Rect]>,
      info: Option<&cef::AcceleratedPaintInfo>,
    ) {
      self.surface.on_accelerated_paint(type_, info);
    }
  }
}

#[cfg(test)]
mod tests {
  use super::{
    CallbackSlot, OffscreenCursor, OffscreenRenderMode, OffscreenSurface, PopupBuffer,
    blend_premultiplied_bgra, compose_popup,
  };
  use std::{
    sync::{Arc, Barrier, Mutex, mpsc},
    time::Duration,
  };
  use tauri_runtime::dpi::Rect;
  use tauri_runtime::window::CursorIcon;

  #[test]
  fn cursor_handler_receives_cached_value_and_can_be_detached() {
    let surface = OffscreenSurface::new(Rect::default(), 1.0, false);
    let observed = Arc::new(Mutex::new(Vec::new()));
    let observed_for_handler = observed.clone();

    assert_eq!(surface.cursor(), OffscreenCursor::default());
    surface.set_cursor_change_handler(move |cursor| {
      observed_for_handler.lock().unwrap().push(cursor);
    });
    surface.set_cursor_from_cef(cef::CursorType::COLUMNRESIZE);
    surface.clear_cursor_change_handler();
    surface.set_cursor_from_cef(cef::CursorType::GRABBING);

    assert_eq!(
      *observed.lock().unwrap(),
      vec![
        OffscreenCursor::default(),
        OffscreenCursor::visible(CursorIcon::ColResize),
      ]
    );
    assert_eq!(
      surface.cursor(),
      OffscreenCursor::visible(CursorIcon::Grabbing)
    );
  }

  #[test]
  fn clearing_callback_slot_waits_for_in_flight_handler_and_prevents_future_calls() {
    type Handler = Arc<dyn Fn() + Send + Sync + 'static>;

    let slot = Arc::new(CallbackSlot::<Handler>::default());
    let entered = Arc::new(Barrier::new(2));
    let release = Arc::new(Barrier::new(2));
    let calls = Arc::new(Mutex::new(0_u32));
    slot.set({
      let entered = entered.clone();
      let release = release.clone();
      let calls = calls.clone();
      Arc::new(move || {
        entered.wait();
        release.wait();
        *calls.lock().unwrap() += 1;
      })
    });

    let invocation = {
      let slot = slot.clone();
      std::thread::spawn(move || {
        slot.invoke(|handler| handler());
      })
    };
    entered.wait();

    let (clearing_tx, clearing_rx) = mpsc::channel();
    let (cleared_tx, cleared_rx) = mpsc::channel();
    let clearing = {
      let slot = slot.clone();
      std::thread::spawn(move || {
        clearing_tx.send(()).unwrap();
        slot.clear();
        cleared_tx.send(()).unwrap();
      })
    };
    clearing_rx.recv().unwrap();
    assert!(cleared_rx.recv_timeout(Duration::from_millis(50)).is_err());

    release.wait();
    invocation.join().unwrap();
    clearing.join().unwrap();
    assert_eq!(*calls.lock().unwrap(), 1);
    assert!(slot.invoke(|handler| handler()).is_none());
  }

  #[test]
  fn cef_cursor_types_map_to_native_system_cursors() {
    let cases = [
      (cef::CursorType::POINTER, OffscreenCursor::default()),
      (
        cef::CursorType::CROSS,
        OffscreenCursor::visible(CursorIcon::Crosshair),
      ),
      (
        cef::CursorType::HAND,
        OffscreenCursor::visible(CursorIcon::Hand),
      ),
      (
        cef::CursorType::IBEAM,
        OffscreenCursor::visible(CursorIcon::Text),
      ),
      (
        cef::CursorType::EASTRESIZE,
        OffscreenCursor::visible(CursorIcon::EResize),
      ),
      (
        cef::CursorType::NORTHRESIZE,
        OffscreenCursor::visible(CursorIcon::NResize),
      ),
      (
        cef::CursorType::NORTHEASTRESIZE,
        OffscreenCursor::visible(CursorIcon::NeResize),
      ),
      (
        cef::CursorType::NORTHWESTRESIZE,
        OffscreenCursor::visible(CursorIcon::NwResize),
      ),
      (
        cef::CursorType::SOUTHRESIZE,
        OffscreenCursor::visible(CursorIcon::SResize),
      ),
      (
        cef::CursorType::SOUTHEASTRESIZE,
        OffscreenCursor::visible(CursorIcon::SeResize),
      ),
      (
        cef::CursorType::SOUTHWESTRESIZE,
        OffscreenCursor::visible(CursorIcon::SwResize),
      ),
      (
        cef::CursorType::WESTRESIZE,
        OffscreenCursor::visible(CursorIcon::WResize),
      ),
      (
        cef::CursorType::EASTWESTRESIZE,
        OffscreenCursor::visible(CursorIcon::EwResize),
      ),
      (
        cef::CursorType::NORTHSOUTHRESIZE,
        OffscreenCursor::visible(CursorIcon::NsResize),
      ),
      (
        cef::CursorType::NORTHEASTSOUTHWESTRESIZE,
        OffscreenCursor::visible(CursorIcon::NeswResize),
      ),
      (
        cef::CursorType::NORTHWESTSOUTHEASTRESIZE,
        OffscreenCursor::visible(CursorIcon::NwseResize),
      ),
      (
        cef::CursorType::COLUMNRESIZE,
        OffscreenCursor::visible(CursorIcon::ColResize),
      ),
      (
        cef::CursorType::ROWRESIZE,
        OffscreenCursor::visible(CursorIcon::RowResize),
      ),
      (
        cef::CursorType::MOVE,
        OffscreenCursor::visible(CursorIcon::Move),
      ),
      (
        cef::CursorType::GRAB,
        OffscreenCursor::visible(CursorIcon::Grab),
      ),
      (
        cef::CursorType::GRABBING,
        OffscreenCursor::visible(CursorIcon::Grabbing),
      ),
      (
        cef::CursorType::WAIT,
        OffscreenCursor::visible(CursorIcon::Wait),
      ),
      (
        cef::CursorType::HELP,
        OffscreenCursor::visible(CursorIcon::Help),
      ),
      (
        cef::CursorType::PROGRESS,
        OffscreenCursor::visible(CursorIcon::Progress),
      ),
      (
        cef::CursorType::CONTEXTMENU,
        OffscreenCursor::visible(CursorIcon::ContextMenu),
      ),
      (
        cef::CursorType::CELL,
        OffscreenCursor::visible(CursorIcon::Cell),
      ),
      (
        cef::CursorType::VERTICALTEXT,
        OffscreenCursor::visible(CursorIcon::VerticalText),
      ),
      (
        cef::CursorType::ALIAS,
        OffscreenCursor::visible(CursorIcon::Alias),
      ),
      (
        cef::CursorType::COPY,
        OffscreenCursor::visible(CursorIcon::Copy),
      ),
      (
        cef::CursorType::NODROP,
        OffscreenCursor::visible(CursorIcon::NoDrop),
      ),
      (
        cef::CursorType::NOTALLOWED,
        OffscreenCursor::visible(CursorIcon::NotAllowed),
      ),
      (
        cef::CursorType::ZOOMIN,
        OffscreenCursor::visible(CursorIcon::ZoomIn),
      ),
      (
        cef::CursorType::ZOOMOUT,
        OffscreenCursor::visible(CursorIcon::ZoomOut),
      ),
      (
        cef::CursorType::MIDDLEPANNING,
        OffscreenCursor::visible(CursorIcon::AllScroll),
      ),
      (
        cef::CursorType::DND_MOVE,
        OffscreenCursor::visible(CursorIcon::Move),
      ),
      (
        cef::CursorType::DND_COPY,
        OffscreenCursor::visible(CursorIcon::Copy),
      ),
      (
        cef::CursorType::DND_LINK,
        OffscreenCursor::visible(CursorIcon::Alias),
      ),
      (
        cef::CursorType::DND_NONE,
        OffscreenCursor::visible(CursorIcon::NoDrop),
      ),
      (cef::CursorType::NONE, OffscreenCursor::hidden()),
      (cef::CursorType::CUSTOM, OffscreenCursor::default()),
    ];

    for (cef_cursor, expected) in cases {
      assert_eq!(
        OffscreenCursor::from_cef(cef_cursor),
        expected,
        "unexpected mapping for {cef_cursor:?}"
      );
    }
  }

  #[test]
  fn audio_state_handler_receives_only_transitions_and_can_be_detached() {
    let surface = OffscreenSurface::new(Rect::default(), 1.0, false);
    let observed = Arc::new(Mutex::new(Vec::new()));
    let observed_for_handler = observed.clone();
    surface.set_audio_state_handler(move |playing| {
      observed_for_handler.lock().unwrap().push(playing);
    });

    let audio_state = surface.audio_state();
    audio_state.set_playing(true);
    audio_state.set_playing(true);
    audio_state.set_playing(false);
    surface.clear_audio_state_handler();
    audio_state.set_playing(true);

    assert_eq!(*observed.lock().unwrap(), vec![false, true, false]);
  }

  #[test]
  fn offscreen_surface_defaults_to_cpu_frame_until_a_native_compositor_exists() {
    let surface = OffscreenSurface::new(Rect::default(), 1.0, true);

    assert!(surface.accelerated_osr_requested());
    assert_eq!(surface.render_mode(), OffscreenRenderMode::CpuFrame);
    assert_eq!(surface.render_mode().as_str(), "cpu-frame");
  }

  #[test]
  fn cpu_frame_transition_notifies_the_compositor_once() {
    let surface = OffscreenSurface::new(Rect::default(), 1.0, true);
    surface.state.lock().unwrap().render_mode = OffscreenRenderMode::NativeCompositor;
    let observed = Arc::new(Mutex::new(Vec::new()));
    let observed_for_handler = observed.clone();
    surface.set_render_mode_handler(move |mode| {
      observed_for_handler.lock().unwrap().push(mode);
    });

    surface.copy_view(&[0, 0, 0, 255], 1, 1);
    surface.copy_view(&[0, 0, 0, 255], 1, 1);

    assert_eq!(
      *observed.lock().unwrap(),
      vec![OffscreenRenderMode::CpuFrame]
    );
  }

  #[test]
  fn popup_state_handler_tracks_show_geometry_and_hide() {
    let surface = OffscreenSurface::new(Rect::default(), 2.0, true);
    let observed = Arc::new(Mutex::new(Vec::new()));
    let observed_for_handler = observed.clone();
    surface.set_popup_state_handler(move |rect| {
      observed_for_handler.lock().unwrap().push(rect);
    });
    let rect = cef::Rect {
      x: 4,
      y: 8,
      width: 120,
      height: 48,
    };

    surface.on_popup_size(Some(&rect));
    surface.on_popup_show(false);

    let observed = observed.lock().unwrap();
    assert_eq!(observed.len(), 2);
    let shown = observed[0].as_ref().expect("popup should be shown");
    assert_eq!(
      (shown.x, shown.y, shown.width, shown.height),
      (4, 8, 120, 48)
    );
    assert!(observed[1].is_none());
  }

  #[test]
  fn screen_point_translates_view_dips_to_platform_screen_coordinates() {
    let surface = OffscreenSurface::new(Rect::default(), 1.5, true);
    surface.set_screen_origin(100, 200);

    let mut screen_x = 0;
    let mut screen_y = 0;
    assert_eq!(
      surface.screen_point(10, 21, Some(&mut screen_x), Some(&mut screen_y)),
      1
    );
    #[cfg(target_os = "macos")]
    assert_eq!((screen_x, screen_y), (110, 179));
    #[cfg(not(target_os = "macos"))]
    assert_eq!((screen_x, screen_y), (115, 232));
    assert_eq!(surface.screen_point(10, 21, None, Some(&mut screen_y)), 0);
  }

  #[test]
  fn popup_composition_clips_negative_origins() {
    let mut view = vec![1, 2, 3, 255, 4, 5, 6, 255];
    let popup = PopupBuffer {
      rect: cef::Rect {
        x: -1,
        y: 0,
        width: 2,
        height: 1,
      },
      bgra: vec![10, 20, 30, 255, 40, 50, 60, 255],
      width: 2,
      height: 1,
    };

    compose_popup(&mut view, 2, 1, 1.0, Some(&popup));

    assert_eq!(view, vec![40, 50, 60, 255, 4, 5, 6, 255]);
  }

  #[test]
  fn popup_composition_preserves_the_view_through_transparent_pixels() {
    let mut destination = [100, 80, 60, 255];
    blend_premultiplied_bgra(&mut destination, &[0, 0, 0, 0]);
    assert_eq!(destination, [100, 80, 60, 255]);

    blend_premultiplied_bgra(&mut destination, &[50, 40, 30, 128]);
    assert_eq!(destination, [100, 80, 60, 255]);
  }
}
