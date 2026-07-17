use std::{
    cell::{Cell, RefCell},
    ffi::c_void,
    mem::size_of,
    rc::Rc,
    sync::mpsc,
};

use tauri::Webview;
use webview2_com::{
    take_pwstr, AddScriptToExecuteOnDocumentCreatedCompletedHandler,
    CreateCoreWebView2CompositionControllerCompletedHandler, CursorChangedEventHandler,
    DownloadStartingEventHandler, ExecuteScriptCompletedHandler,
    Microsoft::Web::WebView2::Win32::*, MoveFocusRequestedEventHandler,
    NavigationStartingEventHandler, NewWindowRequestedEventHandler,
    PermissionRequestedEventHandler,
};
use windows::{
    core::{w, IUnknown, Interface, HSTRING, PWSTR},
    Win32::{
        Foundation::{
            GetLastError, SetLastError, ERROR_CLASS_ALREADY_EXISTS, E_POINTER, E_UNEXPECTED,
            HINSTANCE, HWND, LPARAM, LRESULT, POINT, RECT, WIN32_ERROR, WPARAM,
        },
        Graphics::{
            Direct2D::Common::D2D_RECT_F,
            DirectComposition::{
                DCompositionCreateDevice2, IDCompositionDevice, IDCompositionTarget,
                IDCompositionVisual,
            },
            Gdi::{
                CombineRgn, CreateRectRgn, CreateRoundRectRgn, DeleteObject, ScreenToClient,
                SetWindowRgn, ERROR, HGDIOBJ, HRGN, RGN_DIFF,
            },
        },
        System::LibraryLoader::GetModuleHandleW,
        UI::{
            Input::KeyboardAndMouse::{
                GetCapture, ReleaseCapture, SetCapture, TrackMouseEvent, TME_CANCEL, TME_LEAVE,
                TRACKMOUSEEVENT,
            },
            WindowsAndMessaging::{
                CreateWindowExW, DefWindowProcW, DestroyWindow, GetClientRect, GetWindowLongPtrW,
                LoadCursorW, RegisterClassW, SetCursor, SetWindowLongPtrW, SetWindowPos,
                ShowWindow, WindowFromPoint, CS_DBLCLKS, GWLP_USERDATA, HCURSOR, HTCLIENT,
                HWND_TOP, IDC_ARROW, SWP_NOACTIVATE, SW_HIDE, SW_SHOWNA, WM_CANCELMODE,
                WM_CAPTURECHANGED, WM_LBUTTONDBLCLK, WM_LBUTTONDOWN, WM_LBUTTONUP,
                WM_MBUTTONDBLCLK, WM_MBUTTONDOWN, WM_MBUTTONUP, WM_MOUSEHWHEEL, WM_MOUSEMOVE,
                WM_MOUSEWHEEL, WM_NCHITTEST, WM_RBUTTONDBLCLK, WM_RBUTTONDOWN, WM_RBUTTONUP,
                WM_SETCURSOR, WM_XBUTTONDBLCLK, WM_XBUTTONDOWN, WM_XBUTTONUP, WNDCLASSW, WS_CHILD,
                WS_CLIPCHILDREN, WS_CLIPSIBLINGS, WS_EX_NOACTIVATE,
            },
        },
    },
};

use super::{
    describe_navigation, is_allowed_sidebar_navigation, is_public_https_url, BrowserBounds,
    BrowserOverlay, SidebarBrowserAction, SidebarBrowserInput, SidebarBrowserInputResponse,
    DEVICE_PERMISSION_DEFENSE_IN_DEPTH,
};

const MOVE_FOCUS_NEXT_SCRIPT: &str = r#"window.dispatchEvent(new CustomEvent('ardor:sidebar-browser-move-focus', { detail: 'next' }));"#;
const MOVE_FOCUS_PREVIOUS_SCRIPT: &str = r#"window.dispatchEvent(new CustomEvent('ardor:sidebar-browser-move-focus', { detail: 'previous' }));"#;
const WM_MOUSELEAVE_MESSAGE: u32 = 0x02a3;
const WEBVIEW2_MOUSE_KEY_MASK: u16 = 0x007f;
const WEBVIEW2_MOUSE_BUTTON_MASK: u16 = 0x0073;
const WEBVIEW2_MOUSE_MODIFIER_MASK: u16 = 0x000c;

thread_local! {
    static ACTIVE_BROWSER: RefCell<Option<CompositionBrowser>> = const { RefCell::new(None) };
}

#[derive(Default)]
struct EventTokens {
    cursor_changed: Option<i64>,
    move_focus_requested: Option<i64>,
    navigation_starting: Option<i64>,
    new_window_requested: Option<i64>,
    permission_requested: Option<i64>,
    download_starting: Option<i64>,
}

struct HostInputState {
    controller: ICoreWebView2Controller,
    composition_controller: ICoreWebView2CompositionController,
    enabled: Cell<bool>,
    tracking_leave: Cell<bool>,
    pressed_keys: Cell<u16>,
    last_keys: Cell<u16>,
    last_point: Cell<POINT>,
    logged_input_error: Cell<bool>,
}

impl HostInputState {
    fn new(
        controller: &ICoreWebView2Controller,
        composition_controller: &ICoreWebView2CompositionController,
    ) -> Self {
        Self {
            controller: controller.clone(),
            composition_controller: composition_controller.clone(),
            enabled: Cell::new(true),
            tracking_leave: Cell::new(false),
            pressed_keys: Cell::new(0),
            last_keys: Cell::new(0),
            last_point: Cell::new(POINT { x: 0, y: 0 }),
            logged_input_error: Cell::new(false),
        }
    }

    fn report_input_error(&self, context: &str, error: windows::core::Error) {
        if !self.logged_input_error.replace(true) {
            eprintln!("{context}: {error}");
        }
    }
}

struct PendingControllerClose(Option<ICoreWebView2Controller>);

struct PendingHostWindow(Option<HWND>);

struct OwnedRegion(Option<HRGN>);

struct DetachedHostInput {
    pointer: *const HostInputState,
    detached: bool,
}

impl PendingControllerClose {
    fn new(controller: &ICoreWebView2Controller) -> Self {
        Self(Some(controller.clone()))
    }

    fn disarm(&mut self) {
        self.0 = None;
    }
}

impl Drop for PendingControllerClose {
    fn drop(&mut self) {
        if let Some(controller) = self.0.take() {
            let _ = unsafe { controller.Close() };
        }
    }
}

