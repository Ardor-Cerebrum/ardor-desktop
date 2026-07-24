use super::{InputRouter, NativeInputHook, Runtime, FOCUSED_PREVIEW, FOCUSED_SHELL};
use std::{
    collections::HashMap,
    ffi::c_void,
    sync::{atomic::Ordering, Arc, Mutex, OnceLock},
};

const SUBCLASS_ID: usize = 0x4152_444f_5247_5055;

#[repr(C)]
struct WinPoint {
    x: i32,
    y: i32,
}

#[repr(C)]
struct TrackMouseEvent {
    size: u32,
    flags: u32,
    hwnd_track: *mut c_void,
    hover_time: u32,
}

type SubclassProc = unsafe extern "system" fn(
    hwnd: *mut c_void,
    message: u32,
    wparam: usize,
    lparam: isize,
    id: usize,
    data: usize,
) -> isize;

#[link(name = "comctl32")]
unsafe extern "system" {
    fn SetWindowSubclass(
        hwnd: *mut c_void,
        proc: Option<SubclassProc>,
        id: usize,
        data: usize,
    ) -> i32;
    fn RemoveWindowSubclass(hwnd: *mut c_void, proc: Option<SubclassProc>, id: usize) -> i32;
    fn DefSubclassProc(hwnd: *mut c_void, message: u32, wparam: usize, lparam: isize) -> isize;
}

#[link(name = "user32")]
unsafe extern "system" {
    fn TrackMouseEvent(event: *mut TrackMouseEvent) -> i32;
    fn ClientToScreen(hwnd: *mut c_void, point: *mut WinPoint) -> i32;
    fn ScreenToClient(hwnd: *mut c_void, point: *mut WinPoint) -> i32;
    fn GetKeyState(virtual_key: i32) -> i16;
}

const WM_SETFOCUS: u32 = 0x0007;
const WM_KILLFOCUS: u32 = 0x0008;
const WM_KEYDOWN: u32 = 0x0100;
const WM_KEYUP: u32 = 0x0101;
const WM_CHAR: u32 = 0x0102;
const WM_SYSKEYDOWN: u32 = 0x0104;
const WM_SYSKEYUP: u32 = 0x0105;
const WM_MOUSEMOVE: u32 = 0x0200;
const WM_LBUTTONDOWN: u32 = 0x0201;
const WM_LBUTTONUP: u32 = 0x0202;
const WM_RBUTTONDOWN: u32 = 0x0204;
const WM_RBUTTONUP: u32 = 0x0205;
const WM_MOUSEWHEEL: u32 = 0x020a;
const WM_MOUSELEAVE: u32 = 0x02a3;
const WM_NCDESTROY: u32 = 0x0082;
const TME_LEAVE: u32 = 0x0000_0002;
const VK_SHIFT: i32 = 0x10;
const VK_CONTROL: i32 = 0x11;
const VK_MENU: i32 = 0x12;

impl InputRouter {
    fn update_screen_origins(&self, hwnd: *mut c_void) {
        let mut client_origin = WinPoint { x: 0, y: 0 };
        if unsafe { ClientToScreen(hwnd, &mut client_origin) } == 0 {
            return;
        }

        let scale = self.scale();
        let preview_rect = self.layout().preview;
        self.shell_surface
            .set_screen_origin(client_origin.x, client_origin.y);
        self.preview_surface.set_screen_origin(
            client_origin
                .x
                .saturating_add(logical_to_physical(preview_rect.x, scale)),
            client_origin
                .y
                .saturating_add(logical_to_physical(preview_rect.y, scale)),
        );
    }
}

fn logical_to_physical(value: f64, scale: f64) -> i32 {
    (value * scale)
        .round()
        .clamp(f64::from(i32::MIN), f64::from(i32::MAX)) as i32
}

static INPUT_ROUTERS: OnceLock<Mutex<HashMap<usize, Arc<InputRouter>>>> = OnceLock::new();

pub(super) struct WindowsInputHook {
    hwnd: *mut c_void,
    window: tauri::Window<Runtime>,
    detached: bool,
}

unsafe impl Send for WindowsInputHook {}
unsafe impl Sync for WindowsInputHook {}

