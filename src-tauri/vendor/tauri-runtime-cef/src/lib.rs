// Copyright 2019-2024 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

#![allow(clippy::arc_with_non_send_sync)]
#![allow(clippy::too_many_arguments)]

mod cef_impl;
mod external_message_pump;
mod offscreen;
mod platform;
mod runtime;
mod webview;
mod window;
mod window_builder;
mod window_handle;

pub use offscreen::{
  AcceleratedPaintStats, BrowserAudioState, OffscreenFrame, OffscreenRenderMode, OffscreenSurface,
};
pub use runtime::*;
pub use webview::*;
pub use window::CefWindowDispatcher;
pub use window_builder::WindowBuilderWrapper;

/// Build-time sandbox capability. On Windows, also verify
/// [`windows_sandbox_active`] because M138+ requires a bootstrap-owned context.
pub const CEF_SANDBOX_ENABLED: bool = cfg!(feature = "sandbox");

pub(crate) fn deny_web_permissions() -> bool {
  std::env::var_os("ARDOR_CEF_DENY_WEB_PERMISSIONS")
    .is_some_and(|value| !value.is_empty() && value != "0")
}

pub(crate) fn disable_blank_reload_guard() -> bool {
  std::env::var_os("ARDOR_CEF_DISABLE_BLANK_RELOAD_GUARD")
    .is_some_and(|value| !value.is_empty() && value != "0")
}