impl PendingHostWindow {
    fn new(hwnd: HWND) -> Self {
        Self(Some(hwnd))
    }

    fn disarm(&mut self) {
        self.0 = None;
    }
}

impl Drop for PendingHostWindow {
    fn drop(&mut self) {
        if let Some(hwnd) = self.0.take() {
            let _ = unsafe { DestroyWindow(hwnd) };
        }
    }
}

impl OwnedRegion {
    fn new(region: HRGN, context: &str) -> Result<Self, String> {
        if region.0.is_null() {
            Err(windows_error(context, windows::core::Error::from_win32()))
        } else {
            Ok(Self(Some(region)))
        }
    }

    fn handle(&self) -> HRGN {
        self.0.expect("owned region handle must be present")
    }

    fn release_to_system(&mut self) {
        self.0 = None;
    }
}

impl Drop for OwnedRegion {
    fn drop(&mut self) {
        if let Some(region) = self.0.take() {
            let _ = unsafe { DeleteObject(HGDIOBJ(region.0)) };
        }
    }
}

struct CompositionBrowser {
    generation: u64,
    host_hwnd: HWND,
    controller: ICoreWebView2Controller,
    composition_controller: ICoreWebView2CompositionController,
    webview: ICoreWebView2,
    webview4: ICoreWebView2_4,
    dcomp_device: IDCompositionDevice,
    dcomp_target: IDCompositionTarget,
    dcomp_root_visual: IDCompositionVisual,
    dcomp_webview_visual: IDCompositionVisual,
    host_input: Rc<HostInputState>,
    event_tokens: EventTokens,
}

impl CompositionBrowser {
    fn create(
        platform: tauri::webview::PlatformWebview,
        generation: u64,
        parent_hwnd: isize,
        bounds: BrowserBounds,
        overlays: Vec<BrowserOverlay>,
        scale_factor: f64,
        url: String,
    ) -> Result<Self, String> {
        let environment = platform.environment();
        let main_controller = platform.controller();

        let main_webview = unsafe {
            main_controller.CoreWebView2().map_err(|error| {
                windows_error(
                    "failed to access the main WebView2 for focus handoff",
                    error,
                )
            })?
        };
        let parent_hwnd = HWND(parent_hwnd as *mut c_void);
        let physical = PhysicalBounds::from_logical(bounds, scale_factor)?;
        let host_hwnd = create_composition_host(parent_hwnd, physical)?;
        let mut pending_host_window = PendingHostWindow::new(host_hwnd);
        let composition_controller = create_composition_controller(&environment, host_hwnd)?;
        let controller: ICoreWebView2Controller = composition_controller
            .cast()
            .map_err(|error| windows_error("failed to access the WebView2 controller", error))?;
        let mut pending_controller_close = PendingControllerClose::new(&controller);
        let webview = unsafe {
            controller
                .CoreWebView2()
                .map_err(|error| windows_error("failed to access the composed WebView2", error))?
        };
        let webview4: ICoreWebView2_4 = webview
            .cast()
            .map_err(|error| windows_error("WebView2 download controls are unavailable", error))?;
        let host_input = Rc::new(HostInputState::new(&controller, &composition_controller));

        let dcomp_device: IDCompositionDevice = unsafe {
            DCompositionCreateDevice2(None::<&IUnknown>).map_err(|error| {
                windows_error("failed to create the DirectComposition device", error)
            })?
        };
        let dcomp_target = unsafe {
            // This target is topmost only inside the dedicated preview host HWND. The host's
            // window region is cut around active Radix overlays so the original main WebView
            // remains visible and interactive in those exact areas.
            dcomp_device
                .CreateTargetForHwnd(host_hwnd, true)
                .map_err(|error| {
                    windows_error("failed to create the DirectComposition target", error)
                })?
        };
        let dcomp_root_visual = unsafe {
            dcomp_device.CreateVisual().map_err(|error| {
                windows_error("failed to create the DirectComposition root visual", error)
            })?
        };
        let dcomp_webview_visual = unsafe {
            dcomp_device.CreateVisual().map_err(|error| {
                windows_error("failed to create the WebView2 composition visual", error)
            })?
        };

        unsafe {
            dcomp_target.SetRoot(&dcomp_root_visual).map_err(|error| {
                windows_error("failed to attach the DirectComposition root visual", error)
            })?;
            dcomp_root_visual
                .AddVisual(&dcomp_webview_visual, true, None::<&IDCompositionVisual>)
                .map_err(|error| {
                    windows_error("failed to attach the WebView2 composition visual", error)
                })?;
            let visual_target: IUnknown = dcomp_webview_visual.cast().map_err(|error| {
                windows_error("failed to expose the WebView2 composition visual", error)
            })?;
            composition_controller
                .SetRootVisualTarget(&visual_target)
                .map_err(|error| {
                    windows_error("failed to connect WebView2 to DirectComposition", error)
                })?;
        }

        let mut browser = Self {
            generation,
            host_hwnd,
            controller,
            composition_controller,
            webview,
            webview4,
            dcomp_device,
            dcomp_target,
            dcomp_root_visual,
            dcomp_webview_visual,
            host_input,
            event_tokens: EventTokens::default(),
        };
        pending_controller_close.disarm();
        pending_host_window.disarm();
        install_host_input(browser.host_hwnd, &browser.host_input)?;
        install_cursor_handler(
            browser.host_hwnd,
            &browser.composition_controller,
            &mut browser.event_tokens,
        )?;
        install_security_handlers(
            &browser.webview,
            &browser.webview4,
            &mut browser.event_tokens,
        )?;
        install_focus_handler(
            &main_controller,
            &main_webview,
            &browser.controller,
            &mut browser.event_tokens,
        )?;
        add_initialization_script(&browser.webview)?;
        browser.apply_layout(bounds, true, &overlays, scale_factor)?;

        let uri = HSTRING::from(url);
        unsafe {
            browser.webview.Navigate(&uri).map_err(|error| {
                windows_error("failed to navigate the composed WebView2", error)
            })?;
        }
        Ok(browser)
    }

