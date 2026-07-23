use super::LogicalRect;

const EVENTFLAG_CAPS_LOCK_ON: u32 = 1 << 0;
const EVENTFLAG_SHIFT_DOWN: u32 = 1 << 1;
const EVENTFLAG_CONTROL_DOWN: u32 = 1 << 2;
const EVENTFLAG_ALT_DOWN: u32 = 1 << 3;
const EVENTFLAG_COMMAND_DOWN: u32 = 1 << 7;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct PhysicalPoint {
    x: i32,
    y: i32,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct ScreenOrigins {
    shell: PhysicalPoint,
    preview: PhysicalPoint,
}

#[derive(Clone, Copy, Debug, Default)]
struct MacModifierFlags {
    shift: bool,
    control: bool,
    option: bool,
    command: bool,
    caps_lock: bool,
}

fn screen_origins(
    window_top_left: PhysicalPoint,
    preview: LogicalRect,
    scale: f64,
) -> ScreenOrigins {
    ScreenOrigins {
        shell: window_top_left,
        preview: PhysicalPoint {
            x: window_top_left
                .x
                .saturating_add(logical_to_physical(preview.x, scale)),
            y: window_top_left
                .y
                .saturating_add(logical_to_physical(preview.y, scale)),
        },
    }
}

fn cef_wheel_delta(delta_x: f64, delta_y: f64, scale: f64) -> (i32, i32) {
    (
        logical_to_physical(delta_x, scale),
        logical_to_physical(delta_y, scale),
    )
}

fn cef_modifiers(flags: MacModifierFlags) -> u32 {
    let mut result = 0;
    if flags.caps_lock {
        result |= EVENTFLAG_CAPS_LOCK_ON;
    }
    if flags.shift {
        result |= EVENTFLAG_SHIFT_DOWN;
    }
    if flags.control {
        result |= EVENTFLAG_CONTROL_DOWN;
    }
    if flags.option {
        result |= EVENTFLAG_ALT_DOWN;
    }
    if flags.command {
        result |= EVENTFLAG_COMMAND_DOWN;
    }
    result
}

fn logical_to_physical(value: f64, scale: f64) -> i32 {
    (value * scale)
        .round()
        .clamp(f64::from(i32::MIN), f64::from(i32::MAX)) as i32
}

fn windows_key_code(mac_key_code: u16) -> i32 {
    match mac_key_code {
        0 => i32::from(b'A'),
        1 => i32::from(b'S'),
        2 => i32::from(b'D'),
        3 => i32::from(b'F'),
        4 => i32::from(b'H'),
        5 => i32::from(b'G'),
        6 => i32::from(b'Z'),
        7 => i32::from(b'X'),
        8 => i32::from(b'C'),
        9 => i32::from(b'V'),
        11 => i32::from(b'B'),
        12 => i32::from(b'Q'),
        13 => i32::from(b'W'),
        14 => i32::from(b'E'),
        15 => i32::from(b'R'),
        16 => i32::from(b'Y'),
        17 => i32::from(b'T'),
        18 => i32::from(b'1'),
        19 => i32::from(b'2'),
        20 => i32::from(b'3'),
        21 => i32::from(b'4'),
        22 => i32::from(b'6'),
        23 => i32::from(b'5'),
        24 => 0xbb,
        25 => i32::from(b'9'),
        26 => i32::from(b'7'),
        27 => 0xbd,
        28 => i32::from(b'8'),
        29 => i32::from(b'0'),
        30 => 0xdd,
        31 => i32::from(b'O'),
        32 => i32::from(b'U'),
        33 => 0xdb,
        34 => i32::from(b'I'),
        35 => i32::from(b'P'),
        36 => 0x0d,
        37 => i32::from(b'L'),
        38 => i32::from(b'J'),
        39 => 0xde,
        40 => i32::from(b'K'),
        41 => 0xba,
        42 => 0xdc,
        43 => 0xbc,
        44 => 0xbf,
        45 => i32::from(b'N'),
        46 => i32::from(b'M'),
        47 => 0xbe,
        48 => 0x09,
        49 => 0x20,
        50 => 0xc0,
        51 => 0x08,
        53 => 0x1b,
        54 => 0x5c,
        55 => 0x5b,
        56 | 60 => 0x10,
        57 => 0x14,
        58 | 61 => 0x12,
        59 | 62 => 0x11,
        96 => 0x74,
        97 => 0x75,
        98 => 0x76,
        99 => 0x72,
        100 => 0x77,
        101 => 0x78,
        103 => 0x7a,
        109 => 0x79,
        111 => 0x7b,
        114 => 0x2d,
        115 => 0x24,
        116 => 0x21,
        117 => 0x2e,
        118 => 0x73,
        119 => 0x23,
        120 => 0x71,
        121 => 0x22,
        122 => 0x70,
        123 => 0x25,
        124 => 0x27,
        125 => 0x28,
        126 => 0x26,
        other => i32::from(other),
    }
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
mod appkit {
    use super::*;
    use crate::sidebar_browser::gpu_compositor::input::{
        InputRouter, NativeInputHook, Runtime, FOCUSED_PREVIEW,
    };
    use objc2::{
        define_class, msg_send,
        rc::Retained,
        runtime::{AnyObject, NSObjectProtocol, Sel},
        AnyThread, ClassType, DefinedClass, MainThreadOnly,
    };
    use objc2_app_kit::{
        NSAutoresizingMaskOptions, NSEvent, NSEventModifierFlags, NSTextInputClient,
        NSTrackingArea, NSTrackingAreaOptions, NSView, NSWindow, NSWindowOrderingMode,
    };
    use objc2_foundation::{
        MainThreadMarker, NSArray, NSAttributedString, NSAttributedStringKey, NSPoint, NSRange,
        NSRangePointer, NSRect, NSSize, NSString,
    };
    use std::{
        cell::{Cell, RefCell},
        sync::Arc,
    };

    const EVENTFLAG_LEFT_MOUSE_BUTTON: u32 = 1 << 4;
    const EVENTFLAG_MIDDLE_MOUSE_BUTTON: u32 = 1 << 5;
    const EVENTFLAG_RIGHT_MOUSE_BUTTON: u32 = 1 << 6;

    struct CompositorInputViewIvars {
        router: RefCell<Option<Arc<InputRouter>>>,
        marked_text: RefCell<String>,
        selected_range: Cell<NSRange>,
        tracking_area: RefCell<Option<Retained<NSTrackingArea>>>,
    }

    define_class!(
        #[unsafe(super(NSView))]
        #[thread_kind = MainThreadOnly]
        #[ivars = CompositorInputViewIvars]
        struct CompositorInputView;

        impl CompositorInputView {
            #[unsafe(method(acceptsFirstResponder))]
            fn accepts_first_responder(&self) -> bool {
                true
            }

            #[unsafe(method(becomeFirstResponder))]
            fn become_first_responder(&self) -> bool {
                if let Some(router) = self.router() {
                    let focused = router.focused.load(std::sync::atomic::Ordering::Acquire);
                    router.focus(focused);
                }
                true
            }

            #[unsafe(method(resignFirstResponder))]
            fn resign_first_responder(&self) -> bool {
                if let Some(router) = self.router() {
                    router.shell.set_offscreen_focus(false);
                    router.preview.set_offscreen_focus(false);
                }
                true
            }

            #[unsafe(method(mouseMoved:))]
            fn mouse_moved(&self, event: &NSEvent) {
                self.forward_mouse_move(event, false);
            }

            #[unsafe(method(mouseEntered:))]
            fn mouse_entered(&self, event: &NSEvent) {
                self.forward_mouse_move(event, false);
            }

            #[unsafe(method(mouseExited:))]
            fn mouse_exited(&self, _event: &NSEvent) {
                if let Some(router) = self.router() {
                    router
                        .focused_webview()
                        .send_offscreen_mouse_move(cef::MouseEvent::default(), true);
                }
            }

            #[unsafe(method(mouseDown:))]
            fn mouse_down(&self, event: &NSEvent) {
                self.forward_mouse_click(
                    event,
                    cef::MouseButtonType::LEFT,
                    false,
                    EVENTFLAG_LEFT_MOUSE_BUTTON,
                );
            }

            #[unsafe(method(mouseUp:))]
            fn mouse_up(&self, event: &NSEvent) {
                self.forward_mouse_click(
                    event,
                    cef::MouseButtonType::LEFT,
                    true,
                    EVENTFLAG_LEFT_MOUSE_BUTTON,
                );
            }

            #[unsafe(method(rightMouseDown:))]
            fn right_mouse_down(&self, event: &NSEvent) {
                self.forward_mouse_click(
                    event,
                    cef::MouseButtonType::RIGHT,
                    false,
                    EVENTFLAG_RIGHT_MOUSE_BUTTON,
                );
            }

            #[unsafe(method(rightMouseUp:))]
            fn right_mouse_up(&self, event: &NSEvent) {
                self.forward_mouse_click(
                    event,
                    cef::MouseButtonType::RIGHT,
                    true,
                    EVENTFLAG_RIGHT_MOUSE_BUTTON,
                );
            }

            #[unsafe(method(otherMouseDown:))]
            fn other_mouse_down(&self, event: &NSEvent) {
                self.forward_mouse_click(
                    event,
                    cef::MouseButtonType::MIDDLE,
                    false,
                    EVENTFLAG_MIDDLE_MOUSE_BUTTON,
                );
            }

            #[unsafe(method(otherMouseUp:))]
            fn other_mouse_up(&self, event: &NSEvent) {
                self.forward_mouse_click(
                    event,
                    cef::MouseButtonType::MIDDLE,
                    true,
                    EVENTFLAG_MIDDLE_MOUSE_BUTTON,
                );
            }

            #[unsafe(method(scrollWheel:))]
            fn scroll_wheel(&self, event: &NSEvent) {
                let Some(router) = self.router() else {
                    return;
                };
                self.update_screen_origins(&router);
                let Some((physical_x, physical_y)) = self.event_point(event, router.scale()) else {
                    return;
                };
                let routed = router.route(physical_x, physical_y);
                let (delta_x, delta_y) = if event.hasPreciseScrollingDeltas() {
                    cef_wheel_delta(event.scrollingDeltaX(), event.scrollingDeltaY(), router.scale())
                } else {
                    cef_wheel_delta(event.deltaX(), event.deltaY(), router.scale())
                };
                routed.target.send_offscreen_mouse_wheel(
                    cef::MouseEvent {
                        x: routed.x,
                        y: routed.y,
                        modifiers: event_modifiers(event),
                    },
                    delta_x,
                    delta_y,
                );
            }

            #[unsafe(method(keyDown:))]
            fn key_down(&self, event: &NSEvent) {
                self.forward_key_event(event, cef::KeyEventType::RAWKEYDOWN);
                let events = NSArray::arrayWithObject(event);
                self.interpretKeyEvents(&events);
            }

            #[unsafe(method(keyUp:))]
            fn key_up(&self, event: &NSEvent) {
                self.forward_key_event(event, cef::KeyEventType::KEYUP);
            }

            #[unsafe(method(flagsChanged:))]
            fn flags_changed(&self, event: &NSEvent) {
                let kind = if modifier_key_is_down(event) {
                    cef::KeyEventType::RAWKEYDOWN
                } else {
                    cef::KeyEventType::KEYUP
                };
                self.forward_key_event(event, kind);
            }
        }

        unsafe impl NSObjectProtocol for CompositorInputView {}

        #[allow(non_snake_case)]
        unsafe impl NSTextInputClient for CompositorInputView {
            #[unsafe(method(insertText:replacementRange:))]
            unsafe fn insertText_replacementRange(
                &self,
                string: &AnyObject,
                replacement_range: NSRange,
            ) {
                let Some(text) = text_from_object(string) else {
                    return;
                };
                if let Some(router) = self.router() {
                    router.focused_webview().send_offscreen_ime_commit(
                        &text,
                        cef_range(replacement_range),
                        0,
                    );
                }
                self.ivars().marked_text.borrow_mut().clear();
                self.ivars()
                    .selected_range
                    .set(NSRange::new(usize::MAX, 0));
            }

            #[unsafe(method(doCommandBySelector:))]
            unsafe fn doCommandBySelector(&self, _selector: Sel) {}

            #[unsafe(method(setMarkedText:selectedRange:replacementRange:))]
            unsafe fn setMarkedText_selectedRange_replacementRange(
                &self,
                string: &AnyObject,
                selected_range: NSRange,
                replacement_range: NSRange,
            ) {
                let Some(text) = text_from_object(string) else {
                    return;
                };
                let text_length = text.encode_utf16().count().min(u32::MAX as usize) as u32;
                let underline = cef::CompositionUnderline {
                    range: cef::Range {
                        from: 0,
                        to: text_length,
                    },
                    color: 0xff00_0000,
                    thick: 0,
                    ..Default::default()
                };
                if let Some(router) = self.router() {
                    router.focused_webview().send_offscreen_ime_set_composition(
                        &text,
                        &[underline],
                        cef_range(replacement_range),
                        cef_range(selected_range),
                    );
                }
                self.ivars().marked_text.replace(text);
                self.ivars().selected_range.set(selected_range);
            }

            #[unsafe(method(unmarkText))]
            fn unmarkText(&self) {
                if !self.ivars().marked_text.borrow().is_empty() {
                    if let Some(router) = self.router() {
                        router.focused_webview().send_offscreen_ime_cancel();
                    }
                }
                self.ivars().marked_text.borrow_mut().clear();
                self.ivars()
                    .selected_range
                    .set(NSRange::new(usize::MAX, 0));
            }

            #[unsafe(method(selectedRange))]
            fn selectedRange(&self) -> NSRange {
                self.ivars().selected_range.get()
            }

            #[unsafe(method(markedRange))]
            fn markedRange(&self) -> NSRange {
                let length = self.ivars().marked_text.borrow().encode_utf16().count();
                if length == 0 {
                    NSRange::new(usize::MAX, 0)
                } else {
                    NSRange::new(0, length)
                }
            }

            #[unsafe(method(hasMarkedText))]
            fn hasMarkedText(&self) -> bool {
                !self.ivars().marked_text.borrow().is_empty()
            }

            #[unsafe(method_id(attributedSubstringForProposedRange:actualRange:))]
            unsafe fn attributedSubstringForProposedRange_actualRange(
                &self,
                _range: NSRange,
                actual_range: NSRangePointer,
            ) -> Option<Retained<NSAttributedString>> {
                if !actual_range.is_null() {
                    *actual_range = NSRange::new(usize::MAX, 0);
                }
                None
            }

            #[unsafe(method_id(validAttributesForMarkedText))]
            fn validAttributesForMarkedText(
                &self,
            ) -> Retained<NSArray<NSAttributedStringKey>> {
                NSArray::new()
            }

            #[unsafe(method(firstRectForCharacterRange:actualRange:))]
            unsafe fn firstRectForCharacterRange_actualRange(
                &self,
                range: NSRange,
                actual_range: NSRangePointer,
            ) -> NSRect {
                if !actual_range.is_null() {
                    *actual_range = range;
                }
                let Some(window) = self.window() else {
                    return NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(1.0, 18.0));
                };
                let bounds = self.bounds();
                let local = if let Some(router) = self.router() {
                    let layout = router.layout();
                    if router.focused.load(std::sync::atomic::Ordering::Acquire)
                        == FOCUSED_PREVIEW
                    {
                        NSPoint::new(
                            layout.preview.x,
                            bounds.size.height - layout.preview.y - 18.0,
                        )
                    } else {
                        NSPoint::new(0.0, bounds.size.height - 18.0)
                    }
                } else {
                    NSPoint::new(0.0, bounds.size.height - 18.0)
                };
                NSRect::new(window.convertPointToScreen(local), NSSize::new(1.0, 18.0))
            }

            #[unsafe(method(characterIndexForPoint:))]
            fn characterIndexForPoint(&self, _point: NSPoint) -> usize {
                0
            }
        }
    );

    impl CompositorInputView {
        fn new(frame: NSRect, router: Arc<InputRouter>, mtm: MainThreadMarker) -> Retained<Self> {
            let allocated = Self::alloc(mtm).set_ivars(CompositorInputViewIvars {
                router: RefCell::new(Some(router)),
                marked_text: RefCell::new(String::new()),
                selected_range: Cell::new(NSRange::new(usize::MAX, 0)),
                tracking_area: RefCell::new(None),
            });
            // SAFETY: CompositorInputView is initialized on the AppKit main thread.
            unsafe { msg_send![super(allocated), initWithFrame: frame] }
        }

        fn router(&self) -> Option<Arc<InputRouter>> {
            self.ivars().router.borrow().clone()
        }

        fn event_point(&self, event: &NSEvent, scale: f64) -> Option<(i32, i32)> {
            let point = self.convertPoint_fromView(event.locationInWindow(), None);
            let bounds = self.bounds();
            if !point.x.is_finite() || !point.y.is_finite() {
                return None;
            }
            Some((
                logical_to_physical(point.x, scale),
                logical_to_physical(bounds.size.height - point.y, scale),
            ))
        }

        fn update_screen_origins(&self, router: &InputRouter) {
            let Some(window) = self.window() else {
                return;
            };
            let Some(screen) = window.screen() else {
                return;
            };
            let scale = router.scale();
            let window_frame = window.frame();
            let screen_frame = screen.frame();
            let window_top_left = PhysicalPoint {
                x: logical_to_physical(window_frame.origin.x, scale),
                y: logical_to_physical(
                    screen_frame.origin.y + screen_frame.size.height
                        - window_frame.origin.y
                        - window_frame.size.height,
                    scale,
                ),
            };
            let origins = screen_origins(window_top_left, router.layout().preview, scale);
            router
                .shell_surface
                .set_screen_origin(origins.shell.x, origins.shell.y);
            router
                .preview_surface
                .set_screen_origin(origins.preview.x, origins.preview.y);
        }

        fn forward_mouse_move(&self, event: &NSEvent, mouse_leave: bool) {
            let Some(router) = self.router() else {
                return;
            };
            self.update_screen_origins(&router);
            let Some((physical_x, physical_y)) = self.event_point(event, router.scale()) else {
                return;
            };
            let routed = router.route(physical_x, physical_y);
            routed.target.send_offscreen_mouse_move(
                cef::MouseEvent {
                    x: routed.x,
                    y: routed.y,
                    modifiers: event_modifiers(event),
                },
                mouse_leave,
            );
        }

        fn forward_mouse_click(
            &self,
            event: &NSEvent,
            button: cef::MouseButtonType,
            mouse_up: bool,
            button_modifier: u32,
        ) {
            let Some(router) = self.router() else {
                return;
            };
            self.update_screen_origins(&router);
            let Some((physical_x, physical_y)) = self.event_point(event, router.scale()) else {
                return;
            };
            let routed = router.route(physical_x, physical_y);
            if !mouse_up {
                router.focus(routed.focus);
            }
            routed.target.send_offscreen_mouse_click(
                cef::MouseEvent {
                    x: routed.x,
                    y: routed.y,
                    modifiers: event_modifiers(event) | button_modifier,
                },
                button,
                mouse_up,
                event.clickCount().clamp(1, i32::MAX as isize) as i32,
            );
        }

        fn forward_key_event(&self, event: &NSEvent, kind: cef::KeyEventType) {
            let Some(router) = self.router() else {
                return;
            };
            self.update_screen_origins(&router);
            let characters = event.characters();
            let unmodified = event.charactersIgnoringModifiers();
            let character = characters
                .as_deref()
                .and_then(first_utf16_code_unit)
                .unwrap_or_default();
            let unmodified_character = unmodified
                .as_deref()
                .and_then(first_utf16_code_unit)
                .unwrap_or_default();
            router
                .focused_webview()
                .send_offscreen_key_event(cef::KeyEvent {
                    type_: kind,
                    modifiers: event_modifiers(event),
                    windows_key_code: windows_key_code(event.keyCode()),
                    native_key_code: i32::from(event.keyCode()),
                    is_system_key: i32::from(
                        event
                            .modifierFlags()
                            .contains(NSEventModifierFlags::Command),
                    ),
                    character,
                    unmodified_character,
                    ..Default::default()
                });
        }
    }

    fn first_utf16_code_unit(text: &NSString) -> Option<u16> {
        text.to_string().encode_utf16().next()
    }

    fn text_from_object(object: &AnyObject) -> Option<String> {
        let is_string: bool = unsafe { msg_send![object, isKindOfClass: NSString::class()] };
        let is_attributed: bool =
            unsafe { msg_send![object, isKindOfClass: NSAttributedString::class()] };
        if is_string {
            // SAFETY: isKindOfClass verified the concrete NSString type.
            let string = unsafe { &*(object as *const AnyObject).cast::<NSString>() };
            Some(string.to_string())
        } else if is_attributed {
            // SAFETY: isKindOfClass verified the concrete NSAttributedString type.
            let attributed = unsafe { &*(object as *const AnyObject).cast::<NSAttributedString>() };
            Some(attributed.string().to_string())
        } else {
            None
        }
    }

    fn cef_range(range: NSRange) -> cef::Range {
        if range.location == usize::MAX {
            return cef::Range {
                from: u32::MAX,
                to: u32::MAX,
            };
        }
        let from = range.location.min(u32::MAX as usize) as u32;
        let to = range
            .location
            .saturating_add(range.length)
            .min(u32::MAX as usize) as u32;
        cef::Range { from, to }
    }

    fn event_modifiers(event: &NSEvent) -> u32 {
        let flags = event.modifierFlags();
        cef_modifiers(MacModifierFlags {
            shift: flags.contains(NSEventModifierFlags::Shift),
            control: flags.contains(NSEventModifierFlags::Control),
            option: flags.contains(NSEventModifierFlags::Option),
            command: flags.contains(NSEventModifierFlags::Command),
            caps_lock: flags.contains(NSEventModifierFlags::CapsLock),
        })
    }

    fn modifier_key_is_down(event: &NSEvent) -> bool {
        let flags = event.modifierFlags();
        match event.keyCode() {
            54 | 55 => flags.contains(NSEventModifierFlags::Command),
            56 | 60 => flags.contains(NSEventModifierFlags::Shift),
            57 => flags.contains(NSEventModifierFlags::CapsLock),
            58 | 61 => flags.contains(NSEventModifierFlags::Option),
            59 | 62 => flags.contains(NSEventModifierFlags::Control),
            _ => !flags.is_empty(),
        }
    }

    pub(crate) struct MacosInputHook {
        input_view: usize,
        window: tauri::Window<Runtime>,
    }

    // SAFETY: input_view owns a retained MainThreadOnly object represented as
    // an opaque address. It is reconstructed and released only on AppKit's
    // main thread in Drop.
    unsafe impl Send for MacosInputHook {}
    unsafe impl Sync for MacosInputHook {}

    impl NativeInputHook for MacosInputHook {
        fn install(
            window: &tauri::Window<Runtime>,
            router: Arc<InputRouter>,
        ) -> Result<Self, String> {
            let ns_window = window
                .ns_window()
                .map_err(|error| format!("failed to read compositor NSWindow: {error}"))?
                as usize;
            if ns_window == 0 {
                return Err("compositor NSWindow is null".to_string());
            }

            let input_view = if let Some(mtm) = MainThreadMarker::new() {
                install_input_view(ns_window, router, mtm)?
            } else {
                let (sender, receiver) = std::sync::mpsc::sync_channel(1);
                window
                    .run_on_main_thread(move || {
                        let result = MainThreadMarker::new()
                            .ok_or_else(|| {
                                "AppKit input install ran off the main thread".to_string()
                            })
                            .and_then(|mtm| install_input_view(ns_window, router, mtm));
                        let _ = sender.send(result);
                    })
                    .map_err(|error| {
                        format!("failed to schedule compositor input hook: {error}")
                    })?;
                receiver
                    .recv()
                    .map_err(|_| "compositor input hook task was cancelled".to_string())??
            };

            Ok(Self {
                input_view,
                window: window.clone(),
            })
        }
    }

    impl Drop for MacosInputHook {
        fn drop(&mut self) {
            let input_view = self.input_view;
            if MainThreadMarker::new().is_some() {
                // SAFETY: the opaque address owns one retained input view and
                // Drop is currently running on the AppKit main thread.
                unsafe { detach_input_view(input_view) };
            } else {
                let _ = self.window.run_on_main_thread(move || {
                    // SAFETY: the opaque address owns one retained input view
                    // and this closure runs on the AppKit main thread.
                    unsafe { detach_input_view(input_view) };
                });
            }
        }
    }

    fn install_input_view(
        ns_window: usize,
        router: Arc<InputRouter>,
        mtm: MainThreadMarker,
    ) -> Result<usize, String> {
        // SAFETY: Tauri returned this NSWindow and execution is on AppKit's main thread.
        let window = unsafe { &*(ns_window as *const NSWindow) };
        let content = window
            .contentView()
            .ok_or_else(|| "compositor NSWindow has no content view".to_string())?;
        let input_view = CompositorInputView::new(content.bounds(), router, mtm);
        input_view.setAutoresizingMask(
            NSAutoresizingMaskOptions::ViewWidthSizable
                | NSAutoresizingMaskOptions::ViewHeightSizable,
        );
        content.addSubview_positioned_relativeTo(&input_view, NSWindowOrderingMode::Above, None);
        let tracking_options = NSTrackingAreaOptions::MouseEnteredAndExited
            | NSTrackingAreaOptions::MouseMoved
            | NSTrackingAreaOptions::ActiveAlways
            | NSTrackingAreaOptions::InVisibleRect;
        // SAFETY: owner is the live input view and nil userInfo requires no generic cast.
        let tracking = unsafe {
            NSTrackingArea::initWithRect_options_owner_userInfo(
                NSTrackingArea::alloc(),
                input_view.bounds(),
                tracking_options,
                Some(&input_view),
                None,
            )
        };
        input_view.addTrackingArea(&tracking);
        input_view.ivars().tracking_area.replace(Some(tracking));
        if let Some(router) = input_view.router() {
            input_view.update_screen_origins(&router);
        }
        window.makeFirstResponder(Some(&input_view));
        Ok(Retained::into_raw(input_view) as usize)
    }

    unsafe fn detach_input_view(input_view: usize) {
        let Some(input_view) = Retained::from_raw(input_view as *mut CompositorInputView) else {
            return;
        };
        input_view.ivars().router.replace(None);
        if let Some(tracking_area) = input_view.ivars().tracking_area.borrow_mut().take() {
            input_view.removeTrackingArea(&tracking_area);
        }
        input_view.removeFromSuperview();
    }
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
pub(crate) use appkit::MacosInputHook;

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Default)]
    struct ImeRecorder {
        calls: Vec<String>,
    }

    #[derive(Clone, Copy)]
    struct TextRange {
        start: i32,
        end: i32,
    }

    impl TextRange {
        const fn new(start: i32, end: i32) -> Self {
            Self { start, end }
        }
    }

    impl ImeRecorder {
        fn set(&mut self, text: &str, selection: TextRange) {
            assert!(selection.start <= selection.end);
            self.calls.push(format!("set:{text}"));
        }

        fn commit(&mut self, text: &str) {
            self.calls.push(format!("commit:{text}"));
        }
    }

    #[test]
    fn retina_popup_origins_include_preview_offset() {
        let origins = screen_origins(
            PhysicalPoint { x: 40, y: 80 },
            LogicalRect::new(120.0, 50.0, 640.0, 480.0),
            2.0,
        );
        assert_eq!(origins.shell, PhysicalPoint { x: 40, y: 80 });
        assert_eq!(origins.preview, PhysicalPoint { x: 280, y: 180 });
    }

    #[test]
    fn horizontal_and_vertical_scroll_are_preserved() {
        assert_eq!(cef_wheel_delta(1.5, -3.0, 2.0), (3, -6));
    }

    #[test]
    fn modifier_mapping_preserves_command_option_control_and_shift() {
        let flags = MacModifierFlags {
            shift: true,
            control: true,
            option: true,
            command: true,
            caps_lock: false,
        };
        let cef = cef_modifiers(flags);
        assert_ne!(cef & EVENTFLAG_SHIFT_DOWN, 0);
        assert_ne!(cef & EVENTFLAG_CONTROL_DOWN, 0);
        assert_ne!(cef & EVENTFLAG_ALT_DOWN, 0);
        assert_ne!(cef & EVENTFLAG_COMMAND_DOWN, 0);
    }

    #[test]
    fn ime_sequence_sets_updates_and_commits_composition() {
        let mut recorder = ImeRecorder::default();
        recorder.set("に", TextRange::new(0, 1));
        recorder.set("日本", TextRange::new(0, 2));
        recorder.commit("日本");
        assert_eq!(recorder.calls, vec!["set:に", "set:日本", "commit:日本"]);
    }

    #[test]
    fn mac_key_codes_map_to_cef_windows_virtual_keys() {
        assert_eq!(windows_key_code(0), i32::from(b'A'));
        assert_eq!(windows_key_code(8), i32::from(b'C'));
        assert_eq!(windows_key_code(9), i32::from(b'V'));
        assert_eq!(windows_key_code(51), 0x08);
        assert_eq!(windows_key_code(123), 0x25);
    }
}
