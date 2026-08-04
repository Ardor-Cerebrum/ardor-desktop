// Copyright 2019-2024 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

use std::sync::Arc;

use cef::*;

use crate::{offscreen::OffscreenSurface, webview::INITIAL_LOAD_URL};

#[cfg(target_os = "macos")]
type CefCursorHandle = *mut u8;
#[cfg(not(target_os = "macos"))]
type CefCursorHandle = CursorHandle;

wrap_display_handler! {
  pub struct TauriCefDisplayHandler {
    document_title_changed_handler: Option<Arc<tauri_runtime::webview::DocumentTitleChangedHandler>>,
    address_changed_handler: Option<Arc<tauri_runtime::webview::AddressChangedHandler>>,
    offscreen_surface: Option<OffscreenSurface>,
  }

  impl DisplayHandler {
    fn on_title_change(
      &self,
      _browser: Option<&mut Browser>,
      title: Option<&CefString>,
    ) {
      let Some(handler) = &self.document_title_changed_handler else {
        return;
      };
      let Some(title) = title else {
        return;
      };

      handler(title.to_string());
    }

    fn on_address_change(
      &self,
      _browser: Option<&mut Browser>,
      frame: Option<&mut Frame>,
      url: Option<&CefString>,
    ) {
      // Only fire for main frame URL changes (matches on_before_browse behavior).
      if let Some(frame) = frame
        && frame.is_main() == 0
      {
        return;
      }
      let Some(handler) = &self.address_changed_handler else {
        return;
      };
      let Some(url) = url else {
        return;
      };
      let url = url.to_string();

      if url == INITIAL_LOAD_URL {
        return;
      }

      if let Ok(url) = url::Url::parse(&url) {
        handler(&url);
      }
    }

    fn on_cursor_change(
      &self,
      _browser: Option<&mut Browser>,
      _cursor: CefCursorHandle,
      type_: CursorType,
      _custom_cursor_info: Option<&CursorInfo>,
    ) -> std::os::raw::c_int {
      let Some(surface) = &self.offscreen_surface else {
        return 0;
      };
      surface.set_cursor_from_cef(type_);
      1
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::offscreen::{OffscreenCursor, OffscreenSurface};
  use tauri_runtime::{dpi::Rect, window::CursorIcon};

  #[test]
  fn offscreen_cursor_changes_update_the_surface() {
    let surface = OffscreenSurface::new(Rect::default(), 1.0, false);
    let handler = TauriCefDisplayHandler::new(None, None, Some(surface.clone()));

    assert_eq!(
      handler.on_cursor_change(None, Default::default(), CursorType::ROWRESIZE, None,),
      1
    );
    assert_eq!(
      surface.cursor(),
      OffscreenCursor::visible(CursorIcon::RowResize)
    );
  }

  #[test]
  fn native_child_cursor_changes_remain_platform_managed() {
    let handler = TauriCefDisplayHandler::new(None, None, None);

    assert_eq!(
      handler.on_cursor_change(None, Default::default(), CursorType::COLUMNRESIZE, None,),
      0
    );
  }
}