    fn apply_layout(
        &mut self,
        bounds: BrowserBounds,
        visible: bool,
        overlays: &[BrowserOverlay],
        scale_factor: f64,
    ) -> Result<(), String> {
        let physical = PhysicalBounds::from_logical(bounds, scale_factor)?;

        unsafe {
            if physical.width > 0 && physical.height > 0 {
                SetWindowPos(
                    self.host_hwnd,
                    Some(HWND_TOP),
                    physical.x,
                    physical.y,
                    physical.width,
                    physical.height,
                    SWP_NOACTIVATE,
                )
                .map_err(|error| {
                    windows_error("failed to position the composition host window", error)
                })?;
                self.controller
                    .SetBounds(RECT {
                        left: 0,
                        top: 0,
                        right: physical.width,
                        bottom: physical.height,
                    })
                    .map_err(|error| {
                        windows_error("failed to size the composed WebView2", error)
                    })?;
                self.dcomp_root_visual.SetOffsetX2(0.0).map_err(|error| {
                    windows_error(
                        "failed to position the composed WebView2 horizontally",
                        error,
                    )
                })?;
                self.dcomp_root_visual.SetOffsetY2(0.0).map_err(|error| {
                    windows_error("failed to position the composed WebView2 vertically", error)
                })?;
                self.dcomp_root_visual
                    .SetClip2(&D2D_RECT_F {
                        left: 0.0,
                        top: 0.0,
                        right: physical.width as f32,
                        bottom: physical.height as f32,
                    })
                    .map_err(|error| {
                        windows_error("failed to clip the composed WebView2", error)
                    })?;
                apply_host_region(self.host_hwnd, physical, overlays, scale_factor)?;
            }
            self.controller.SetIsVisible(visible).map_err(|error| {
                windows_error("failed to change the composed WebView2 visibility", error)
            })?;
            self.controller
                .NotifyParentWindowPositionChanged()
                .map_err(|error| {
                    windows_error("failed to notify WebView2 about its host position", error)
                })?;
            self.dcomp_device.Commit().map_err(|error| {
                windows_error("failed to commit the DirectComposition layout", error)
            })?;
            let _ = ShowWindow(self.host_hwnd, if visible { SW_SHOWNA } else { SW_HIDE });
        }
        Ok(())
    }

    fn control(&self, action: SidebarBrowserAction) -> Result<(), String> {
        unsafe {
            match action {
                SidebarBrowserAction::Back => self.webview.GoBack().map_err(|error| {
                    windows_error("failed to navigate the composed WebView2 back", error)
                })?,
                SidebarBrowserAction::Forward => self.webview.GoForward().map_err(|error| {
                    windows_error("failed to navigate the composed WebView2 forward", error)
                })?,
                SidebarBrowserAction::Reload => self.webview.Reload().map_err(|error| {
                    windows_error("failed to reload the composed WebView2", error)
                })?,
                SidebarBrowserAction::OpenExternal => {
                    let url = current_url(&self.webview)?;
                    let parsed = tauri::Url::parse(&url)
                        .map_err(|_| "composed WebView2 returned an invalid URL".to_string())?;
                    if !is_public_https_url(&parsed) {
                        return Err("refusing to open a non-public sidebar browser URL".to_string());
                    }
                    crate::open_external_url(&url)?;
                }
            }
        }
        Ok(())
    }

    fn send_input(
        &self,
        input: SidebarBrowserInput,
    ) -> Result<SidebarBrowserInputResponse, String> {
        if let Some(reason) = input.kind.focus_reason() {
            unsafe {
                self.controller.MoveFocus(reason).map_err(|error| {
                    windows_error("failed to focus the composed WebView2", error)
                })?;
            }
            return Ok(SidebarBrowserInputResponse::accepted("default"));
        }
        Ok(SidebarBrowserInputResponse::ignored())
    }
}

impl Drop for CompositionBrowser {
    fn drop(&mut self) {
        self.host_input.enabled.set(false);
        cancel_leave_tracking(self.host_hwnd, self.host_input.as_ref());
        unsafe {
            if GetCapture() == self.host_hwnd {
                let _ = ReleaseCapture();
            }
        }
        let raw_host_input = detach_host_input(self.host_hwnd);

        unsafe {
            if let Some(token) = self.event_tokens.cursor_changed.take() {
                let _ = self.composition_controller.remove_CursorChanged(token);
            }
            if let Some(token) = self.event_tokens.move_focus_requested.take() {
                let _ = self.controller.remove_MoveFocusRequested(token);
            }
            if let Some(token) = self.event_tokens.navigation_starting.take() {
                let _ = self.webview.remove_NavigationStarting(token);
            }
            if let Some(token) = self.event_tokens.new_window_requested.take() {
                let _ = self.webview.remove_NewWindowRequested(token);
            }
            if let Some(token) = self.event_tokens.permission_requested.take() {
                let _ = self.webview.remove_PermissionRequested(token);
            }
            if let Some(token) = self.event_tokens.download_starting.take() {
                let _ = self.webview4.remove_DownloadStarting(token);
            }

            let _ = self
                .composition_controller
                .SetRootVisualTarget(None::<&IUnknown>);
            let _ = self.dcomp_webview_visual.RemoveAllVisuals();
            let _ = self.dcomp_root_visual.RemoveAllVisuals();
            let _ = self.dcomp_target.SetRoot(None::<&IDCompositionVisual>);
            let _ = self.dcomp_device.Commit();
            let _ = self.controller.Close();
            let host_destroyed = DestroyWindow(self.host_hwnd).is_ok();

            if let Some(raw_host_input) = raw_host_input {
                if raw_host_input.detached || host_destroyed {
                    drop(Rc::from_raw(raw_host_input.pointer));
                } else {
                    // The HWND may still reference this count. Leaking it is safer than
                    // leaving a dangling GWLP_USERDATA pointer on a live window.
                    eprintln!("leaking composition host input state after teardown failure");
                }
            }
        }
    }
}

