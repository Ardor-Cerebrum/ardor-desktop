// Copyright 2019-2024 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

use cef::ImplBrowserHost;
use objc2::rc::Retained;
use objc2_app_kit::{NSColor, NSView};
use objc2_foundation::{NSPoint, NSRect, NSSize};
use tauri_runtime::dpi::{LogicalPosition, LogicalSize, Rect};
use tauri_utils::config::Color;

use crate::{webview::AppWebview, window::AppWindow};

use super::utils;

impl AppWebview {
  pub(crate) fn nsview(&self) -> Retained<NSView> {
    let handle = self.host.window_handle();
    let view = handle.cast::<NSView>();
    unsafe { Retained::<NSView>::retain(view).expect("failed to retain NSView") }
  }

  pub(crate) fn set_background_color(&self, color: Option<Color>) {
    if self.offscreen_surface.is_some() {
      let _ = color;
      return;
    }

    let nsview = self.nsview();

    nsview.setWantsLayer(true);

    let Some(layer) = nsview.layer() else {
      return;
    };

    let nscolor = color
      .map(utils::ns_color_from_tauri_color)
      .unwrap_or_else(NSColor::windowBackgroundColor);

    let cg_color = nscolor.CGColor();
    layer.setBackgroundColor(Some(&*cg_color));
  }

  pub(crate) fn bounds(&self) -> Option<Rect> {
    if let Some(surface) = &self.offscreen_surface {
      return Some(surface.bounds());
    }

    let nsview = self.nsview();

    let parent = unsafe { nsview.superview()? };
    let parent_frame = parent.frame();
    let frame = nsview.frame();

    let y = if parent.isFlipped() {
      frame.origin.y
    } else {
      parent_frame.size.height - frame.origin.y - frame.size.height
    };

    let position = LogicalPosition::new(frame.origin.x, y);
    let size = LogicalSize::new(frame.size.width, frame.size.height);

    Some(Rect {
      position: position.into(),
      size: size.into(),
    })
  }

  pub(crate) fn reparent(&self, parent: &AppWindow) {
    if self.offscreen_surface.is_some() {
      let _ = parent;
      return;
    }

    let view = self.nsview();
    let parent = parent.nsview();

    parent.addSubview(&view);
  }

  pub(crate) fn apply_visible(&self, visible: bool) {
    if self.offscreen_surface.is_some() {
      let _ = visible;
      return;
    }

    let nsview = self.nsview();

    nsview.setHidden(!visible);
  }

  pub(crate) fn apply_physical_bounds(&self, scale: f64, x: i32, y: i32, width: i32, height: i32) {
    if let Some(surface) = &self.offscreen_surface {
      surface.set_bounds(
        Rect {
          position: LogicalPosition::new(x as f64 / scale, y as f64 / scale).into(),
          size: LogicalSize::new(width.max(1) as f64 / scale, height.max(1) as f64 / scale).into(),
        },
        scale,
      );
      return;
    }

    let nsview = self.nsview();
    let Some(parent) = (unsafe { nsview.superview() }) else {
      return;
    };

    // CEF provides child bounds as physical pixels, but NSView frames are logical pixels.
    let x = x as f64 / scale;
    let y = y as f64 / scale;
    let width = width as f64 / scale;
    let height = height as f64 / scale;

    let parent_frame = parent.frame();
    let y = if parent.isFlipped() {
      y
    } else {
      parent_frame.size.height - (y + height)
    };

    let frame = NSRect::new(NSPoint::new(x, y), NSSize::new(width, height));
    nsview.setFrame(frame);
  }
}