impl NativeInputHook for WindowsInputHook {
    fn install(window: &tauri::Window<Runtime>, router: Arc<InputRouter>) -> Result<Self, String> {
        let hwnd = window
            .hwnd()
            .map_err(|error| format!("failed to read compositor HWND: {error}"))?
            .0;
        if hwnd.is_null() {
            return Err("compositor HWND is null".to_string());
        }
        let (sender, receiver) = std::sync::mpsc::sync_channel(1);
        let hwnd_key = hwnd as usize;
        window
            .run_on_main_thread(move || {
                INPUT_ROUTERS
                    .get_or_init(|| Mutex::new(HashMap::new()))
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .insert(hwnd_key, router);
                let installed = unsafe {
                    SetWindowSubclass(
                        hwnd_key as *mut c_void,
                        Some(compositor_subclass_proc),
                        SUBCLASS_ID,
                        0,
                    )
                };
                let result = if installed == 0 {
                    INPUT_ROUTERS
                        .get()
                        .expect("input router map was initialized")
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner())
                        .remove(&hwnd_key);
                    Err(format!(
                        "failed to subclass compositor window: {}",
                        std::io::Error::last_os_error()
                    ))
                } else {
                    Ok(())
                };
                let _ = sender.send(result);
            })
            .map_err(|error| format!("failed to schedule compositor input hook: {error}"))?;
        receiver
            .recv()
            .map_err(|_| "compositor input hook task was cancelled".to_string())??;
        Ok(Self {
            hwnd,
            window: window.clone(),
            detached: false,
        })
    }

    fn detach(&mut self) -> Result<(), String> {
        if self.detached {
            return Ok(());
        }
        let hwnd_key = self.hwnd as usize;
        let (sender, receiver) = std::sync::mpsc::sync_channel(1);
        self.window
            .run_on_main_thread(move || {
                if let Some(routers) = INPUT_ROUTERS.get() {
                    routers
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner())
                        .remove(&hwnd_key);
                }
                unsafe {
                    RemoveWindowSubclass(
                        hwnd_key as *mut c_void,
                        Some(compositor_subclass_proc),
                        SUBCLASS_ID,
                    );
                }
                let _ = sender.send(());
            })
            .map_err(|error| format!("failed to schedule compositor input detach: {error}"))?;
        receiver
            .recv()
            .map_err(|_| "compositor input detach task was cancelled".to_string())?;
        self.detached = true;
        Ok(())
    }
}

impl Drop for WindowsInputHook {
    fn drop(&mut self) {
        let _ = self.detach();
    }
}