unsafe extern "system" fn composition_host_window_proc(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    if message == WM_NCHITTEST {
        return LRESULT(HTCLIENT as isize);
    }

    let state = unsafe { clone_host_input_state(hwnd) };
    let Some(state) = state.filter(|state| state.enabled.get()) else {
        return unsafe { DefWindowProcW(hwnd, message, wparam, lparam) };
    };

    match message {
        WM_SETCURSOR => {
            if low_word(lparam.0 as usize) == HTCLIENT as u16 && set_host_cursor(&state) {
                return LRESULT(1);
            }
        }
        WM_MOUSEMOVE => {
            let point = client_point(lparam);
            state.last_point.set(point);
            let keys = key_state(wparam);
            state.last_keys.set(keys);
            ensure_leave_tracking(hwnd, &state, point);
            if forward_mouse_input(
                &state,
                COREWEBVIEW2_MOUSE_EVENT_KIND_MOVE,
                virtual_keys_from_native(keys),
                0,
                point,
                false,
            ) {
                return LRESULT(0);
            }
        }
        WM_MOUSELEAVE_MESSAGE => {
            state.tracking_leave.set(false);
            if forward_mouse_input(
                &state,
                COREWEBVIEW2_MOUSE_EVENT_KIND_LEAVE,
                COREWEBVIEW2_MOUSE_EVENT_VIRTUAL_KEYS_NONE,
                0,
                POINT { x: 0, y: 0 },
                false,
            ) {
                return LRESULT(0);
            }
        }
        WM_CAPTURECHANGED => {
            release_stuck_buttons(hwnd, &state);
        }
        WM_CANCELMODE => {
            release_stuck_buttons(hwnd, &state);
            if GetCapture() == hwnd {
                let _ = ReleaseCapture();
            }
        }
        _ => {
            if let Some(event_kind) = native_mouse_event_kind(message) {
                let Some(point) = native_mouse_point(hwnd, message, lparam) else {
                    return unsafe { DefWindowProcW(hwnd, message, wparam, lparam) };
                };
                let keys = key_state(wparam);
                state.last_keys.set(keys);
                state.last_point.set(point);
                state.pressed_keys.set(keys & WEBVIEW2_MOUSE_BUTTON_MASK);

                let button_down = is_button_down(message);
                if button_down && GetCapture() != hwnd {
                    SetCapture(hwnd);
                }

                let handled = forward_mouse_input(
                    &state,
                    event_kind,
                    virtual_keys_from_native(keys),
                    native_mouse_data(message, wparam),
                    point,
                    button_down,
                );

                if is_button_up(message) && state.pressed_keys.get() == 0 && GetCapture() == hwnd {
                    let _ = ReleaseCapture();
                }

                if handled {
                    return LRESULT(if is_x_button_message(message) { 1 } else { 0 });
                }
            }
        }
    }
    unsafe { DefWindowProcW(hwnd, message, wparam, lparam) }
}

unsafe fn clone_host_input_state(hwnd: HWND) -> Option<Rc<HostInputState>> {
    let pointer = unsafe { GetWindowLongPtrW(hwnd, GWLP_USERDATA) } as *const HostInputState;
    if pointer.is_null() {
        return None;
    }
    // GWLP_USERDATA owns one strong count created by Rc::into_raw. Clone it before
    // dispatch so reentrant teardown cannot release the COM state underneath this call.
    unsafe {
        Rc::increment_strong_count(pointer);
        Some(Rc::from_raw(pointer))
    }
}

fn install_host_input(hwnd: HWND, state: &Rc<HostInputState>) -> Result<(), String> {
    let pointer = Rc::into_raw(Rc::clone(state));
    unsafe {
        SetLastError(WIN32_ERROR(0));
        let previous = SetWindowLongPtrW(hwnd, GWLP_USERDATA, pointer as isize);
        if previous == 0 {
            let error = GetLastError();
            if error != WIN32_ERROR(0) {
                drop(Rc::from_raw(pointer));
                return Err(windows_error(
                    "failed to attach input state to the composition host",
                    windows::core::Error::from_win32(),
                ));
            }
        } else {
            SetWindowLongPtrW(hwnd, GWLP_USERDATA, previous);
            drop(Rc::from_raw(pointer));
            return Err("composition host already has input state".to_string());
        }
    }
    Ok(())
}

fn detach_host_input(hwnd: HWND) -> Option<DetachedHostInput> {
    let pointer = unsafe { GetWindowLongPtrW(hwnd, GWLP_USERDATA) } as *const HostInputState;
    if pointer.is_null() {
        return None;
    }

    let detached = unsafe {
        SetLastError(WIN32_ERROR(0));
        let previous = SetWindowLongPtrW(hwnd, GWLP_USERDATA, 0);
        let detached = previous != 0 || GetLastError() == WIN32_ERROR(0);
        if !detached {
            eprintln!("failed to detach input state from the composition host");
        }
        detached
    };
    Some(DetachedHostInput { pointer, detached })
}

fn native_mouse_event_kind(message: u32) -> Option<COREWEBVIEW2_MOUSE_EVENT_KIND> {
    match message {
        WM_LBUTTONDOWN | WM_LBUTTONUP | WM_LBUTTONDBLCLK | WM_RBUTTONDOWN | WM_RBUTTONUP
        | WM_RBUTTONDBLCLK | WM_MBUTTONDOWN | WM_MBUTTONUP | WM_MBUTTONDBLCLK | WM_XBUTTONDOWN
        | WM_XBUTTONUP | WM_XBUTTONDBLCLK | WM_MOUSEWHEEL | WM_MOUSEHWHEEL => {
            Some(COREWEBVIEW2_MOUSE_EVENT_KIND(message as i32))
        }
        _ => None,
    }
}

fn native_mouse_point(hwnd: HWND, message: u32, lparam: LPARAM) -> Option<POINT> {
    let mut point = client_point(lparam);
    if matches!(message, WM_MOUSEWHEEL | WM_MOUSEHWHEEL) {
        let target = unsafe { WindowFromPoint(point) };
        if target != hwnd && unsafe { GetCapture() } != hwnd {
            return None;
        }
        if !unsafe { ScreenToClient(hwnd, &mut point) }.as_bool() {
            return None;
        }
    }
    Some(point)
}

fn client_point(lparam: LPARAM) -> POINT {
    POINT {
        x: i32::from(low_word(lparam.0 as usize) as i16),
        y: i32::from(high_word(lparam.0 as usize) as i16),
    }
}

fn native_mouse_data(message: u32, wparam: WPARAM) -> u32 {
    match message {
        WM_MOUSEWHEEL | WM_MOUSEHWHEEL => i32::from(high_word(wparam.0) as i16) as u32,
        WM_XBUTTONDOWN | WM_XBUTTONUP | WM_XBUTTONDBLCLK => u32::from(high_word(wparam.0)),
        _ => 0,
    }
}

fn key_state(wparam: WPARAM) -> u16 {
    low_word(wparam.0) & WEBVIEW2_MOUSE_KEY_MASK
}

fn virtual_keys_from_native(keys: u16) -> COREWEBVIEW2_MOUSE_EVENT_VIRTUAL_KEYS {
    COREWEBVIEW2_MOUSE_EVENT_VIRTUAL_KEYS(i32::from(keys & WEBVIEW2_MOUSE_KEY_MASK))
}

