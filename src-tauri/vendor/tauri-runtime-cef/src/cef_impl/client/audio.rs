// Copyright 2019-2024 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

use cef::*;

use crate::offscreen::BrowserAudioState;

wrap_audio_handler! {
  pub(crate) struct TauriCefAudioHandler {
    state: BrowserAudioState,
  }

  impl AudioHandler {
    fn audio_parameters(
      &self,
      _browser: Option<&mut Browser>,
      _params: Option<&mut AudioParameters>,
    ) -> std::os::raw::c_int {
      1
    }

    fn on_audio_stream_started(
      &self,
      _browser: Option<&mut Browser>,
      _params: Option<&AudioParameters>,
      _channels: std::os::raw::c_int,
    ) {
      self.state.set_playing(true);
    }

    fn on_audio_stream_stopped(&self, _browser: Option<&mut Browser>) {
      self.state.set_playing(false);
    }

    fn on_audio_stream_error(
      &self,
      _browser: Option<&mut Browser>,
      _message: Option<&CefString>,
    ) {
      self.state.set_playing(false);
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn cef_audio_callbacks_drive_the_offscreen_audio_state() {
    let state = BrowserAudioState::default();
    let handler = TauriCefAudioHandler::new(state.clone());

    assert_eq!(handler.audio_parameters(None, None), 1);
    handler.on_audio_stream_started(None, None, 2);
    assert!(state.is_playing());
    handler.on_audio_stream_stopped(None);
    assert!(!state.is_playing());
    handler.on_audio_stream_started(None, None, 2);
    handler.on_audio_stream_error(None, None);
    assert!(!state.is_playing());
  }
}
