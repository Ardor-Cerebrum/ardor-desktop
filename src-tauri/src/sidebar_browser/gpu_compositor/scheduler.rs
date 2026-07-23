#[cfg(windows)]
use super::windows_impl::GpuCompositor;
#[cfg(windows)]
use std::{
    sync::{
        atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering},
        Arc, Condvar, Mutex,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

pub(super) const ACTIVE_FRAME_RATE: u8 = 60;
const BACKGROUND_FRAME_RATE: u8 = 15;
const HIDDEN_FRAME_RATE: u8 = 1;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct RenderActivityPolicy {
    pub(super) frame_rate: u8,
    pub(super) hidden: bool,
}

pub(super) fn render_activity_policy(focused: bool, hidden: bool) -> RenderActivityPolicy {
    if hidden {
        RenderActivityPolicy {
            frame_rate: HIDDEN_FRAME_RATE,
            hidden: true,
        }
    } else if focused {
        RenderActivityPolicy {
            frame_rate: ACTIVE_FRAME_RATE,
            hidden: false,
        }
    } else {
        RenderActivityPolicy {
            frame_rate: BACKGROUND_FRAME_RATE,
            hidden: false,
        }
    }
}

#[cfg(windows)]
pub(super) struct PresentScheduler {
    state: Arc<PresentSchedulerState>,
    thread: Mutex<Option<JoinHandle<()>>>,
}

#[cfg(windows)]
struct PresentSchedulerState {
    running: AtomicBool,
    frame_rate: AtomicU8,
    dirty: Mutex<bool>,
    coalesced_frames: AtomicU64,
    wake: Condvar,
}

#[cfg(windows)]
impl PresentScheduler {
    pub(super) fn start(renderer: Arc<Mutex<GpuCompositor>>) -> Result<Arc<Self>, String> {
        let state = Arc::new(PresentSchedulerState {
            running: AtomicBool::new(true),
            frame_rate: AtomicU8::new(ACTIVE_FRAME_RATE),
            dirty: Mutex::new(false),
            coalesced_frames: AtomicU64::new(0),
            wake: Condvar::new(),
        });
        let thread_state = state.clone();
        let thread = thread::Builder::new()
            .name("ardor-gpu-present".to_string())
            .spawn(move || run_present_loop(renderer, thread_state))
            .map_err(|error| format!("failed to spawn GPU present scheduler: {error}"))?;
        Ok(Arc::new(Self {
            state,
            thread: Mutex::new(Some(thread)),
        }))
    }

    pub(super) fn request(&self) {
        if !self.state.running.load(Ordering::Acquire) {
            return;
        }
        let mut dirty = self
            .state
            .dirty
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if *dirty {
            self.state.coalesced_frames.fetch_add(1, Ordering::Relaxed);
        }
        *dirty = true;
        drop(dirty);
        self.state.wake.notify_one();
    }

    pub(super) fn coalesced_frames(&self) -> u64 {
        self.state.coalesced_frames.load(Ordering::Relaxed)
    }

    pub(super) fn set_frame_rate(&self, frame_rate: u8) {
        let frame_rate = frame_rate.clamp(HIDDEN_FRAME_RATE, ACTIVE_FRAME_RATE);
        if self.state.frame_rate.swap(frame_rate, Ordering::AcqRel) != frame_rate {
            *self
                .state
                .dirty
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()) = true;
            self.state.wake.notify_all();
        }
    }

    pub(super) fn stop(&self) {
        if self.state.running.swap(false, Ordering::AcqRel) {
            self.state.wake.notify_all();
        }
        let thread = self
            .thread
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take();
        if let Some(thread) = thread {
            let _ = thread.join();
        }
    }
}

#[cfg(windows)]
impl Drop for PresentScheduler {
    fn drop(&mut self) {
        self.stop();
    }
}

#[cfg(windows)]
fn run_present_loop(renderer: Arc<Mutex<GpuCompositor>>, state: Arc<PresentSchedulerState>) {
    let mut next_present = Instant::now();
    let mut last_frame_rate = state.frame_rate.load(Ordering::Acquire);

    while state.running.load(Ordering::Acquire) {
        let mut dirty = state
            .dirty
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        while !*dirty && state.running.load(Ordering::Acquire) {
            dirty = state
                .wake
                .wait(dirty)
                .unwrap_or_else(|poisoned| poisoned.into_inner());
        }
        if !state.running.load(Ordering::Acquire) {
            break;
        }

        loop {
            let now = Instant::now();
            let frame_rate = state.frame_rate.load(Ordering::Acquire).max(1);
            if frame_rate != last_frame_rate {
                next_present = now;
                last_frame_rate = frame_rate;
            }
            if now >= next_present {
                break;
            }
            let timeout = next_present.saturating_duration_since(now);
            let (guard, _) = state
                .wake
                .wait_timeout(dirty, timeout)
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            dirty = guard;
            if !state.running.load(Ordering::Acquire) {
                return;
            }
        }

        let frame_interval = Duration::from_secs_f64(1.0 / f64::from(last_frame_rate));
        *dirty = false;
        drop(dirty);
        renderer
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .present();
        next_present += frame_interval;
        let now = Instant::now();
        if next_present < now {
            next_present = now;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn render_activity_keeps_overlays_at_full_rate() {
        assert_eq!(
            render_activity_policy(true, false),
            RenderActivityPolicy {
                frame_rate: 60,
                hidden: false,
            }
        );
    }

    #[test]
    fn render_activity_throttles_background_and_hidden_windows() {
        assert_eq!(render_activity_policy(false, false).frame_rate, 15);
        assert_eq!(render_activity_policy(true, true).frame_rate, 1);
        assert!(render_activity_policy(false, true).hidden);
    }
}