fn low_word(value: usize) -> u16 {
    value as u16
}

fn high_word(value: usize) -> u16 {
    (value >> 16) as u16
}

fn is_button_down(message: u32) -> bool {
    matches!(
        message,
        WM_LBUTTONDOWN
            | WM_LBUTTONDBLCLK
            | WM_RBUTTONDOWN
            | WM_RBUTTONDBLCLK
            | WM_MBUTTONDOWN
            | WM_MBUTTONDBLCLK
            | WM_XBUTTONDOWN
            | WM_XBUTTONDBLCLK
    )
}

fn is_button_up(message: u32) -> bool {
    matches!(
        message,
        WM_LBUTTONUP | WM_RBUTTONUP | WM_MBUTTONUP | WM_XBUTTONUP
    )
}

fn is_x_button_message(message: u32) -> bool {
    matches!(message, WM_XBUTTONDOWN | WM_XBUTTONUP | WM_XBUTTONDBLCLK)
}

fn point_is_in_client(hwnd: HWND, point: POINT) -> bool {
    let mut bounds = RECT::default();
    unsafe { GetClientRect(hwnd, &mut bounds) }.is_ok()
        && point.x >= bounds.left
        && point.x < bounds.right
        && point.y >= bounds.top
        && point.y < bounds.bottom
}

fn ensure_leave_tracking(hwnd: HWND, state: &HostInputState, point: POINT) {
    if state.tracking_leave.get() || !point_is_in_client(hwnd, point) {
        return;
    }
    let mut tracking = TRACKMOUSEEVENT {
        cbSize: size_of::<TRACKMOUSEEVENT>() as u32,
        dwFlags: TME_LEAVE,
        hwndTrack: hwnd,
        dwHoverTime: 0,
    };
    if unsafe { TrackMouseEvent(&mut tracking) }.is_ok() {
        state.tracking_leave.set(true);
    }
}

fn cancel_leave_tracking(hwnd: HWND, state: &HostInputState) {
    if !state.tracking_leave.replace(false) {
        return;
    }
    let mut tracking = TRACKMOUSEEVENT {
        cbSize: size_of::<TRACKMOUSEEVENT>() as u32,
        dwFlags: TME_LEAVE | TME_CANCEL,
        hwndTrack: hwnd,
        dwHoverTime: 0,
    };
    let _ = unsafe { TrackMouseEvent(&mut tracking) };
}

fn forward_mouse_input(
    state: &HostInputState,
    event_kind: COREWEBVIEW2_MOUSE_EVENT_KIND,
    virtual_keys: COREWEBVIEW2_MOUSE_EVENT_VIRTUAL_KEYS,
    mouse_data: u32,
    point: POINT,
    focus_browser: bool,
) -> bool {
    if !state.enabled.get() {
        return false;
    }

    unsafe {
        if focus_browser {
            if let Err(error) = state
                .controller
                .MoveFocus(COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC)
            {
                state.report_input_error("failed to focus the composed WebView2", error);
                return false;
            }
        }
        match state.composition_controller.SendMouseInput(
            event_kind,
            virtual_keys,
            mouse_data,
            point,
        ) {
            Ok(()) => {
                state.logged_input_error.set(false);
                true
            }
            Err(error) => {
                state.report_input_error("failed to forward native input to WebView2", error);
                false
            }
        }
    }
}

fn release_stuck_buttons(hwnd: HWND, state: &HostInputState) {
    let pressed = state.pressed_keys.replace(0);
    if pressed == 0 {
        return;
    }
    cancel_leave_tracking(hwnd, state);

    let mut remaining = pressed;
    let modifiers = state.last_keys.get() & WEBVIEW2_MOUSE_MODIFIER_MASK;
    let point = state.last_point.get();
    for (button, event_kind, mouse_data) in [
        (1, COREWEBVIEW2_MOUSE_EVENT_KIND_LEFT_BUTTON_UP, 0),
        (2, COREWEBVIEW2_MOUSE_EVENT_KIND_RIGHT_BUTTON_UP, 0),
        (16, COREWEBVIEW2_MOUSE_EVENT_KIND_MIDDLE_BUTTON_UP, 0),
        (32, COREWEBVIEW2_MOUSE_EVENT_KIND_X_BUTTON_UP, 1),
        (64, COREWEBVIEW2_MOUSE_EVENT_KIND_X_BUTTON_UP, 2),
    ] {
        if pressed & button == 0 {
            continue;
        }
        remaining &= !button;
        let _ = forward_mouse_input(
            state,
            event_kind,
            virtual_keys_from_native(modifiers | remaining),
            mouse_data,
            point,
            false,
        );
    }
    let _ = forward_mouse_input(
        state,
        COREWEBVIEW2_MOUSE_EVENT_KIND_LEAVE,
        COREWEBVIEW2_MOUSE_EVENT_VIRTUAL_KEYS_NONE,
        0,
        POINT { x: 0, y: 0 },
        false,
    );
}

fn set_host_cursor(state: &HostInputState) -> bool {
    let mut cursor = HCURSOR::default();
    if unsafe { state.composition_controller.Cursor(&mut cursor) }.is_err() || cursor.0.is_null() {
        return false;
    }
    unsafe {
        SetCursor(Some(cursor));
    }
    true
}

fn create_composition_host(
    parent_hwnd: HWND,
    initial_bounds: PhysicalBounds,
) -> Result<HWND, String> {
    let module = unsafe { GetModuleHandleW(None) }
        .map_err(|error| windows_error("failed to read the desktop module handle", error))?;
    let instance = HINSTANCE(module.0);
    let cursor = unsafe { LoadCursorW(None, IDC_ARROW) }.unwrap_or_default();
    let window_class = WNDCLASSW {
        style: CS_DBLCLKS,
        lpfnWndProc: Some(composition_host_window_proc),
        hInstance: instance,
        hCursor: cursor,
        lpszClassName: w!("ArdorSidebarCompositionHost"),
        ..Default::default()
    };

    if unsafe { RegisterClassW(&window_class) } == 0 {
        let error_code = unsafe { GetLastError() };
        if error_code != ERROR_CLASS_ALREADY_EXISTS {
            return Err(windows_error(
                "failed to register the composition host window class",
                windows::core::Error::from_win32(),
            ));
        }
    }
    unsafe {
        CreateWindowExW(
            WS_EX_NOACTIVATE,
            w!("ArdorSidebarCompositionHost"),
            w!(""),
            WS_CHILD | WS_CLIPCHILDREN | WS_CLIPSIBLINGS,
            initial_bounds.x,
            initial_bounds.y,
            initial_bounds.width,
            initial_bounds.height,
            Some(parent_hwnd),
            None,
            Some(instance),
            None,
        )
        .map_err(|error| windows_error("failed to create the composition host window", error))
    }
}

