// Copyright 2019-2024 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

use cef::*;

use crate::offscreen::BrowserAudioState;

#[cfg(any(windows, target_os = "macos", test))]
use std::sync::{Arc, Mutex, Weak};

#[cfg(any(windows, target_os = "macos", test))]
struct RetryableShared<T> {
  value: Mutex<Weak<T>>,
}

#[cfg(any(windows, target_os = "macos", test))]
impl<T> RetryableShared<T> {
  fn new() -> Self {
    Self {
      value: Mutex::new(Weak::new()),
    }
  }

  fn get_or_try_init<E>(
    &self,
    initialize: impl FnOnce() -> Result<Arc<T>, E>,
  ) -> Result<Arc<T>, E> {
    let mut value = self
      .value
      .lock()
      .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(existing) = value.upgrade() {
      return Ok(existing);
    }
    let initialized = initialize()?;
    *value = Arc::downgrade(&initialized);
    Ok(initialized)
  }
}

#[cfg(any(windows, target_os = "macos", test))]
fn mix_stereo_tracks(tracks: &[&[f32]], output: &mut [f32], output_channels: usize) {
  output.fill(0.0);
  if output_channels == 0 {
    return;
  }
  let frames = output.len() / output_channels;
  for frame in 0..frames {
    let mut left = 0.0_f32;
    let mut right = 0.0_f32;
    for track in tracks {
      let offset = frame * 2;
      if let Some(samples) = track.get(offset..offset + 2) {
        left += samples[0];
        right += samples[1];
      }
    }
    left = left.clamp(-1.0, 1.0);
    right = right.clamp(-1.0, 1.0);
    let output_offset = frame * output_channels;
    if output_channels == 1 {
      output[output_offset] = ((left + right) * 0.5).clamp(-1.0, 1.0);
    } else {
      output[output_offset] = left;
      output[output_offset + 1] = right;
    }
  }
}

#[cfg(any(windows, target_os = "macos"))]
mod pcm {
  use super::{RetryableShared, mix_stereo_tracks};
  use cpal::{
    SampleFormat, Stream, StreamConfig,
    traits::{DeviceTrait, HostTrait, StreamTrait},
  };
  use std::{
    collections::{HashMap, VecDeque},
    sync::{
      Arc, Mutex, OnceLock, Weak,
      atomic::{AtomicU64, Ordering},
    },
  };

  const CEF_CHANNELS: usize = 2;
  const MAX_BUFFER_SECONDS: usize = 2;

  struct MixerState {
    next_track_id: AtomicU64,
    tracks: Mutex<HashMap<u64, Weak<Mutex<VecDeque<f32>>>>>,
  }

  struct AudioMixer {
    state: Arc<MixerState>,
    sample_rate: u32,
    _stream: Stream,
  }

  impl AudioMixer {
    fn start() -> Result<Arc<Self>, String> {
      let host = cpal::default_host();
      let device = host
        .default_output_device()
        .ok_or_else(|| "no default audio output device is available".to_string())?;
      let supported = device
        .default_output_config()
        .map_err(|error| format!("failed to inspect the default audio output: {error}"))?;
      let sample_format = supported.sample_format();
      let config: StreamConfig = supported.into();
      let channels = usize::from(config.channels);
      if channels == 0 {
        return Err("the default audio output reports zero channels".to_string());
      }
      let state = Arc::new(MixerState {
        next_track_id: AtomicU64::new(1),
        tracks: Mutex::new(HashMap::new()),
      });
      let error_callback = |error| {
        log::error!("CEF PCM output stream error: {error}");
      };
      let stream = match sample_format {
        SampleFormat::F32 => {
          let state = state.clone();
          device.build_output_stream(
            config,
            move |data: &mut [f32], _| fill_f32(&state, data, channels),
            error_callback,
            None,
          )
        }
        SampleFormat::I16 => {
          let state = state.clone();
          device.build_output_stream(
            config,
            move |data: &mut [i16], _| {
              let mut mixed = vec![0.0_f32; data.len()];
              fill_f32(&state, &mut mixed, channels);
              for (sample, value) in data.iter_mut().zip(mixed) {
                *sample = (value.clamp(-1.0, 1.0) * f32::from(i16::MAX)) as i16;
              }
            },
            error_callback,
            None,
          )
        }
        SampleFormat::U16 => {
          let state = state.clone();
          device.build_output_stream(
            config,
            move |data: &mut [u16], _| {
              let mut mixed = vec![0.0_f32; data.len()];
              fill_f32(&state, &mut mixed, channels);
              for (sample, value) in data.iter_mut().zip(mixed) {
                *sample = ((value.clamp(-1.0, 1.0) * 0.5 + 0.5) * f32::from(u16::MAX)) as u16;
              }
            },
            error_callback,
            None,
          )
        }
        format => {
          return Err(format!(
            "unsupported default audio sample format for CEF output: {format:?}"
          ));
        }
      }
      .map_err(|error| format!("failed to create the CEF PCM output stream: {error}"))?;
      stream
        .play()
        .map_err(|error| format!("failed to start the CEF PCM output stream: {error}"))?;
      Ok(Arc::new(Self {
        state,
        sample_rate: config.sample_rate,
        _stream: stream,
      }))
    }

