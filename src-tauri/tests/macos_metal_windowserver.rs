#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
use ardor_solutions_desktop_lib::test_support::ProbeRect;

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
#[tauri::cef_entry_point]
fn main() {
    macos_metal_composition_order();
    macos_metal_cef_lifecycle_stress_100();
    println!("Apple Silicon Metal WindowServer acceptance passed");
}

#[cfg(not(all(target_os = "macos", target_arch = "aarch64")))]
fn main() {
    eprintln!("skipped: Metal WindowServer acceptance requires Apple Silicon macOS");
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
fn macos_metal_composition_order() {
    let result = ardor_solutions_desktop_lib::test_support::run_metal_composition_probe(
        [0, 0, 255, 255],
        [255, 0, 0, 255],
        ProbeRect::new(100.0, 80.0, 400.0, 300.0),
        vec![
            ProbeRect::new(180.0, 120.0, 120.0, 80.0),
            ProbeRect::new(500.0, 380.0, 40.0, 40.0),
        ],
    )
    .expect("Metal composition probe should present");

    assert_eq!(result.pixel(120, 100), [255, 0, 0, 255]);
    assert_eq!(result.pixel(200, 140), [0, 0, 255, 255]);
    assert_eq!(result.pixel(550, 420), [0, 255, 0, 255]);
    assert_eq!(result.pixel(510, 390), [0, 0, 255, 255]);
    assert_eq!(result.backend, "macos-metal-iosurface");
    assert_eq!(result.render_mode, "native-compositor");
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
fn macos_metal_cef_lifecycle_stress_100() {
    std::env::set_var("ARDOR_TEST_METAL_CEF_LIFECYCLE_ITERATIONS", "100");
    ardor_solutions_desktop_lib::run();
    let report = ardor_solutions_desktop_lib::test_support::take_cef_lifecycle_stress_result()
        .expect("CEF lifecycle stress should publish a result")
        .expect("CEF lifecycle stress should complete");
    assert_eq!(report.completed_iterations, 100);
    assert_eq!(report.stale_callbacks, 0);
    assert_eq!(report.close_timeouts, 0);
    assert_eq!(report.mixed_mode_transitions, 0);
    assert_eq!(report.fatal_errors, 0);
    assert!(
        report.copy_ms_p95 <= 8.0,
        "copy p95 was {}",
        report.copy_ms_p95
    );
    assert_eq!(report.foreground_target_fps, 60);
    assert_eq!(report.background_target_fps, 15);
    assert_eq!(report.hidden_target_fps, 1);
}