fn apply_host_region(
    host_hwnd: HWND,
    browser: PhysicalBounds,
    overlays: &[BrowserOverlay],
    scale_factor: f64,
) -> Result<(), String> {
    let mut visible_region = OwnedRegion::new(
        unsafe { CreateRectRgn(0, 0, browser.width, browser.height) },
        "failed to create the composition host region",
    )?;

    for overlay in overlays {
        let overlay_bounds = PhysicalBounds::from_logical(overlay.bounds, scale_factor)?;
        let left = (overlay_bounds.x - browser.x).clamp(0, browser.width);
        let top = (overlay_bounds.y - browser.y).clamp(0, browser.height);
        let right = (overlay_bounds.x + overlay_bounds.width - browser.x).clamp(0, browser.width);
        let bottom =
            (overlay_bounds.y + overlay_bounds.height - browser.y).clamp(0, browser.height);
        if left >= right || top >= bottom {
            continue;
        }

        let cutout = if overlay.corner_radius > 0.0 {
            let diameter = scaled_i32(
                overlay.corner_radius * 2.0,
                scale_factor,
                "sidebar browser overlay corner diameter",
            )?
            .max(1)
            .min(right - left)
            .min(bottom - top);
            OwnedRegion::new(
                unsafe { CreateRoundRectRgn(left, top, right, bottom, diameter, diameter) },
                "failed to create a rounded sidebar browser overlay region",
            )?
        } else {
            OwnedRegion::new(
                unsafe { CreateRectRgn(left, top, right, bottom) },
                "failed to create a sidebar browser overlay region",
            )?
        };

        let region_type = unsafe {
            CombineRgn(
                Some(visible_region.handle()),
                Some(visible_region.handle()),
                Some(cutout.handle()),
                RGN_DIFF,
            )
        };
        if region_type.0 == ERROR {
            return Err(windows_error(
                "failed to subtract a Radix overlay from the composition host",
                windows::core::Error::from_win32(),
            ));
        }
    }

    if unsafe { SetWindowRgn(host_hwnd, Some(visible_region.handle()), true) } == 0 {
        return Err(windows_error(
            "failed to apply the composition host region",
            windows::core::Error::from_win32(),
        ));
    }
    visible_region.release_to_system();
    Ok(())
}

#[derive(Clone, Copy)]
struct PhysicalBounds {
    x: i32,
    y: i32,
    width: i32,
    height: i32,
}

impl PhysicalBounds {
    fn from_logical(bounds: BrowserBounds, scale_factor: f64) -> Result<Self, String> {
        if !scale_factor.is_finite() || scale_factor <= 0.0 {
            return Err("sidebar browser scale factor must be positive and finite".to_string());
        }
        let left = scaled_i32(bounds.x, scale_factor, "sidebar browser physical left")?;
        let top = scaled_i32(bounds.y, scale_factor, "sidebar browser physical top")?;
        let right = scaled_i32(
            bounds.x + bounds.width,
            scale_factor,
            "sidebar browser physical right",
        )?;
        let bottom = scaled_i32(
            bounds.y + bounds.height,
            scale_factor,
            "sidebar browser physical bottom",
        )?;
        Ok(Self {
            x: left,
            y: top,
            width: right - left,
            height: bottom - top,
        })
    }
}

pub(super) async fn open(
    caller: &Webview,
    generation: u64,
    parent_hwnd: isize,
    bounds: BrowserBounds,
    overlays: Vec<BrowserOverlay>,
    scale_factor: f64,
    url: String,
) -> Result<(), String> {
    with_platform_webview(caller, move |platform| {
        let browser = CompositionBrowser::create(
            platform,
            generation,
            parent_hwnd,
            bounds,
            overlays,
            scale_factor,
            url,
        )?;
        ACTIVE_BROWSER.with(|active| {
            active.replace(Some(browser));
        });
        Ok(())
    })
    .await
}

pub(super) async fn layout(
    caller: &Webview,
    generation: u64,
    bounds: BrowserBounds,
    visible: bool,
    overlays: Vec<BrowserOverlay>,
    scale_factor: f64,
) -> Result<bool, String> {
    with_platform_webview(caller, move |_| {
        ACTIVE_BROWSER.with(|active| {
            let mut active = active.borrow_mut();
            let Some(browser) = active.as_mut() else {
                return Ok(false);
            };
            if browser.generation != generation {
                return Ok(false);
            }
            browser.apply_layout(bounds, visible, &overlays, scale_factor)?;
            Ok(true)
        })
    })
    .await
}

pub(super) async fn control(
    caller: &Webview,
    generation: u64,
    action: SidebarBrowserAction,
) -> Result<bool, String> {
    with_platform_webview(caller, move |_| {
        ACTIVE_BROWSER.with(|active| {
            let active = active.borrow();
            let Some(browser) = active.as_ref() else {
                return Ok(false);
            };
            if browser.generation != generation {
                return Ok(false);
            }
            browser.control(action)?;
            Ok(true)
        })
    })
    .await
}

pub(super) async fn input(
    caller: &Webview,
    generation: u64,
    input: SidebarBrowserInput,
) -> Result<SidebarBrowserInputResponse, String> {
    with_platform_webview(caller, move |_| {
        ACTIVE_BROWSER.with(|active| {
            let active = active.borrow();
            let Some(browser) = active.as_ref() else {
                return Ok(SidebarBrowserInputResponse::ignored());
            };
            if browser.generation != generation {
                return Ok(SidebarBrowserInputResponse::ignored());
            }
            browser.send_input(input)
        })
    })
    .await
}

pub(super) async fn close(caller: &Webview, generation: u64) -> Result<bool, String> {
    with_platform_webview(caller, move |_| {
        ACTIVE_BROWSER.with(|active| {
            let mut active = active.borrow_mut();
            if active
                .as_ref()
                .is_some_and(|browser| browser.generation == generation)
            {
                active.take();
                Ok(true)
            } else {
                Ok(false)
            }
        })
    })
    .await
}