    fn shared() -> Result<Arc<Self>, String> {
      static MIXER: OnceLock<RetryableShared<AudioMixer>> = OnceLock::new();
      MIXER
        .get_or_init(RetryableShared::new)
        .get_or_try_init(Self::start)
    }

    fn add_track(self: &Arc<Self>) -> AudioTrack {
      let id = self.state.next_track_id.fetch_add(1, Ordering::Relaxed);
      let samples = Arc::new(Mutex::new(VecDeque::new()));
      self
        .state
        .tracks
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .insert(id, Arc::downgrade(&samples));
      AudioTrack {
        registration: Arc::new(TrackRegistration {
          id,
          mixer: self.clone(),
          samples,
        }),
      }
    }
  }

  struct TrackRegistration {
    id: u64,
    mixer: Arc<AudioMixer>,
    samples: Arc<Mutex<VecDeque<f32>>>,
  }

  impl Drop for TrackRegistration {
    fn drop(&mut self) {
      self
        .mixer
        .state
        .tracks
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .remove(&self.id);
    }
  }

  #[derive(Clone)]
  pub(super) struct AudioTrack {
    registration: Arc<TrackRegistration>,
  }

  impl AudioTrack {
    pub(super) fn new() -> Result<Self, String> {
      Ok(AudioMixer::shared()?.add_track())
    }

    pub(super) fn sample_rate(&self) -> u32 {
      self.registration.mixer.sample_rate
    }

    pub(super) fn clear(&self) {
      self
        .registration
        .samples
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clear();
    }

    pub(super) fn push_planar(
      &self,
      data: *mut *const f32,
      frames: std::os::raw::c_int,
      channels: std::os::raw::c_int,
    ) {
      let Ok(frames) = usize::try_from(frames) else {
        return;
      };
      let Ok(channels) = usize::try_from(channels) else {
        return;
      };
      if data.is_null() || frames == 0 || channels == 0 {
        return;
      }
      let left = unsafe {
        let channel = *data;
        if channel.is_null() {
          return;
        }
        std::slice::from_raw_parts(channel, frames)
      };
      let right = if channels > 1 {
        unsafe {
          let channel = *data.add(1);
          if channel.is_null() {
            return;
          }
          std::slice::from_raw_parts(channel, frames)
        }
      } else {
        left
      };
      let mut samples = self
        .registration
        .samples
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
      let max_samples = self.sample_rate() as usize * CEF_CHANNELS * MAX_BUFFER_SECONDS;
      let incoming = frames * CEF_CHANNELS;
      let overflow = samples
        .len()
        .saturating_add(incoming)
        .saturating_sub(max_samples);
      if overflow > 0 {
        let discard = overflow.min(samples.len());
        samples.drain(..discard);
      }
      for frame in 0..frames {
        samples.push_back(left[frame]);
        samples.push_back(right[frame]);
      }
    }
  }

  fn fill_f32(state: &MixerState, output: &mut [f32], channels: usize) {
    let frames = output.len() / channels;
    let requested = frames * CEF_CHANNELS;
    let tracks: Vec<_> = {
      let mut tracks = state
        .tracks
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
      let mut live = Vec::with_capacity(tracks.len());
      tracks.retain(|_, track| {
        if let Some(track) = track.upgrade() {
          live.push(track);
          true
        } else {
          false
        }
      });
      live
    };
    let chunks: Vec<Vec<f32>> = tracks
      .iter()
      .map(|track| {
        let mut samples = track
          .lock()
          .unwrap_or_else(|poisoned| poisoned.into_inner());
        let available = requested.min(samples.len());
        samples.drain(..available).collect()
      })
      .collect();
    let tracks: Vec<&[f32]> = chunks.iter().map(Vec::as_slice).collect();
    mix_stereo_tracks(&tracks, output, channels);
  }
}

