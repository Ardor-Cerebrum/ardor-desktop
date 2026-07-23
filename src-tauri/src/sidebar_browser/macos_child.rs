use std::{cell::RefCell, ptr};

use objc2::{
    define_class, msg_send,
    rc::Retained,
    runtime::{AnyClass, NSObjectProtocol},
    DefinedClass, MainThreadOnly,
};
use objc2_app_kit::NSView;
use objc2_core_graphics::CGMutablePath;
use objc2_foundation::{MainThreadMarker, NSPoint, NSRect, NSSize};
use objc2_quartz_core::{kCAFillRuleEvenOdd, CAShapeLayer, CATransaction};
use tauri::{Runtime, Webview};

use super::{
    dom_top_to_native_y, overlay_cutouts, BrowserBounds, BrowserOverlay, BrowserOverlayCutout,
};

struct PreviewHostIvars {
    cutouts: RefCell<Vec<BrowserOverlayCutout>>,
    mask: Retained<CAShapeLayer>,
}

define_class!(
    #[unsafe(super(NSView))]
    #[thread_kind = MainThreadOnly]
    #[ivars = PreviewHostIvars]
    struct PreviewHost;

    impl PreviewHost {
        #[unsafe(method_id(hitTest:))]
        fn hit_test(&self, point: NSPoint) -> Option<Retained<NSView>> {
            let is_cutout = if let Some(parent) = unsafe { self.superview() } {
                let local = self.convertPoint_fromView(point, Some(&parent));
                let dom_y = self.bounds().size.height - local.y;
                self
                    .ivars()
                    .cutouts
                    .borrow()
                    .iter()
                    .any(|cutout| cutout.contains(local.x, dom_y))
            } else {
                false
            };

            if is_cutout {
                None
            } else {
                // SAFETY: This preserves NSView's standard hit-testing for the preview
                // everywhere outside an active DOM overlay cutout.
                unsafe { msg_send![super(self), hitTest: point] }
            }
        }
    }
);

impl PreviewHost {
    fn new(frame: NSRect, mtm: MainThreadMarker) -> Retained<Self> {
        let mask = CAShapeLayer::layer();
        // SAFETY: kCAFillRuleEvenOdd is a process-lifetime QuartzCore constant.
        unsafe { mask.setFillRule(kCAFillRuleEvenOdd) };
        let allocated = Self::alloc(mtm).set_ivars(PreviewHostIvars {
            cutouts: RefCell::new(Vec::new()),
            mask,
        });
        // SAFETY: PreviewHost is an NSView subclass initialized on the AppKit main thread.
        let host: Retained<Self> = unsafe { msg_send![super(allocated), initWithFrame: frame] };
        host.setWantsLayer(true);
        host
    }

    fn apply_cutouts(&self, cutouts: Vec<BrowserOverlayCutout>) -> Result<(), String> {
        let bounds = self.bounds();
        let layer = self
            .layer()
            .ok_or_else(|| "macOS sidebar browser host has no backing layer".to_string())?;
        let mask = &self.ivars().mask;

        CATransaction::begin();
        CATransaction::setDisableActions(true);
        if cutouts.is_empty() {
            // SAFETY: Removing an existing CAShapeLayer from the host mask is valid.
            unsafe { layer.setMask(None) };
        } else {
            let path = CGMutablePath::new();
            // SAFETY: Null transforms request identity conversion and every rectangle
            // is finite and clipped to the host bounds by overlay_cutouts.
            unsafe {
                CGMutablePath::add_rect(Some(&path), ptr::null(), bounds);
                for cutout in &cutouts {
                    let rect = NSRect::new(
                        NSPoint::new(cutout.x, bounds.size.height - cutout.y - cutout.height),
                        NSSize::new(cutout.width, cutout.height),
                    );
                    CGMutablePath::add_rounded_rect(
                        Some(&path),
                        ptr::null(),
                        rect,
                        cutout.corner_radius,
                        cutout.corner_radius,
                    );
                }
            }
            // SAFETY: CAShapeLayer inherits CALayer's setFrame: selector.
            let _: () = unsafe { msg_send![mask, setFrame: bounds] };
            mask.setPath(Some(&path));
            // SAFETY: mask is a CAShapeLayer owned by this host and is valid for CALayer.mask.
            unsafe { layer.setMask(Some(mask)) };
        }
        CATransaction::commit();

        self.ivars().cutouts.replace(cutouts);
        Ok(())
    }
}