pub(super) fn notify_parent_window_position_changed() {
    ACTIVE_BROWSER.with(|active| {
        if let Some(browser) = active.borrow().as_ref() {
            let _ = unsafe { browser.controller.NotifyParentWindowPositionChanged() };
        }
    });
}

fn create_composition_controller(
    environment: &ICoreWebView2Environment,
    parent_hwnd: HWND,
) -> Result<ICoreWebView2CompositionController, String> {
    let environment10: ICoreWebView2Environment10 = environment.cast().map_err(|error| {
        windows_error(
            "the installed WebView2 runtime does not support private composition controllers",
            error,
        )
    })?;
    let options = unsafe {
        environment10
            .CreateCoreWebView2ControllerOptions()
            .map_err(|error| windows_error("failed to create WebView2 controller options", error))?
    };
    unsafe {
        options
            .SetIsInPrivateModeEnabled(true)
            .map_err(|error| windows_error("failed to enable private WebView2 mode", error))?;
    }

    let (sender, receiver) = mpsc::channel();
    let handler = CreateCoreWebView2CompositionControllerCompletedHandler::create(Box::new(
        move |error_code, controller| {
            let result = (|| {
                error_code?;
                controller.ok_or_else(|| windows::core::Error::from(E_POINTER))
            })();
            sender
                .send(result)
                .map_err(|_| windows::core::Error::from(E_UNEXPECTED))
        },
    ));

    unsafe {
        environment10
            .CreateCoreWebView2CompositionControllerWithOptions(parent_hwnd, &options, &handler)
            .map_err(|error| {
                windows_error(
                    "failed to start WebView2 composition controller creation",
                    error,
                )
            })?;
    }
    webview2_com::wait_with_pump(receiver)
        .map_err(|error| {
            format!("failed while waiting for the WebView2 composition controller: {error}")
        })?
        .map_err(|error| {
            windows_error(
                "failed to create the WebView2 composition controller",
                error,
            )
        })
}

fn install_cursor_handler(
    host_hwnd: HWND,
    composition_controller: &ICoreWebView2CompositionController,
    tokens: &mut EventTokens,
) -> Result<(), String> {
    let host_handle = host_hwnd.0 as isize;
    let handler = CursorChangedEventHandler::create(Box::new(move |sender, _| {
        let Some(sender) = sender else {
            return Ok(());
        };
        unsafe {
            let hwnd = HWND(host_handle as *mut c_void);
            if let Some(state) = clone_host_input_state(hwnd).filter(|state| state.enabled.get()) {
                if state.tracking_leave.get() {
                    let mut cursor = HCURSOR::default();
                    sender.Cursor(&mut cursor)?;
                    if !cursor.0.is_null() {
                        SetCursor(Some(cursor));
                    }
                }
            }
        }
        Ok(())
    }));

    let mut token = 0;
    unsafe {
        composition_controller
            .add_CursorChanged(&handler, &mut token)
            .map_err(|error| windows_error("failed to subscribe to the WebView2 cursor", error))?;
    }
    tokens.cursor_changed = Some(token);
    Ok(())
}

fn install_security_handlers(
    webview: &ICoreWebView2,
    webview4: &ICoreWebView2_4,
    tokens: &mut EventTokens,
) -> Result<(), String> {
    unsafe {
        let navigation = NavigationStartingEventHandler::create(Box::new(|_, args| {
            let Some(args) = args else {
                return Ok(());
            };
            let mut uri = PWSTR::null();
            args.Uri(&mut uri)?;
            let uri = take_pwstr(uri);
            let parsed = tauri::Url::parse(&uri);
            let allowed = parsed.as_ref().is_ok_and(is_allowed_sidebar_navigation);
            args.SetCancel(!allowed)?;
            if !allowed {
                if let Ok(parsed) = parsed {
                    eprintln!(
                        "Blocked composed sidebar browser navigation to {}",
                        describe_navigation(&parsed)
                    );
                } else {
                    eprintln!("Blocked composed sidebar browser navigation to an invalid URL");
                }
            }
            Ok(())
        }));
        let mut token = 0;
        webview
            .add_NavigationStarting(&navigation, &mut token)
            .map_err(|error| {
                windows_error("failed to install the WebView2 navigation guard", error)
            })?;
        tokens.navigation_starting = Some(token);

        let new_window = NewWindowRequestedEventHandler::create(Box::new(|_, args| {
            if let Some(args) = args {
                args.SetHandled(true)?;
            }
            Ok(())
        }));
        let mut token = 0;
        webview
            .add_NewWindowRequested(&new_window, &mut token)
            .map_err(|error| windows_error("failed to block WebView2 popup windows", error))?;
        tokens.new_window_requested = Some(token);

        let permission = PermissionRequestedEventHandler::create(Box::new(|_, args| {
            if let Some(args) = args {
                args.SetState(COREWEBVIEW2_PERMISSION_STATE_DENY)?;
            }
            Ok(())
        }));
        let mut token = 0;
        webview
            .add_PermissionRequested(&permission, &mut token)
            .map_err(|error| windows_error("failed to deny WebView2 device permissions", error))?;
        tokens.permission_requested = Some(token);

        let download = DownloadStartingEventHandler::create(Box::new(|_, args| {
            if let Some(args) = args {
                args.SetCancel(true)?;
                args.SetHandled(true)?;
            }
            Ok(())
        }));
        let mut token = 0;
        webview4
            .add_DownloadStarting(&download, &mut token)
            .map_err(|error| windows_error("failed to block WebView2 downloads", error))?;
        tokens.download_starting = Some(token);
    }
    Ok(())
}

fn install_focus_handler(
    main_controller: &ICoreWebView2Controller,
    main_webview: &ICoreWebView2,
    controller: &ICoreWebView2Controller,
    tokens: &mut EventTokens,
) -> Result<(), String> {
    let main_controller = main_controller.clone();
    let main_webview = main_webview.clone();
    let handler = MoveFocusRequestedEventHandler::create(Box::new(move |_, args| {
        let Some(args) = args else {
            return Ok(());
        };
        let mut reason = COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC;
        unsafe {
            args.Reason(&mut reason)?;
            let script = match reason {
                COREWEBVIEW2_MOVE_FOCUS_REASON_NEXT => MOVE_FOCUS_NEXT_SCRIPT,
                COREWEBVIEW2_MOVE_FOCUS_REASON_PREVIOUS => MOVE_FOCUS_PREVIOUS_SCRIPT,
                _ => return Ok(()),
            };
            let main_controller = main_controller.clone();
            let completed =
                ExecuteScriptCompletedHandler::create(Box::new(move |error_code, _| {
                    error_code?;
                    main_controller.MoveFocus(COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC)
                }));
            main_webview.ExecuteScript(&HSTRING::from(script), &completed)?;
            args.SetHandled(true)?;
        }
        Ok(())
    }));
    let mut token = 0;
    unsafe {
        controller
            .add_MoveFocusRequested(&handler, &mut token)
            .map_err(|error| {
                windows_error("failed to connect composed WebView2 focus traversal", error)
            })?;
    }
    tokens.move_focus_requested = Some(token);
    Ok(())
}