unsafe extern "system" fn compositor_subclass_proc(
    hwnd: *mut c_void,
    message: u32,
    wparam: usize,
    lparam: isize,
    _id: usize,
    _data: usize,
) -> isize {
    let router = INPUT_ROUTERS.get().and_then(|routers| {
        routers
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(&(hwnd as usize))
            .cloned()
    });
    if let Some(router) = router {
        match message {
            WM_SETFOCUS => router.focus(router.focused.load(Ordering::Acquire)),
            WM_KILLFOCUS => {
                router.shell.set_offscreen_focus(false);
                router.preview.set_offscreen_focus(false);
            }
            WM_MOUSEMOVE | WM_LBUTTONDOWN | WM_LBUTTONUP | WM_RBUTTONDOWN | WM_RBUTTONUP => {
                router.update_screen_origins(hwnd);
                let (x, y) = lparam_point(lparam);
                let routed = router.route(x, y);
                let event = cef::MouseEvent {
                    x: routed.x,
                    y: routed.y,
                    modifiers: mouse_modifiers(wparam),
                };
                match message {
                    WM_MOUSEMOVE => {
                        let mut track = TrackMouseEvent {
                            size: std::mem::size_of::<TrackMouseEvent>() as u32,
                            flags: TME_LEAVE,
                            hwnd_track: hwnd,
                            hover_time: 0,
                        };
                        TrackMouseEvent(&mut track);
                        routed.target.send_offscreen_mouse_move(event, false);
                    }
                    WM_LBUTTONDOWN => {
                        router.focus(routed.focus);
                        routed.target.send_offscreen_mouse_click(
                            event,
                            cef::MouseButtonType::LEFT,
                            false,
                            1,
                        );
                    }
                    WM_LBUTTONUP => routed.target.send_offscreen_mouse_click(
                        event,
                        cef::MouseButtonType::LEFT,
                        true,
                        1,
                    ),
                    WM_RBUTTONDOWN => {
                        router.focus(routed.focus);
                        routed.target.send_offscreen_mouse_click(
                            event,
                            cef::MouseButtonType::RIGHT,
                            false,
                            1,
                        );
                    }
                    WM_RBUTTONUP => routed.target.send_offscreen_mouse_click(
                        event,
                        cef::MouseButtonType::RIGHT,
                        true,
                        1,
                    ),
                    _ => {}
                }
            }
            WM_MOUSELEAVE => {
                let target = router.focused_webview();
                target.send_offscreen_mouse_move(cef::MouseEvent::default(), true);
            }
            WM_MOUSEWHEEL => {
                router.update_screen_origins(hwnd);
                let (screen_x, screen_y) = lparam_point(lparam);
                let mut point = WinPoint {
                    x: screen_x,
                    y: screen_y,
                };
                ScreenToClient(hwnd, &mut point);
                let routed = router.route(point.x, point.y);
                routed.target.send_offscreen_mouse_wheel(
                    cef::MouseEvent {
                        x: routed.x,
                        y: routed.y,
                        modifiers: mouse_modifiers(wparam),
                    },
                    0,
                    i32::from(high_word_signed(wparam)),
                );
            }
            WM_KEYDOWN | WM_SYSKEYDOWN | WM_KEYUP | WM_SYSKEYUP | WM_CHAR => {
                let modifiers = keyboard_modifiers();
                let target = router.focused_webview();
                if message == WM_CHAR {
                    let character = (wparam & 0xffff) as u16;
                    target.send_offscreen_key_event(cef::KeyEvent {
                        type_: cef::KeyEventType::CHAR,
                        modifiers,
                        windows_key_code: i32::from(character),
                        character,
                        unmodified_character: character,
                        ..Default::default()
                    });
                } else {
                    let key_up = matches!(message, WM_KEYUP | WM_SYSKEYUP);
                    target.send_offscreen_key_event(cef::KeyEvent {
                        type_: if key_up {
                            cef::KeyEventType::KEYUP
                        } else {
                            cef::KeyEventType::RAWKEYDOWN
                        },
                        modifiers,
                        windows_key_code: wparam as i32,
                        native_key_code: lparam as i32,
                        is_system_key: i32::from(matches!(message, WM_SYSKEYDOWN | WM_SYSKEYUP)),
                        ..Default::default()
                    });
                }
            }
            WM_NCDESTROY => {
                if let Some(routers) = INPUT_ROUTERS.get() {
                    routers
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner())
                        .remove(&(hwnd as usize));
                }
            }
            _ => {}
        }
    }
    DefSubclassProc(hwnd, message, wparam, lparam)
}

fn lparam_point(lparam: isize) -> (i32, i32) {
    let packed = lparam as u32;
    (
        (packed as u16 as i16) as i32,
        ((packed >> 16) as u16 as i16) as i32,
    )
}

fn high_word_signed(value: usize) -> i16 {
    ((value >> 16) as u16) as i16
}

fn mouse_modifiers(wparam: usize) -> u32 {
    const SHIFT_DOWN: u32 = 1 << 1;
    const CONTROL_DOWN: u32 = 1 << 2;
    const LEFT_MOUSE_BUTTON: u32 = 1 << 4;
    const RIGHT_MOUSE_BUTTON: u32 = 1 << 6;
    let mut modifiers = 0;
    if wparam & 0x0004 != 0 {
        modifiers |= SHIFT_DOWN;
    }
    if wparam & 0x0008 != 0 {
        modifiers |= CONTROL_DOWN;
    }
    if wparam & 0x0001 != 0 {
        modifiers |= LEFT_MOUSE_BUTTON;
    }
    if wparam & 0x0002 != 0 {
        modifiers |= RIGHT_MOUSE_BUTTON;
    }
    modifiers
}

fn keyboard_modifiers() -> u32 {
    const SHIFT_DOWN: u32 = 1 << 1;
    const CONTROL_DOWN: u32 = 1 << 2;
    const ALT_DOWN: u32 = 1 << 3;
    let mut modifiers = 0;
    unsafe {
        if GetKeyState(VK_SHIFT) < 0 {
            modifiers |= SHIFT_DOWN;
        }
        if GetKeyState(VK_CONTROL) < 0 {
            modifiers |= CONTROL_DOWN;
        }
        if GetKeyState(VK_MENU) < 0 {
            modifiers |= ALT_DOWN;
        }
    }
    modifiers
}
