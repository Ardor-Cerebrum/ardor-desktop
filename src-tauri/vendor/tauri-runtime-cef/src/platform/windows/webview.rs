// Copyright 2019-2024 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

use cef::ImplBrowserHost;
use tauri_runtime::dpi::{PhysicalPosition, PhysicalSize, Rect};
use tauri_utils::config::Color;
use windows::Win32::{
  Foundation::{HWND, LPARAM, LRESULT, POINT, RECT, WPARAM},
  Graphics::Gdi::MapWindowPoints,
  UI::Shell::{DefSubclassProc, SetWindowSubclass},
  UI::WindowsAndMessaging::{
    GetParent, GetWindowRect, HWND_TOP, SW_HIDE, SW_SHOW, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE,
    SWP_NOZORDER, SetParent, SetWindowPos, ShowWindow, WINDOWPOS, WM_WINDOWPOSCHANGING,
  },
};

use crate::{webview::AppWebview, window::AppWindow};

impl AppWebview {
  pub(crate) fn hwnd(&self) -> HWND {
    let hwnd = self.host.window_handle();
    HWND(hwnd.0 as _)
  }

  pub(crate) fn set_background_color(&self, _color: Option<Color>) {
    // TODO: might not be supported on Windows
  }

  pub(crate) fn bounds(&self) -> Option<Rect> {
    if let Some(surface) = &self.offscreen_surface {
      return Some(surface.bounds());
    }

    let hwnd = self.hwnd();

    let mut rect = RECT::default();
    unsafe {
      let parent = GetParent(hwnd).ok()?;
      if parent.0.is_null() {
        return None;
      }

      GetWindowRect(hwnd, &mut rect).ok()?;

      let mut points = [
        POINT {
          x: rect.left,
          y: rect.top,
        },
        POINT {
          x: rect.right,
          y: rect.bottom,
        },
      ];
      if MapWindowPoints(None, Some(parent), &mut points) == 0 {
        return None;
      }

      let x = points[0].x;
      let y = points[0].y;
      let width = (points[1].x - points[0].x).max(0) as u32;
      let height = (points[1].y - points[0].y).max(0) as u32;
      Some(Rect {
        position: PhysicalPosition::new(x, y).into(),
        size: PhysicalSize::new(width, height).into(),
      })
    }
  }

  pub(crate) fn reparent(&self, parent: &AppWindow) {
    if self.offscreen_surface.is_some() {
      let _ = parent;
      return;
    }

    let parent = parent.hwnd();
    let _ = unsafe { SetParent(self.hwnd(), Some(parent)) };
  }

  pub(crate) fn apply_visible(&self, visible: bool) {
    if self.offscreen_surface.is_some() {
      let _ = visible;
      return;
    }

    let _ = unsafe { ShowWindow(self.hwnd(), if visible { SW_SHOW } else { SW_HIDE }) };
  }

  const PIN_Z_ORDER_SUBCLASS_ID: usize = 124;
  /// `dwRefData` of the pin subclass: whether it is currently vetoing.
  const Z_ORDER_UNPINNED: usize = 0;
  const Z_ORDER_PINNED: usize = 1;

  /// Refuses every z-order change to this webview while the pin is engaged.
  unsafe extern "system" fn pin_z_order_subclass_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    _subclass_id: usize,
    pinned: usize,
  ) -> LRESULT {
    unsafe {
      if pinned == Self::Z_ORDER_PINNED && msg == WM_WINDOWPOSCHANGING && lparam.0 != 0 {
        let window_pos = &mut *(lparam.0 as *mut WINDOWPOS);
        window_pos.flags |= SWP_NOZORDER;
      }

      DefSubclassProc(hwnd, msg, wparam, lparam)
    }
  }

  /// Engages or disengages the z-order pin.
  ///
  /// Re-installing the same proc under the same id does not chain a second
  /// subclass, it just updates `dwRefData` — so this both installs the pin the
  /// first time and toggles it afterwards.
  fn set_z_order_pinned(&self, pinned: bool) {
    if self.offscreen_surface.is_some() {
      let _ = pinned;
      return;
    }

    let _ = unsafe {
      SetWindowSubclass(
        self.hwnd(),
        Some(Self::pin_z_order_subclass_proc),
        Self::PIN_Z_ORDER_SUBCLASS_ID,
        if pinned {
          Self::Z_ORDER_PINNED
        } else {
          Self::Z_ORDER_UNPINNED
        },
      )
    };
  }

  /// Raises this webview above its siblings and pins it there, so nothing but
  /// this runtime can move it again. See [`Self::pin_z_order_subclass_proc`].
  pub(crate) fn raise_to_top(&self) {
    if self.offscreen_surface.is_some() {
      return;
    }

    self.set_z_order_pinned(false);

    let _ = unsafe {
      SetWindowPos(
        self.hwnd(),
        Some(HWND_TOP),
        0,
        0,
        0,
        0,
        SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
      )
    };

    self.set_z_order_pinned(true);
  }

  pub(crate) fn apply_physical_bounds(&self, _scale: f64, x: i32, y: i32, width: i32, height: i32) {
    if let Some(surface) = &self.offscreen_surface {
      surface.set_bounds(
        Rect {
          position: PhysicalPosition::new(x, y).to_logical::<f64>(_scale).into(),
          size: PhysicalSize::new(width.max(1) as u32, height.max(1) as u32)
            .to_logical::<f64>(_scale)
            .into(),
        },
        _scale,
      );
      return;
    }

    unsafe {
      let _ = SetWindowPos(
        self.hwnd(),
        None,
        x,
        y,
        width,
        height,
        SWP_NOZORDER | SWP_NOACTIVATE,
      );
    }
  }
}