fn add_initialization_script(webview: &ICoreWebView2) -> Result<(), String> {
    let webview = webview.clone();
    AddScriptToExecuteOnDocumentCreatedCompletedHandler::wait_for_async_operation(
        Box::new(move |handler| unsafe {
            let script = HSTRING::from(DEVICE_PERMISSION_DEFENSE_IN_DEPTH);
            webview
                .AddScriptToExecuteOnDocumentCreated(&script, &handler)
                .map_err(Into::into)
        }),
        Box::new(|error_code, _| error_code),
    )
    .map_err(|error| format!("failed to install the WebView2 initialization script: {error}"))
}

fn current_url(webview: &ICoreWebView2) -> Result<String, String> {
    let mut source = PWSTR::null();
    unsafe {
        webview
            .Source(&mut source)
            .map_err(|error| windows_error("failed to read the composed WebView2 URL", error))?;
    }
    Ok(take_pwstr(source))
}

fn scaled_i32(value: f64, scale_factor: f64, label: &str) -> Result<i32, String> {
    let scaled = value * scale_factor;
    if !scaled.is_finite() || scaled < i32::MIN as f64 || scaled > i32::MAX as f64 {
        return Err(format!("{label} is outside the supported range"));
    }
    Ok(scaled.round() as i32)
}

async fn with_platform_webview<T, F>(caller: &Webview, operation: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce(tauri::webview::PlatformWebview) -> Result<T, String> + Send + 'static,
{
    let (sender, mut receiver) = tauri::async_runtime::channel(1);
    caller
        .with_webview(move |platform| {
            let _ = sender.try_send(operation(platform));
        })
        .map_err(|error| format!("failed to dispatch a WebView2 operation: {error}"))?;
    receiver
        .recv()
        .await
        .ok_or_else(|| "the WebView2 operation ended without a result".to_string())?
}

fn windows_error(context: &str, error: windows::core::Error) -> String {
    format!("{context}: {error}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn packed_lparam(x: i16, y: i16) -> LPARAM {
        LPARAM((((y as u16 as u32) << 16) | u32::from(x as u16)) as isize)
    }

    fn packed_wparam(low: u16, high: u16) -> WPARAM {
        WPARAM(((usize::from(high)) << 16) | usize::from(low))
    }

    #[test]
    fn native_event_kinds_preserve_the_win32_message_values() {
        for message in [
            WM_LBUTTONDOWN,
            WM_LBUTTONUP,
            WM_LBUTTONDBLCLK,
            WM_RBUTTONDOWN,
            WM_RBUTTONUP,
            WM_RBUTTONDBLCLK,
            WM_MBUTTONDOWN,
            WM_MBUTTONUP,
            WM_MBUTTONDBLCLK,
            WM_XBUTTONDOWN,
            WM_XBUTTONUP,
            WM_XBUTTONDBLCLK,
            WM_MOUSEWHEEL,
            WM_MOUSEHWHEEL,
        ] {
            assert_eq!(
                native_mouse_event_kind(message),
                Some(COREWEBVIEW2_MOUSE_EVENT_KIND(message as i32))
            );
        }
        assert_eq!(native_mouse_event_kind(WM_MOUSEMOVE), None);
        assert_eq!(native_mouse_event_kind(WM_MOUSELEAVE_MESSAGE), None);
    }

    #[test]
    fn native_client_coordinates_remain_signed_physical_pixels() {
        assert_eq!(
            client_point(packed_lparam(-123, 456)),
            POINT { x: -123, y: 456 }
        );
        assert_eq!(
            client_point(packed_lparam(i16::MIN, i16::MAX)),
            POINT {
                x: i32::from(i16::MIN),
                y: i32::from(i16::MAX),
            }
        );
    }

    #[test]
    fn native_key_state_maps_directly_to_webview2_flags() {
        let all_keys = WEBVIEW2_MOUSE_KEY_MASK;
        assert_eq!(key_state(packed_wparam(all_keys, 0)), all_keys);
        assert_eq!(
            virtual_keys_from_native(all_keys),
            COREWEBVIEW2_MOUSE_EVENT_VIRTUAL_KEYS(i32::from(all_keys))
        );
        assert_eq!(key_state(packed_wparam(u16::MAX, 0)), all_keys);
    }

    #[test]
    fn wheel_and_xbutton_data_preserve_the_native_payload() {
        assert_eq!(
            native_mouse_data(WM_MOUSEWHEEL, packed_wparam(0, (-120_i16) as u16)),
            (-120_i32) as u32
        );
        assert_eq!(
            native_mouse_data(WM_MOUSEHWHEEL, packed_wparam(0, 120)),
            120
        );
        assert_eq!(native_mouse_data(WM_XBUTTONDOWN, packed_wparam(0, 1)), 1);
        assert_eq!(native_mouse_data(WM_XBUTTONUP, packed_wparam(0, 2)), 2);
        assert_eq!(native_mouse_data(WM_LBUTTONDOWN, packed_wparam(0, 7)), 0);
    }

    #[test]
    fn capture_boundaries_cover_every_mouse_button() {
        for message in [
            WM_LBUTTONDOWN,
            WM_LBUTTONDBLCLK,
            WM_RBUTTONDOWN,
            WM_RBUTTONDBLCLK,
            WM_MBUTTONDOWN,
            WM_MBUTTONDBLCLK,
            WM_XBUTTONDOWN,
            WM_XBUTTONDBLCLK,
        ] {
            assert!(is_button_down(message));
        }
        for message in [WM_LBUTTONUP, WM_RBUTTONUP, WM_MBUTTONUP, WM_XBUTTONUP] {
            assert!(is_button_up(message));
        }
        assert!(!is_button_down(WM_MOUSEMOVE));
        assert!(!is_button_up(WM_MOUSEWHEEL));
    }
}
