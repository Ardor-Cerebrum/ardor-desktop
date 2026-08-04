use objc2_app_kit::{NSWindow, NSWindowButton};
use tauri::{Runtime, WebviewWindow, WindowEvent};

const TRAFFIC_LIGHT_INSET: f64 = 17.0;

pub fn configure_native_chrome<R: Runtime>(window: &WebviewWindow<R>) {
    position_traffic_lights(window);

    let window_for_events = window.clone();
    window.on_window_event(move |event| {
        if matches!(
            event,
            WindowEvent::Resized(_) | WindowEvent::ScaleFactorChanged { .. }
        ) {
            position_traffic_lights(&window_for_events);
        }
    });
}

fn position_traffic_lights<R: Runtime>(window: &WebviewWindow<R>) {
    let window_for_task = window.clone();
    if let Err(error) = window.run_on_main_thread(move || {
        let ns_window = match window_for_task.ns_window() {
            Ok(ns_window) => ns_window,
            Err(error) => {
                eprintln!("Failed to access the native macOS window: {error}");
                return;
            }
        };

        // SAFETY: Tauri supplies the live NSWindow pointer, and the closure runs on AppKit's
        // main thread. The references are used only for this synchronous layout pass.
        unsafe {
            layout_traffic_lights(&*ns_window.cast::<NSWindow>());
        }
    }) {
        eprintln!("Failed to schedule macOS traffic-light layout: {error}");
    }
}

unsafe fn layout_traffic_lights(window: &NSWindow) {
    let Some(close) = window.standardWindowButton(NSWindowButton::CloseButton) else {
        return;
    };
    let Some(minimize) = window.standardWindowButton(NSWindowButton::MiniaturizeButton) else {
        return;
    };
    let zoom = window.standardWindowButton(NSWindowButton::ZoomButton);

    let Some(button_row) = close.superview() else {
        return;
    };
    let Some(titlebar_container) = button_row.superview() else {
        return;
    };

    let close_frame = close.frame();
    let button_spacing = minimize.frame().origin.x - close_frame.origin.x;
    let container_height = close_frame.size.height + 2.0 * TRAFFIC_LIGHT_INSET;
    let mut container_frame = titlebar_container.frame();
    container_frame.size.height = container_height;
    container_frame.origin.y = window.frame().size.height - container_height;
    titlebar_container.setFrame(container_frame);

    for (index, button) in [Some(close), Some(minimize), zoom]
        .into_iter()
        .flatten()
        .enumerate()
    {
        let mut origin = button.frame().origin;
        origin.x = TRAFFIC_LIGHT_INSET + index as f64 * button_spacing;
        origin.y = TRAFFIC_LIGHT_INSET;
        button.setFrameOrigin(origin);
    }
}

#[cfg(test)]
mod tests {
    use super::TRAFFIC_LIGHT_INSET;

    #[test]
    fn native_button_row_has_symmetric_vertical_inset() {
        let button_height = 14.0;
        let container_height = button_height + 2.0 * TRAFFIC_LIGHT_INSET;

        assert_eq!(container_height, 48.0);
        assert_eq!(container_height - TRAFFIC_LIGHT_INSET - button_height, 17.0);
    }
}