#[cfg(any(windows, target_os = "macos"))]
use pcm::AudioTrack;

#[cfg(not(any(windows, target_os = "macos")))]
#[derive(Clone)]
struct AudioTrack;

wrap_audio_handler! {
  pub(crate) struct TauriCefAudioHandler {
    state: BrowserAudioState,
    output: Option<AudioTrack>,
  }

  impl AudioHandler {
    fn audio_parameters(
      &self,
      _browser: Option<&mut Browser>,
      _params: Option<&mut AudioParameters>,
    ) -> std::os::raw::c_int {
      #[cfg(any(windows, target_os = "macos"))]
      if let (Some(output), Some(params)) = (&self.output, _params) {
        params.channel_layout = ChannelLayout::LAYOUT_STEREO;
        params.sample_rate = output.sample_rate() as std::os::raw::c_int;
        params.frames_per_buffer = (output.sample_rate() / 100) as std::os::raw::c_int;
      }
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

    fn on_audio_stream_packet(
      &self,
      _browser: Option<&mut Browser>,
      _data: *mut *const f32,
      _frames: std::os::raw::c_int,
      _pts: i64,
    ) {
      #[cfg(any(windows, target_os = "macos"))]
      if let Some(output) = &self.output {
        output.push_planar(_data, _frames, 2);
      }
    }

    fn on_audio_stream_stopped(&self, _browser: Option<&mut Browser>) {
      self.state.set_playing(false);
      #[cfg(any(windows, target_os = "macos"))]
      if let Some(output) = &self.output {
        output.clear();
      }
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

pub(crate) fn create_audio_handler(
  state: BrowserAudioState,
  _managed_pcm_output: bool,
) -> Option<AudioHandler> {
  #[cfg(any(windows, target_os = "macos"))]
  if _managed_pcm_output {
    return match AudioTrack::new() {
      Ok(output) => Some(TauriCefAudioHandler::new(state, Some(output))),
      Err(error) => {
        log::error!(
          "failed to initialize managed CEF PCM output; falling back to Chromium output: {error}"
        );
        None
      }
    };
  }
  Some(TauriCefAudioHandler::new(state, None))
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::{cell::Cell, sync::Arc};

  #[test]
  fn mixer_combines_simultaneous_browser_tracks() {
    let first = [0.25, -0.25, 0.5, -0.5];
    let second = [0.5, 0.25, 0.75, -0.75];
    let mut output = [0.0; 4];

    mix_stereo_tracks(&[&first, &second], &mut output, 2);

    assert_eq!(output, [0.75, 0.0, 1.0, -1.0]);
  }

  #[test]
  fn shared_resource_retries_after_failure_and_reprobes_after_last_user() {
    let shared = RetryableShared::<u32>::new();
    let attempts = Cell::new(0);

    let unavailable: Result<Arc<u32>, &str> = shared.get_or_try_init(|| {
      attempts.set(attempts.get() + 1);
      Err("device unavailable")
    });
    assert_eq!(unavailable.unwrap_err(), "device unavailable");

    let first: Result<Arc<u32>, &str> = shared.get_or_try_init(|| {
      attempts.set(attempts.get() + 1);
      Ok(Arc::new(48_000))
    });
    let first = first.unwrap();
    let reused: Result<Arc<u32>, &str> =
      shared.get_or_try_init(|| panic!("live shared resource must be reused"));
    let reused = reused.unwrap();
    assert!(Arc::ptr_eq(&first, &reused));

    drop(first);
    drop(reused);

    let replacement: Result<Arc<u32>, &str> = shared.get_or_try_init(|| {
      attempts.set(attempts.get() + 1);
      Ok(Arc::new(44_100))
    });

    assert_eq!(*replacement.unwrap(), 44_100);
    assert_eq!(attempts.get(), 3);
  }

  #[test]
  fn cef_audio_callbacks_drive_the_offscreen_audio_state() {
    let state = BrowserAudioState::default();
    let handler = TauriCefAudioHandler::new(state.clone(), None);

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
