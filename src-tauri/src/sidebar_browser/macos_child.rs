use std::ptr;

use objc2::{rc::Retained, runtime::NSObjectProtocol};
use objc2_app_kit::NSView;
use objc2_foundation::{NSPoint, NSRect, NSSize};
use tauri::Webview;

use super::{dom_top_to_native_y, BrowserBounds};

pub(super) async fn apply_layout(
    child: &Webview,
    bounds: BrowserBounds,
    visible: bool,
    hide_before_layout: bool,
) -> Result<(), String> {
    let (sender, mut receiver) = tauri::async_runtime::channel(1);
    child
        .with_webview(move |platform| {
            let _ = sender.try_send(apply_native_layout(
                platform,
                bounds,
                visible,
                hide_before_layout,
            ));
        })
        .map_err(|error| format!("failed to dispatch a macOS sidebar browser layout: {error}"))?;

    receiver
        .recv()
        .await
        .ok_or_else(|| "the macOS sidebar browser layout ended without a result".to_string())?
}

fn apply_native_layout(
    platform: tauri::webview::PlatformWebview,
    bounds: BrowserBounds,
    visible: bool,
    hide_before_layout: bool,
) -> Result<(), String> {
    let child_address = platform.inner();
    if child_address.is_null() {
        return Err("macOS sidebar browser received an invalid native view".to_string());
    }

    // SAFETY: Tauri invokes this callback on the AppKit main thread and retains the
    // WKWebView for the callback duration. WKWebView inherits NSView.
    let child = unsafe { &*child_address.cast::<NSView>() };
    if hide_before_layout {
        child.setHidden(true);
    }
    // SAFETY: The callback-scoped child remains retained while its superview is read.
    let parent = unsafe { child.superview() }
        .ok_or_else(|| "macOS sidebar browser has no native parent view".to_string())?;
    let main = find_main_webview(&parent, child)?;

    if bounds.width >= 1.0 && bounds.height >= 1.0 {
        let main_bounds = main.bounds();
        let local_rect = NSRect::new(
            NSPoint::new(
                main_bounds.origin.x + bounds.x,
                dom_top_to_native_y(
                    main_bounds.origin.y,
                    main_bounds.size.height,
                    bounds.y,
                    bounds.height,
                    main.isFlipped(),
                ),
            ),
            NSSize::new(bounds.width, bounds.height),
        );
        let native_rect = main.convertRect_toView(local_rect, Some(&parent));
        if ![
            native_rect.origin.x,
            native_rect.origin.y,
            native_rect.size.width,
            native_rect.size.height,
        ]
        .into_iter()
        .all(f64::is_finite)
        {
            return Err("macOS sidebar browser produced invalid native bounds".to_string());
        }
        child.setFrame(native_rect);
    }
    child.setHidden(!visible);
    Ok(())
}

fn find_main_webview(parent: &NSView, child: &NSView) -> Result<Retained<NSView>, String> {
    let child_class = child.class();
    let mut main: Option<Retained<NSView>> = None;
    for candidate in parent.subviews().iter() {
        if ptr::eq(&*candidate, child) || !candidate.isKindOfClass(child_class) {
            continue;
        }
        if main.replace(candidate).is_some() {
            return Err("macOS sidebar browser found multiple host webviews".to_string());
        }
    }
    main.ok_or_else(|| "macOS sidebar browser could not find the host webview".to_string())
}