pub(super) async fn apply_layout<R: Runtime>(
    child: &Webview<R>,
    bounds: BrowserBounds,
    visible: bool,
    hide_before_layout: bool,
    overlays: Vec<BrowserOverlay>,
) -> Result<(), String> {
    let (sender, mut receiver) = tauri::async_runtime::channel(1);
    child
        .with_webview(move |platform| {
            let _ = sender.try_send(apply_native_layout(
                platform,
                bounds,
                visible,
                hide_before_layout,
                &overlays,
            ));
        })
        .map_err(|error| format!("failed to dispatch a macOS sidebar browser layout: {error}"))?;

    receiver
        .recv()
        .await
        .ok_or_else(|| "the macOS sidebar browser layout ended without a result".to_string())?
}

pub(super) async fn detach<R: Runtime>(child: &Webview<R>) -> Result<(), String> {
    let (sender, mut receiver) = tauri::async_runtime::channel(1);
    child
        .with_webview(move |platform| {
            let _ = sender.try_send(detach_native(platform));
        })
        .map_err(|error| format!("failed to dispatch macOS sidebar browser cleanup: {error}"))?;

    receiver
        .recv()
        .await
        .ok_or_else(|| "the macOS sidebar browser cleanup ended without a result".to_string())?
}

fn apply_native_layout<R: Runtime>(
    platform: tauri::webview::PlatformWebview<R>,
    bounds: BrowserBounds,
    visible: bool,
    hide_before_layout: bool,
    overlays: &[BrowserOverlay],
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
    let (host, parent, main) = ensure_host(child)?;

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
        host.setFrame(native_rect);
        child.setFrame(host.bounds());
    }

    host.apply_cutouts(overlay_cutouts(bounds, overlays))?;
    child.setHidden(false);
    host.setHidden(!visible);
    Ok(())
}

fn detach_native<R: Runtime>(platform: tauri::webview::PlatformWebview<R>) -> Result<(), String> {
    let child_address = platform.inner();
    if child_address.is_null() {
        return Err("macOS sidebar browser cleanup received an invalid native view".to_string());
    }

    // SAFETY: Tauri invokes this callback on the AppKit main thread and retains the
    // WKWebView for the callback duration. WKWebView inherits NSView.
    let child = unsafe { &*child_address.cast::<NSView>() };
    let Some(current_parent) = (unsafe { child.superview() }) else {
        return Ok(());
    };
    let Ok(host) = current_parent.downcast::<PreviewHost>() else {
        return Ok(());
    };
    child.setHidden(true);
    if let Some(parent) = unsafe { host.superview() } {
        parent.addSubview(child);
        child.setFrame(host.frame());
        host.removeFromSuperview();
    } else {
        child.removeFromSuperview();
    }
    Ok(())
}

fn ensure_host(
    child: &NSView,
) -> Result<(Retained<PreviewHost>, Retained<NSView>, Retained<NSView>), String> {
    // SAFETY: The callback-scoped child remains retained while its superview is read.
    let current_parent = unsafe { child.superview() }
        .ok_or_else(|| "macOS sidebar browser has no native parent view".to_string())?;

    if let Ok(host) = current_parent.clone().downcast::<PreviewHost>() {
        let parent = unsafe { host.superview() }
            .ok_or_else(|| "macOS sidebar browser host has no native parent view".to_string())?;
        let main = find_main_webview(&parent, child.class(), None)?;
        return Ok((host, parent, main));
    }

    let main = find_main_webview(&current_parent, child.class(), Some(child))?;
    let mtm = MainThreadMarker::new()
        .ok_or_else(|| "macOS sidebar browser layout did not run on the main thread".to_string())?;
    let host = PreviewHost::new(child.frame(), mtm);
    current_parent.addSubview(&host);
    host.addSubview(child);
    child.setFrame(host.bounds());
    Ok((host, current_parent, main))
}

fn find_main_webview(
    parent: &NSView,
    child_class: &AnyClass,
    child: Option<&NSView>,
) -> Result<Retained<NSView>, String> {
    let mut main: Option<Retained<NSView>> = None;
    for candidate in parent.subviews().iter() {
        if child.is_some_and(|child| ptr::eq(&*candidate, child))
            || !candidate.isKindOfClass(child_class)
        {
            continue;
        }
        if main.replace(candidate).is_some() {
            return Err("macOS sidebar browser found multiple host webviews".to_string());
        }
    }
    main.ok_or_else(|| "macOS sidebar browser could not find the host webview".to_string())
}
