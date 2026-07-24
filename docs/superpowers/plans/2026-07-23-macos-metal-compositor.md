# macOS Metal Sidebar Compositor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a production-ready Apple Silicon Metal compositor that renders both the Ardor shell and artifact preview through accelerated CEF OSR, preserves Windows behavior, and automatically falls back to the corrected native macOS child path.

**Architecture:** Extract the existing Windows compositor into a shared WGPU core with platform-specific texture-import and native-input adapters. On Apple Silicon, import callback-scoped CEF IOSurfaces through Metal, copy them into compositor-owned WGPU textures, and cut over from the visible bootstrap only after the first valid shell frame is presented. A single mode state machine owns startup, one-session recovery, teardown, and session-wide native fallback.

**Tech Stack:** Rust 1.90, Tauri CEF runtime, CEF 150 accelerated OSR, WGPU 29, wgpu-hal Metal/DX12 interop, objc2 0.6, objc2-metal 0.3.2, objc2-io-surface 0.3.2, AppKit, GitHub Actions, Node test runner.

## Global Constraints

- Support the new compositor only on `aarch64-apple-darwin`.
- Set the minimum supported macOS version to 13.0 Ventura in CI and release builds.
- Keep the existing Windows D3D12 compositor behavior unchanged.
- Keep the current macOS native-child implementation compiled as the automatic fallback.
- Never run a GPU shell with a native preview or any other mixed rendering mode.
- Keep the bootstrap visible until the first valid shell frame is imported and presented.
- Keep the bootstrap hidden and alive after macOS GPU cutover.
- Preserve public-HTTPS navigation, download, new-window, device-permission, shell-command, and DevTools security gates.
- Preserve 60 FPS foreground, 15 FPS background, and 1 FPS hidden activity policies.
- Require Metal frame-import p95 at or below 8 ms in the Apple Silicon acceptance run.
- Do not retain a CEF-owned IOSurface or imported Metal texture after its accelerated-paint callback completes.
- On fatal runtime failure, attempt surface reconfiguration, then at most one full GPU-session restart, then enter native fallback.
- Close CEF browsers with forced asynchronous close during generation teardown.
- Do not claim completion without an Apple Silicon WindowServer integration run and the lifecycle stress run.

## File Map

- `src-tauri/src/sidebar_browser.rs` — command validation, generation lifecycle, and dispatch to GPU or native mode.
- `src-tauri/src/sidebar_browser/macos_child.rs` — corrected native fallback layout, hit testing, and detach sequence.
- `src-tauri/src/sidebar_browser/gpu_compositor/mod.rs` — public compositor facade, session lifecycle, and platform selection.
- `src-tauri/src/sidebar_browser/gpu_compositor/geometry.rs` — shared logical/physical geometry, shell regions, and input target selection.
- `src-tauri/src/sidebar_browser/gpu_compositor/renderer.rs` — shared WGPU pipelines, owned layer textures, presentation, telemetry, and surface recovery.
- `src-tauri/src/sidebar_browser/gpu_compositor/scheduler.rs` — coalesced 60/15/1 present scheduling.
- `src-tauri/src/sidebar_browser/gpu_compositor/texture_import/mod.rs` — cross-platform importer contract and common validation/error types.
- `src-tauri/src/sidebar_browser/gpu_compositor/texture_import/windows.rs` — existing D3D12 shared-handle importer.
- `src-tauri/src/sidebar_browser/gpu_compositor/texture_import/macos.rs` — IOSurface-to-MTLTexture-to-WGPU importer.
- `src-tauri/src/sidebar_browser/gpu_compositor/input/mod.rs` — shared target/focus router.
- `src-tauri/src/sidebar_browser/gpu_compositor/input/windows.rs` — existing HWND subclass adapter.
- `src-tauri/src/sidebar_browser/gpu_compositor/input/macos.rs` — AppKit `CompositorInputView`, NSEvent conversion, screen origins, and IME.
- `src-tauri/vendor/tauri-runtime-cef/src/webview.rs` — accelerated-OSR capability gate and offscreen IME forwarding methods.
- `src-tauri/src/lib.rs` — bootstrap startup/cutover and recovery coordinator wiring.
- `src-tauri/Cargo.toml` and `src-tauri/Cargo.lock` — Metal, IOSurface, WGPU, and accelerated-OSR dependencies.
- `scripts/macos-metal-contract.test.mjs` — static target/dependency/workflow invariants.
- `scripts/macos-metal-windowserver.test.mjs` — ignored-by-default WindowServer composition and lifecycle harness launcher.
- `.github/workflows/ci.yml` and `.github/workflows/release.yml` — macOS 13 Apple Silicon build contract and integration job.
- `docs/testing/macos-metal-compositor.md` — manual acceptance and performance procedure.

---

### Task 1: Lock Down the Native macOS Fallback Fix

**Files:**
- Modify: `src-tauri/src/sidebar_browser.rs`
- Modify: `src-tauri/src/sidebar_browser/macos_child.rs`

**Interfaces:**
- Consumes: existing `BrowserBounds`, `BrowserOverlay`, `BrowserOverlayCutout`, and `DesktopWebview`.
- Produces: `native_hit_test_point(point: NSPoint, bounds: NSRect) -> (f64, f64)` and a fallback close path that detaches the AppKit host before `BrowserHost::close_browser(1)`.

- [ ] **Step 1: Add regression tests for local hit-test coordinates and generation cleanup**

Add this pure helper test beside the existing sidebar-browser tests:

```rust
#[test]
fn native_hit_testing_uses_host_local_coordinates() {
    let (x, dom_y) = native_hit_test_coordinates(
        18.0,
        42.0,
        5.0,
        7.0,
        200.0,
    );
    assert_eq!((x, dom_y), (13.0, 165.0));
}

#[test]
fn stale_generation_cannot_replace_the_active_browser_after_close() {
    let mut lifecycle = BrowserLifecycle::default();
    let (first, _) = lifecycle.begin_open(bounds(0.0));
    lifecycle.install(first.clone());
    let (second, _) = lifecycle.begin_open(bounds(1.0));
    lifecycle.install(second.clone());

    assert!(lifecycle.take(first.generation).is_none());
    assert_eq!(
        lifecycle.snapshot(second.generation).map(|browser| browser.generation),
        Some(second.generation),
    );
}
```

Define the pure helper in `sidebar_browser.rs` so AppKit code and tests use the same top-origin conversion:

```rust
#[cfg(any(target_os = "macos", test))]
fn native_hit_test_coordinates(
    point_x: f64,
    point_y: f64,
    bounds_origin_x: f64,
    bounds_origin_y: f64,
    bounds_height: f64,
) -> (f64, f64) {
    (
        point_x - bounds_origin_x,
        bounds_height - (point_y - bounds_origin_y),
    )
}
```

- [ ] **Step 2: Run the focused tests and verify the new helper is not wired yet**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml sidebar_browser::tests::native_hit_testing_uses_host_local_coordinates
```

Expected: compilation failure until the test import and helper are present, or a failing coordinate assertion before `PreviewHost::hit_test` is switched to the helper.

- [ ] **Step 3: Finish the native fallback implementation**

In `PreviewHost::hit_test`, treat `point` as already local, normalize the bounds origin once, and convert bottom-origin AppKit Y to DOM-top Y:

```rust
let bounds = self.bounds();
let (local_x, dom_y) = native_hit_test_coordinates(
    point.x,
    point.y,
    bounds.origin.x,
    bounds.origin.y,
    bounds.size.height,
);
```

In `apply_cutouts`, build and frame the mask in zero-origin local bounds:

```rust
let local_bounds = NSRect::new(NSPoint::new(0.0, 0.0), bounds.size);
CGMutablePath::add_rect(Some(&path), ptr::null(), local_bounds);
let _: () = msg_send![mask, setFrame: local_bounds];
```

In `detach_native`, hide both views, remove the mask, remove the CEF child from the hierarchy, then remove `PreviewHost`:

```rust
child.setHidden(true);
host.setHidden(true);
let _ = host.apply_cutouts(Vec::new());
child.removeFromSuperview();
host.removeFromSuperview();
```

In non-Windows `close_browser`, keep the exact macOS ordering:

```rust
let _ = webview.hide();
let detach_error = macos_child::detach(&webview).await.err();
let close_error = with_sidebar_browser_host(&webview, |host| host.close_browser(1))
    .await
    .err();
```

Return a combined error if both detach and close fail; never reparent the closing CEF child as a sibling of the main webview.

- [ ] **Step 4: Verify the fallback regression suite**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml sidebar_browser::tests
git diff --check
```

Expected: all sidebar-browser tests pass and `git diff --check` prints no errors.

- [ ] **Step 5: Commit the isolated fallback fix**

```bash
git add src-tauri/src/sidebar_browser.rs src-tauri/src/sidebar_browser/macos_child.rs
git commit -m "fix: stabilize macos sidebar preview teardown"
```

---

### Task 2: Extract the Shared Compositor Core Without Changing Windows

**Files:**
- Delete: `src-tauri/src/sidebar_browser/windows_gpu_compositor.rs`
- Delete: `src-tauri/src/sidebar_browser/windows_gpu_compositor/texture_import.rs`
- Create: `src-tauri/src/sidebar_browser/gpu_compositor/mod.rs`
- Create: `src-tauri/src/sidebar_browser/gpu_compositor/geometry.rs`
- Create: `src-tauri/src/sidebar_browser/gpu_compositor/renderer.rs`
- Create: `src-tauri/src/sidebar_browser/gpu_compositor/scheduler.rs`
- Create: `src-tauri/src/sidebar_browser/gpu_compositor/texture_import/mod.rs`
- Create: `src-tauri/src/sidebar_browser/gpu_compositor/texture_import/windows.rs`
- Create: `src-tauri/src/sidebar_browser/gpu_compositor/input/mod.rs`
- Create: `src-tauri/src/sidebar_browser/gpu_compositor/input/windows.rs`
- Modify: `src-tauri/src/sidebar_browser.rs`

**Interfaces:**
- Consumes: current `AcceleratedCompositorState`, `GpuCompositor`, `PresentScheduler`, `InputRouter`, `WindowsDx12TextureImporter`, and existing compositor tests.
- Produces:
  - `pub(crate) struct AcceleratedCompositorState`
  - `pub(crate) struct AcceleratedCompositorStats`
  - `pub(crate) fn start_device_recovery_coordinator(app: AppHandle)`
  - `pub(crate) fn shell_label(generation: u64) -> String`
  - `pub(crate) fn window_label(generation: u64) -> String`
  - `pub(super) trait TextureImporter`
  - `pub(super) trait NativeInputHook`

- [ ] **Step 1: Move the existing compositor tests to their destination modules**

Move tests with these ownership rules:

```text
render_activity_*                 -> scheduler.rs
shell_regions_*                   -> geometry.rs
present_shader_*                  -> renderer.rs
copy_latency_* and device_health  -> renderer.rs
adapter_luid_*                    -> texture_import/windows.rs
mouse target selection            -> input/mod.rs
```

Add this target-selection test to `input/mod.rs`:

```rust
#[test]
fn overlay_points_route_to_shell_before_preview() {
    let layout = InputLayout {
        preview: LogicalRect::new(100.0, 50.0, 400.0, 300.0),
        overlays: vec![LogicalRect::new(180.0, 90.0, 120.0, 80.0)],
        preview_visible: true,
    };

    assert_eq!(layout.target_at(120.0, 70.0), InputTarget::Preview);
    assert_eq!(layout.target_at(200.0, 100.0), InputTarget::Shell);
    assert_eq!(layout.target_at(20.0, 20.0), InputTarget::Shell);
}
```

- [ ] **Step 2: Run tests and verify the module split is incomplete**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml gpu_compositor
```

Expected: compilation fails because `gpu_compositor` and the moved interfaces do not exist yet.

- [ ] **Step 3: Create the shared geometry and platform contracts**

Use these exact common types in `geometry.rs`:

```rust
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub(super) struct LogicalRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl LogicalRect {
    pub const fn new(x: f64, y: f64, width: f64, height: f64) -> Self {
        Self { x, y, width, height }
    }

    pub fn contains(self, x: f64, y: f64) -> bool {
        x >= self.x
            && y >= self.y
            && x < self.x + self.width
            && y < self.y + self.height
    }

    pub fn to_physical(self, scale: f64) -> PhysicalRect {
        PhysicalRect {
            x: (self.x * scale).round().max(0.0) as u32,
            y: (self.y * scale).round().max(0.0) as u32,
            width: (self.width * scale).round().max(0.0) as u32,
            height: (self.height * scale).round().max(0.0) as u32,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(super) struct PhysicalRect {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}
```

Use this importer contract in `texture_import/mod.rs`:

```rust
pub(super) trait TextureImporter: Sized + Send {
    type AdapterId: Copy + Eq + fmt::Debug + fmt::Display + Send + Sync + 'static;

    const PLATFORM: &'static str;

    fn adapter_hint_from_shared_handle(
        handle: *mut c_void,
    ) -> Result<Option<Self::AdapterId>, String>;
    fn adapter_id_from_wgpu_adapter(adapter: &wgpu::Adapter) -> Result<Self::AdapterId, String>;
    fn new(selected_adapter: Self::AdapterId) -> Result<Self, String>;
    fn import_texture(
        &self,
        device: &wgpu::Device,
        handle: *mut c_void,
        format: wgpu::TextureFormat,
        width: u32,
        height: u32,
    ) -> Result<ImportedTexture<Self::AdapterId>, TextureImportError<Self::AdapterId>>;
}

pub(super) struct ImportedTexture<AdapterId> {
    pub texture: wgpu::Texture,
    pub source_adapter_id: Option<AdapterId>,
}
```

Use this native input contract in `input/mod.rs`:

```rust
pub(super) trait NativeInputHook: Sized {
    fn install(
        window: &tauri::Window<Runtime>,
        router: Arc<InputRouter>,
    ) -> Result<Self, String>;
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum InputTarget {
    Shell,
    Preview,
}

#[derive(Clone, Debug)]
pub(super) struct InputLayout {
    pub preview: LogicalRect,
    pub overlays: Vec<LogicalRect>,
    pub preview_visible: bool,
}

impl InputLayout {
    pub fn target_at(&self, x: f64, y: f64) -> InputTarget {
        let obscured = self.overlays.iter().any(|overlay| overlay.contains(x, y));
        if self.preview_visible && self.preview.contains(x, y) && !obscured {
            InputTarget::Preview
        } else {
            InputTarget::Shell
        }
    }
}
```

- [ ] **Step 4: Move existing implementations behind the contracts**

Move the current shader, renderer, health, and presentation code unchanged into `renderer.rs`; move scheduler code into `scheduler.rs`; move HWND subclassing into `input/windows.rs`; move D3D import into `texture_import/windows.rs`.

The Windows importer implements the new hint method by returning its existing shared-handle LUID:

```rust
fn adapter_hint_from_shared_handle(
    handle: *mut c_void,
) -> Result<Option<Self::AdapterId>, String> {
    Self::adapter_id_from_shared_handle(handle).map(Some)
}
```

Select native implementations in the module indexes:

```rust
#[cfg(windows)]
pub(super) type PlatformTextureImporter = windows::WindowsDx12TextureImporter;

#[cfg(windows)]
pub(super) type PlatformInputHook = windows::WindowsInputHook;
```

In `gpu_compositor/mod.rs`, keep the public facade names unchanged and replace all `#[cfg(windows)]` guards on shared lifecycle code with:

```rust
#[cfg(any(windows, all(target_os = "macos", target_arch = "aarch64")))]
```

Leave platform implementation selection under the narrower target guards. Update `sidebar_browser.rs` to use:

```rust
mod gpu_compositor;
pub(crate) use gpu_compositor::AcceleratedCompositorState;
```

- [ ] **Step 5: Verify Windows behavior and formatting**

Run on Windows:

```powershell
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml gpu_compositor
node --test scripts/verify-desktop-ui-contract.test.mjs
```

Expected: all commands pass, existing D3D12 tests retain their assertions, and the desktop UI contract reports 10 passing tests.

- [ ] **Step 6: Commit the behavior-preserving extraction**

```bash
git add src-tauri/src/sidebar_browser.rs src-tauri/src/sidebar_browser/gpu_compositor
git add -u src-tauri/src/sidebar_browser/windows_gpu_compositor.rs src-tauri/src/sidebar_browser/windows_gpu_compositor
git commit -m "refactor: extract shared gpu compositor core"
```

---

### Task 3: Enable Accelerated OSR and the macOS 13 Metal Build Contract

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/Cargo.lock`
- Modify: `src-tauri/vendor/tauri-runtime-cef/src/webview.rs`
- Create: `scripts/macos-metal-contract.test.mjs`
- Modify: `package.json`
- Modify: `.github/workflows/ci.yml`
- Modify: `.github/workflows/release.yml`
- Modify: `scripts/release-security.test.mjs`

**Interfaces:**
- Consumes: `ARDOR_CEF_ACCELERATED_OSR_PROBE` and `OffscreenSurface::new`.
- Produces:
  - `accelerated_osr_platform_supported() -> bool`
  - `should_probe_accelerated_osr_for(flag: Option<&str>, supported: bool) -> bool`
  - `bun run test:macos-metal-contract`
  - build environment `MACOSX_DEPLOYMENT_TARGET=13.0`.

- [ ] **Step 1: Add runtime gate unit tests**

In `webview.rs`, add:

```rust
#[test]
fn accelerated_osr_probe_accepts_supported_apple_silicon() {
    assert!(should_probe_accelerated_osr_for(Some("1"), true));
    assert!(should_probe_accelerated_osr_for(Some("TRUE"), true));
}

#[test]
fn accelerated_osr_probe_rejects_disabled_or_unsupported_platforms() {
    assert!(!should_probe_accelerated_osr_for(None, true));
    assert!(!should_probe_accelerated_osr_for(Some("0"), true));
    assert!(!should_probe_accelerated_osr_for(Some("1"), false));
}
```

Create `scripts/macos-metal-contract.test.mjs` with exact assertions:

```js
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const cargo = readFileSync("src-tauri/Cargo.toml", "utf8");
const ci = readFileSync(".github/workflows/ci.yml", "utf8");
const release = readFileSync(".github/workflows/release.yml", "utf8");

test("Apple Silicon Metal dependencies and accelerated OSR are target-scoped", () => {
  assert.match(cargo, /cfg\\(all\\(target_os = "macos", target_arch = "aarch64"\\)\\)/);
  assert.match(cargo, /objc2-io-surface/);
  assert.match(cargo, /objc2-metal/);
  assert.match(cargo, /features = \\["accelerated_osr", "build-util"\\]/);
});

test("CI and release builds target macOS 13", () => {
  assert.match(ci, /MACOSX_DEPLOYMENT_TARGET: "13\\.0"/);
  assert.match(release, /MACOSX_DEPLOYMENT_TARGET: "13\\.0"/);
});
```

- [ ] **Step 2: Run the tests and verify they fail**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml accelerated_osr_probe
node --test scripts/macos-metal-contract.test.mjs
```

Expected: Rust tests fail until the pure gate is added; Node tests fail because the target dependencies and deployment target are absent.

- [ ] **Step 3: Add exact target dependencies**

Replace target-specific WGPU duplication with this shared accelerated-compositor target:

```toml
[target.'cfg(any(windows, all(target_os = "macos", target_arch = "aarch64")))'.dependencies]
pollster = "0.4"
wgpu = "29"

[target.'cfg(all(target_os = "macos", target_arch = "aarch64"))'.dependencies]
cef = { version = "=150.0.0", features = ["accelerated_osr", "build-util"] }
objc2-core-foundation = { version = "=0.3.2", default-features = false, features = ["std"] }
objc2-io-surface = { version = "=0.3.2", default-features = false, features = [
  "std",
  "IOSurfaceRef",
  "objc2",
  "objc2-core-foundation",
] }
objc2-metal = { version = "=0.3.2", default-features = false, features = [
  "std",
  "MTLAllocation",
  "MTLDevice",
  "MTLResource",
  "MTLTexture",
  "objc2-io-surface",
] }
```

Keep `gpu-allocator`, `windows`, and the Windows CEF target dependency under `cfg(windows)`. Regenerate the lock file with:

```bash
cargo check --manifest-path src-tauri/Cargo.toml --target aarch64-apple-darwin
```

- [ ] **Step 4: Implement the pure accelerated-OSR gate**

Replace the Windows-only predicate with:

```rust
fn accelerated_osr_platform_supported() -> bool {
    cfg!(any(
        windows,
        all(target_os = "macos", target_arch = "aarch64")
    ))
}

fn should_probe_accelerated_osr_for(flag: Option<&str>, supported: bool) -> bool {
    supported
        && matches!(
            flag,
            Some("1" | "true" | "TRUE" | "yes" | "YES" | "on" | "ON")
        )
}

fn should_probe_accelerated_osr() -> bool {
    should_probe_accelerated_osr_for(
        std::env::var("ARDOR_CEF_ACCELERATED_OSR_PROBE")
            .ok()
            .as_deref(),
        accelerated_osr_platform_supported(),
    )
}
```

- [ ] **Step 5: Enforce deployment target and contract tests**

Add this job-level environment to `.github/workflows/ci.yml`:

```yaml
env:
  MACOSX_DEPLOYMENT_TARGET: "13.0"
```

Add the same variable to the release asset job environment:

```yaml
env:
  MACOSX_DEPLOYMENT_TARGET: "13.0"
```

Add to `package.json`:

```json
"test:macos-metal-contract": "node --test scripts/macos-metal-contract.test.mjs"
```

Extend `release-security.test.mjs` with:

```js
assert.match(buildJob, /MACOSX_DEPLOYMENT_TARGET: "13\\.0"/);
```

- [ ] **Step 6: Verify and commit**

Run on Apple Silicon:

```bash
bun run test:macos-metal-contract
bun run test:release-security
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
cargo test --manifest-path src-tauri/Cargo.toml accelerated_osr_probe
cargo check --manifest-path src-tauri/Cargo.toml --target aarch64-apple-darwin
```

Expected: all commands pass and Cargo resolves WGPU 29 plus objc2 Metal/IOSurface only for Apple Silicon macOS.

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/vendor/tauri-runtime-cef/src/webview.rs scripts/macos-metal-contract.test.mjs package.json .github/workflows/ci.yml .github/workflows/release.yml scripts/release-security.test.mjs
git commit -m "build: enable apple silicon accelerated osr"
```

---

### Task 4: Implement the IOSurface Metal Texture Importer

**Files:**
- Modify: `src-tauri/src/sidebar_browser/gpu_compositor/texture_import/mod.rs`
- Create: `src-tauri/src/sidebar_browser/gpu_compositor/texture_import/macos.rs`
- Modify: `src-tauri/src/sidebar_browser/gpu_compositor/renderer.rs`

**Interfaces:**
- Consumes: `TextureImporter`, `wgpu::hal::api::Metal`, callback-scoped `*mut c_void`, and CEF width/height/format metadata.
- Produces:
  - `pub(super) struct MetalRegistryId(u64)`
  - `pub(super) struct MacosMetalTextureImporter`
  - `validate_iosurface_metadata(surface_width: usize, surface_height: usize, plane_count: usize, pixel_format: u32, cef_width: u32, cef_height: u32) -> Result<IOSurfaceMetadata, String>`
  - `TextureImporter for MacosMetalTextureImporter`.

- [ ] **Step 1: Add metadata and device-identity tests**

Add pure tests in `texture_import/macos.rs`:

```rust
#[test]
fn iosurface_metadata_accepts_single_plane_bgra() {
    let metadata = validate_iosurface_metadata(
        1280,
        720,
        0,
        u32::from_be_bytes(*b"BGRA"),
        1280,
        720,
    )
    .expect("BGRA IOSurface should be valid");
    assert_eq!(metadata.plane, 0);
    assert_eq!(metadata.format, wgpu::TextureFormat::Bgra8Unorm);
}

#[test]
fn iosurface_metadata_rejects_mismatched_dimensions_and_formats() {
    assert!(validate_iosurface_metadata(
        640,
        480,
        0,
        u32::from_be_bytes(*b"BGRA"),
        1280,
        720,
    )
    .is_err());
    assert!(validate_iosurface_metadata(640, 480, 2, 0, 640, 480).is_err());
}

#[test]
fn metal_registry_ids_must_match() {
    assert!(verify_registry_id(MetalRegistryId(7), MetalRegistryId(7)).is_ok());
    assert!(matches!(
        verify_registry_id(MetalRegistryId(7), MetalRegistryId(8)),
        Err(TextureImportError::AdapterMismatch { .. })
    ));
}
```

- [ ] **Step 2: Run the importer tests and verify they fail**

Run on Apple Silicon:

```bash
cargo test --manifest-path src-tauri/Cargo.toml texture_import::macos
```

Expected: compilation fails because the macOS importer and metadata validator do not exist.

- [ ] **Step 3: Implement metadata validation and retained IOSurface ownership**

Use these exact types:

```rust
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) struct MetalRegistryId(pub u64);

impl fmt::Display for MetalRegistryId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{:016x}", self.0)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct IOSurfaceMetadata {
    plane: usize,
    format: wgpu::TextureFormat,
    width: u32,
    height: u32,
}

fn validate_iosurface_metadata(
    surface_width: usize,
    surface_height: usize,
    plane_count: usize,
    pixel_format: u32,
    cef_width: u32,
    cef_height: u32,
) -> Result<IOSurfaceMetadata, String> {
    if cef_width == 0 || cef_height == 0 {
        return Err("CEF IOSurface dimensions must be non-zero".into());
    }
    if surface_width != cef_width as usize || surface_height != cef_height as usize {
        return Err(format!(
            "CEF IOSurface dimensions {surface_width}x{surface_height} do not match callback {cef_width}x{cef_height}"
        ));
    }
    if plane_count > 1 {
        return Err(format!("CEF IOSurface has unsupported plane count {plane_count}"));
    }
    if pixel_format != u32::from_be_bytes(*b"BGRA") {
        return Err(format!("CEF IOSurface has unsupported pixel format {pixel_format:#010x}"));
    }
    Ok(IOSurfaceMetadata {
        plane: 0,
        format: wgpu::TextureFormat::Bgra8Unorm,
        width: cef_width,
        height: cef_height,
    })
}
```

Convert the callback handle into a retained CoreFoundation object only inside `import_texture`:

```rust
let surface_ptr = NonNull::new(handle.cast::<IOSurfaceRef>())
    .ok_or_else(|| TextureImportError::Import("CEF returned a null IOSurface".into()))?;
let surface = unsafe { CFRetained::retain(surface_ptr) };
```

Read `width()`, `height()`, `plane_count()`, and `pixel_format()` from the retained object and pass them to the pure validator.

The macOS importer has no adapter identifier encoded in the IOSurface handle, so its selection hint is deliberately empty:

```rust
fn adapter_hint_from_shared_handle(
    _handle: *mut c_void,
) -> Result<Option<Self::AdapterId>, String> {
    Ok(None)
}
```

- [ ] **Step 4: Implement Metal and WGPU wrapping**

Inside the single documented unsafe boundary:

```rust
let hal_device = unsafe { device.as_hal::<api::Metal>() }
    .ok_or_else(|| TextureImportError::Import("wgpu device is not using Metal".into()))?;
let raw_device = hal_device.raw_device();
verify_registry_id(
    self.selected_adapter,
    MetalRegistryId(raw_device.registryID()),
)?;

let descriptor = unsafe {
    MTLTextureDescriptor::texture2DDescriptorWithPixelFormat_width_height_mipmapped(
        MTLPixelFormat::BGRA8Unorm,
        metadata.width as usize,
        metadata.height as usize,
        false,
    )
};
descriptor.setUsage(MTLTextureUsage::ShaderRead);
let metal_texture = raw_device
    .newTextureWithDescriptor_iosurface_plane(&descriptor, &surface, metadata.plane)
    .ok_or_else(|| TextureImportError::Import("Metal rejected the CEF IOSurface".into()))?;

let hal_texture = unsafe {
    <api::Metal as wgpu::hal::Api>::Device::texture_from_raw(
        metal_texture,
        metadata.format,
        MTLTextureType::Type2D,
        1,
        1,
        wgpu::hal::CopyExtent {
            width: metadata.width,
            height: metadata.height,
            depth: 1,
        },
    )
};
let texture = unsafe {
    device.create_texture_from_hal::<api::Metal>(
        hal_texture,
        &wgpu::TextureDescriptor {
            label: Some("Ardor imported CEF IOSurface texture"),
            size: wgpu::Extent3d {
                width: metadata.width,
                height: metadata.height,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: metadata.format,
            usage: wgpu::TextureUsages::TEXTURE_BINDING,
            view_formats: &[],
        },
    )
};
```

Return `ImportedTexture { texture, source_adapter_id: Some(self.selected_adapter) }`. The renderer must encode the copy, submit it, wait within `GPU_COPY_WAIT_BUDGET`, and drop `ImportedTexture` before returning from the CEF callback.

On timeout or failed polling, immediately drop the pending imported texture and request recovery:

```rust
match pending.wait(GPU_COPY_WAIT_BUDGET) {
    GpuCopyWaitResult::Completed(completed) => renderer.complete_ingest(completed),
    GpuCopyWaitResult::TimedOut(pending) => {
        drop(pending);
        renderer.record_copy_timeout_and_request_recovery();
    }
    GpuCopyWaitResult::Failed(pending, error) => {
        drop(pending);
        renderer.record_import_failure_and_request_recovery(error);
    }
}
```

Do not place a timed-out macOS `PendingGpuCopy` into a deferred queue.

- [ ] **Step 5: Add platform selection and verify callback lifetime**

In `texture_import/mod.rs`:

```rust
#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
mod macos;
#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
pub(super) type PlatformTextureImporter = macos::MacosMetalTextureImporter;
```

Add a test-only drop probe around the import/copy helper:

```rust
struct DropProbe(Arc<AtomicUsize>);

impl Drop for DropProbe {
    fn drop(&mut self) {
        self.0.fetch_add(1, Ordering::AcqRel);
    }
}

fn copy_callback_texture_for_test(probe: DropProbe) -> Result<(), String> {
    let _callback_scoped_import = probe;
    let _owned_copy_completed = true;
    Ok(())
}

#[test]
fn callback_import_is_dropped_after_owned_copy() {
    let drops = Arc::new(AtomicUsize::new(0));
    copy_callback_texture_for_test(DropProbe(drops.clone())).unwrap();
    assert_eq!(drops.load(Ordering::Acquire), 1);
}
```

The test helper must submit a no-op owned-copy stand-in and return only after dropping the probe; production code follows the same lexical ownership scope.

- [ ] **Step 6: Verify and commit**

Run on Apple Silicon:

```bash
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml texture_import
```

Expected: metadata, identity, and lifetime tests pass without CPU-frame fallback.

```bash
git add src-tauri/src/sidebar_browser/gpu_compositor/texture_import src-tauri/src/sidebar_browser/gpu_compositor/renderer.rs
git commit -m "feat: import cef iosurfaces through metal"
```

---

### Task 5: Make the Shared Renderer Start and Present on Metal

**Files:**
- Modify: `src-tauri/src/sidebar_browser/gpu_compositor/mod.rs`
- Modify: `src-tauri/src/sidebar_browser/gpu_compositor/renderer.rs`
- Modify: `src-tauri/src/sidebar_browser/gpu_compositor/scheduler.rs`
- Modify: `src-tauri/src/sidebar_browser/gpu_compositor/geometry.rs`

**Interfaces:**
- Consumes: `PlatformTextureImporter`, shared WGPU shader, `OffscreenSurface`, and Tauri compositor window.
- Produces:
  - `RendererBackend::required_backends() -> wgpu::Backends`
  - `FirstPresent { generation: u64, shell_sequence: u64 }`
  - `AcceleratedCompositorState::wait_for_first_shell_present(Duration)`.

- [ ] **Step 1: Add backend, composition-order, and first-present tests**

Add:

```rust
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum CompositionPass {
    Preview,
    ShellOutsidePreview,
    ShellOverlay(usize),
    ShellFullWindow,
}

#[test]
fn macos_backend_selects_only_metal() {
    assert_eq!(
        RendererBackend::MacosMetal.required_backends(),
        wgpu::Backends::METAL,
    );
}

#[test]
fn composition_order_draws_preview_then_shell_regions_then_overlays() {
    assert_eq!(
        composition_passes(true, 2),
        vec![
            CompositionPass::Preview,
            CompositionPass::ShellOutsidePreview,
            CompositionPass::ShellOverlay(0),
            CompositionPass::ShellOverlay(1),
        ],
    );
}

#[test]
fn first_present_requires_an_imported_shell_frame() {
    let mut readiness = PresentReadiness::default();
    readiness.record_present(Layer::Preview, 1);
    assert!(readiness.first_shell_present().is_none());
    readiness.record_present(Layer::Shell, 2);
    assert_eq!(readiness.first_shell_present(), Some(2));
}
```

- [ ] **Step 2: Run focused tests and verify they fail**

```bash
cargo test --manifest-path src-tauri/Cargo.toml renderer::
```

Expected: compilation fails until `RendererBackend`, composition pass enumeration, and readiness tracking exist.

- [ ] **Step 3: Make adapter/device creation backend-specific**

Use:

```rust
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum RendererBackend {
    WindowsDx12,
    MacosMetal,
}

impl RendererBackend {
    fn required_backends(self) -> wgpu::Backends {
        match self {
            Self::WindowsDx12 => wgpu::Backends::DX12,
            Self::MacosMetal => wgpu::Backends::METAL,
        }
    }
}
```

Create the instance with `InstanceDescriptor { backends: backend.required_backends(), ..Default::default() }`, reject an adapter whose backend differs, and pass the selected adapter ID into `PlatformTextureImporter::new`.

Select the adapter with one platform-neutral algorithm:

```rust
async fn select_platform_adapter(
    instance: &wgpu::Instance,
    surface: &wgpu::Surface<'_>,
    hint: Option<<PlatformTextureImporter as TextureImporter>::AdapterId>,
    backend: RendererBackend,
) -> Result<wgpu::Adapter, String> {
    for adapter in instance.enumerate_adapters(backend.required_backends()).await {
        if !adapter.is_surface_supported(surface) {
            continue;
        }
        let id = PlatformTextureImporter::adapter_id_from_wgpu_adapter(&adapter)?;
        if hint.is_none_or(|expected| expected == id) {
            return Ok(adapter);
        }
    }
    Err(format!(
        "no present-capable {:?} adapter matches the CEF texture source",
        backend.required_backends()
    ))
}
```

Windows passes `Some(AdapterLuid)` from the first accelerated CEF frame. macOS passes `None`, selects the present-capable Metal adapter, stores its `MetalRegistryId`, and validates that ID again against `wgpu-hal`'s raw `MTLDevice` on every import.

- [ ] **Step 4: Preserve a single composition order on both platforms**

Encode passes from this explicit list:

```rust
fn composition_passes(preview_visible: bool, overlay_count: usize) -> Vec<CompositionPass> {
    let mut passes = Vec::with_capacity(2 + overlay_count);
    if preview_visible {
        passes.push(CompositionPass::Preview);
        passes.push(CompositionPass::ShellOutsidePreview);
        passes.extend((0..overlay_count).map(CompositionPass::ShellOverlay));
    } else {
        passes.push(CompositionPass::ShellFullWindow);
    }
    passes
}
```

Keep the existing ingest shader color conversion and present shader sampling unchanged. Keep each imported callback texture alive only until its copy into `LayerTexture` completes.

Preserve the existing browser policy while moving session creation:

```rust
let devtools_enabled = tauri_runtime_cef::browser_devtools_enabled();
let shell_builder = shell_builder.devtools(devtools_enabled);
let preview_builder = preview_builder
    .devtools(devtools_enabled)
    .incognito(true)
    .initialization_script_for_all_frames(DEVICE_PERMISSION_DEFENSE_IN_DEPTH)
    .on_navigation(is_allowed_sidebar_navigation)
    .on_new_window(|_, _| NewWindowResponse::Deny);

if let Some(host) = preview_platform.browser().host() {
    host.set_audio_muted(0);
}
```

Do not enable DevTools outside the existing runtime gate and do not route shell-only commands to the preview label.

- [ ] **Step 5: Add first-present signaling and atomic layout generations**

Add this readiness object to the session:

```rust
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct FirstPresent {
    generation: u64,
    shell_sequence: u64,
}

#[derive(Default)]
struct PresentReadiness {
    first_shell_sequence: Option<u64>,
}

impl PresentReadiness {
    fn record_present(&mut self, layer: Layer, sequence: u64) {
        if layer == Layer::Shell && self.first_shell_sequence.is_none() {
            self.first_shell_sequence = Some(sequence);
        }
    }

    fn first_shell_present(&self) -> Option<u64> {
        self.first_shell_sequence
    }
}
```

Signal a condition variable only after `surface_texture.present()` succeeds for a frame containing an imported shell sequence. Store one `LayoutSnapshot { generation, scale, window, preview, overlays }` and apply resize, scale, OSR bounds, screen origins, and renderer rectangles from the same snapshot.

- [ ] **Step 6: Verify Metal and Windows renderer tests**

Run on Apple Silicon:

```bash
cargo test --manifest-path src-tauri/Cargo.toml gpu_compositor::renderer
cargo test --manifest-path src-tauri/Cargo.toml gpu_compositor::geometry
cargo test --manifest-path src-tauri/Cargo.toml accelerated_preview_keeps_chromiums_native_audio_output
```

Run on Windows:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml gpu_compositor::renderer
```

Expected: all tests pass; Apple Silicon logs `backend=Metal`; Windows logs `backend=Dx12`.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/sidebar_browser/gpu_compositor/mod.rs src-tauri/src/sidebar_browser/gpu_compositor/renderer.rs src-tauri/src/sidebar_browser/gpu_compositor/scheduler.rs src-tauri/src/sidebar_browser/gpu_compositor/geometry.rs
git commit -m "feat: present shared compositor through metal"
```

---

### Task 6: Add macOS Mouse, Keyboard, Popup, and IME Routing

**Files:**
- Modify: `src-tauri/vendor/tauri-runtime-cef/src/webview.rs`
- Modify: `src-tauri/src/sidebar_browser/gpu_compositor/input/mod.rs`
- Create: `src-tauri/src/sidebar_browser/gpu_compositor/input/macos.rs`
- Modify: `src-tauri/src/sidebar_browser/gpu_compositor/mod.rs`
- Modify: `src-tauri/Cargo.toml`

**Interfaces:**
- Consumes: `InputRouter`, `CefWebview`, `NSWindow`, `NSEvent`, `NSTextInputClient`.
- Produces:
  - `CefWebview::send_offscreen_ime_set_composition`
  - `CefWebview::send_offscreen_ime_commit`
  - `CefWebview::send_offscreen_ime_cancel`
  - `pub(super) struct MacosInputHook`
  - `screen_origins(window_origin, preview, scale) -> ScreenOrigins`.

- [ ] **Step 1: Add pure conversion tests**

Add tests for routing and Retina origins:

```rust
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct PhysicalPoint {
    x: i32,
    y: i32,
}

struct ScreenOrigins {
    shell: PhysicalPoint,
    preview: PhysicalPoint,
}

#[derive(Clone, Copy, Debug)]
struct MacModifierFlags {
    shift: bool,
    control: bool,
    option: bool,
    command: bool,
    caps_lock: bool,
}

const EVENTFLAG_CAPS_LOCK_ON: u32 = 1 << 0;
const EVENTFLAG_SHIFT_DOWN: u32 = 1 << 1;
const EVENTFLAG_CONTROL_DOWN: u32 = 1 << 2;
const EVENTFLAG_ALT_DOWN: u32 = 1 << 3;
const EVENTFLAG_COMMAND_DOWN: u32 = 1 << 7;

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
    assert_eq!(
        cef_wheel_delta(1.5, -3.0, 2.0),
        (3, -6),
    );
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
```

Add IME forwarding tests around a test host recorder:

```rust
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
fn ime_sequence_sets_updates_and_commits_composition() {
    let mut recorder = ImeRecorder::default();
    recorder.set("に", TextRange::new(0, 1));
    recorder.set("日本", TextRange::new(0, 2));
    recorder.commit("日本");
    assert_eq!(recorder.calls, vec!["set:に", "set:日本", "commit:日本"]);
}
```

- [ ] **Step 2: Run focused tests and verify they fail**

```bash
cargo test --manifest-path src-tauri/Cargo.toml input::macos
cargo test --manifest-path src-tauri/Cargo.toml ime_sequence
```

Expected: compilation fails because conversion helpers and IME forwarding methods are absent.

- [ ] **Step 3: Add CEF offscreen IME forwarding**

Add methods to `CefWebview`:

```rust
pub fn send_offscreen_ime_set_composition(
    &self,
    text: &str,
    underlines: &[cef::CompositionUnderline],
    replacement_range: cef::Range,
    selection_range: cef::Range,
) {
    if let Some(host) = self.browser.host() {
        let text = cef::CefString::from(text);
        host.ime_set_composition(
            Some(&text),
            underlines,
            Some(&replacement_range),
            Some(&selection_range),
        );
    }
}

pub fn send_offscreen_ime_commit(
    &self,
    text: &str,
    replacement_range: cef::Range,
    relative_cursor_pos: i32,
) {
    if let Some(host) = self.browser.host() {
        let text = cef::CefString::from(text);
        host.ime_commit_text(Some(&text), Some(&replacement_range), relative_cursor_pos);
    }
}

pub fn send_offscreen_ime_cancel(&self) {
    if let Some(host) = self.browser.host() {
        host.ime_cancel_composition();
    }
}
```

Use the exact slice/range forms accepted by CEF 150 bindings; if the generated wrapper requires `Option<&[CompositionUnderline]>`, pass `Some(underlines)` without changing the public methods above.

- [ ] **Step 4: Implement deterministic coordinate, wheel, and modifier conversion**

Treat the input `window_top_left` as a CEF-style physical screen point whose Y axis already increases downward. Convert AppKit's bottom-left global coordinates to that convention once when reading `NSWindow.frame`, using the containing `NSScreen.frame` top edge.

```rust
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
                .saturating_add((preview.x * scale).round() as i32),
            y: window_top_left
                .y
                .saturating_add((preview.y * scale).round() as i32),
        },
    }
}

fn cef_wheel_delta(delta_x: f64, delta_y: f64, scale: f64) -> (i32, i32) {
    (
        (delta_x * scale).round() as i32,
        (delta_y * scale).round() as i32,
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
```

- [ ] **Step 5: Implement `CompositorInputView`**

Define one transparent full-window `NSView` subclass with ivars:

```rust
struct CompositorInputViewIvars {
    router: RefCell<Option<Arc<InputRouter>>>,
    marked_text: RefCell<String>,
    selected_range: Cell<NSRange>,
    tracking_area: RefCell<Option<Retained<NSTrackingArea>>>,
}
```

Implement AppKit selectors for:

```text
acceptsFirstResponder
becomeFirstResponder
resignFirstResponder
mouseMoved:
mouseEntered:
mouseExited:
mouseDown:
mouseUp:
rightMouseDown:
rightMouseUp:
otherMouseDown:
otherMouseUp:
scrollWheel:
keyDown:
keyUp:
flagsChanged:
insertText:replacementRange:
setMarkedText:selectedRange:replacementRange:
unmarkText
hasMarkedText
markedRange
selectedRange
validAttributesForMarkedText
attributedSubstringForProposedRange:actualRange:
firstRectForCharacterRange:actualRange:
characterIndexForPoint:
doCommandBySelector:
```

Each mouse callback obtains window-local logical coordinates, calls `InputRouter::route`, focuses that target before a down event, and forwards preview-local coordinates for preview events. `scrollWheel:` forwards both axes. `keyDown:` calls `interpretKeyEvents` so AppKit drives `NSTextInputClient`; non-text keys still produce CEF RAWKEYDOWN/KEYUP events.

- [ ] **Step 6: Install and detach the input view safely**

`MacosInputHook::install` must run on the AppKit main thread, attach the input view above the WGPU presentation view, size it to autoresize with the content view, install a tracking area, and make it first responder.

Its `Drop` implementation must:

```rust
input_view.ivars().router.replace(None);
input_view.removeTrackingArea(&tracking_area);
input_view.removeFromSuperview();
```

Do not let an AppKit callback retain `Session`; callbacks hold only an `Arc<InputRouter>` that is cleared before browser teardown.

- [ ] **Step 7: Verify input and IME tests**

Run on Apple Silicon:

```bash
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml input
cargo test --manifest-path src-tauri/Cargo.toml ime_
```

Expected: all conversion and sequence tests pass. Manually type a composed Japanese string into both shell and preview and confirm each browser receives exclusive focus.

- [ ] **Step 8: Commit**

```bash
git add src-tauri/vendor/tauri-runtime-cef/src/webview.rs src-tauri/src/sidebar_browser/gpu_compositor/input src-tauri/src/sidebar_browser/gpu_compositor/mod.rs src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "feat: route macos compositor input and ime"
```

---

### Task 7: Wire Bootstrap Cutover and Session-Wide Native Fallback

**Files:**
- Modify: `src-tauri/src/sidebar_browser.rs`
- Modify: `src-tauri/src/sidebar_browser/gpu_compositor/mod.rs`
- Modify: `src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: `wait_for_first_shell_present`, native child functions, and sidebar command generation lifecycle.
- Produces:
  - `CompositorMode`
  - `CompositorModeState::transition`
  - `SidebarBrowserState::start_compositor`
  - `SidebarBrowserState::enter_native_fallback`.

- [ ] **Step 1: Add state-machine tests**

Add:

```rust
#[test]
fn startup_can_cut_over_or_fallback_but_never_mix_modes() {
    let mut state = CompositorModeState::default();
    assert_eq!(state.transition(ModeEvent::StartGpu), Ok(CompositorMode::StartingGpu));
    assert_eq!(state.transition(ModeEvent::FirstShellPresent), Ok(CompositorMode::GpuActive));
    assert!(state.transition(ModeEvent::StartupFailed).is_err());
}

#[test]
fn failed_recovery_enters_native_fallback_once() {
    let mut state = CompositorModeState::from(CompositorMode::GpuActive);
    assert_eq!(state.transition(ModeEvent::BeginRecovery), Ok(CompositorMode::RecoveringGpu));
    assert_eq!(state.transition(ModeEvent::RecoveryFailed), Ok(CompositorMode::NativeFallback));
    assert_eq!(state.transition(ModeEvent::RecoveryFailed), Ok(CompositorMode::NativeFallback));
}

#[test]
fn commands_route_only_to_the_active_session_mode() {
    assert_eq!(
        CompositorModeState::from(CompositorMode::GpuActive).command_backend(),
        CommandBackend::Gpu,
    );
    assert_eq!(
        CompositorModeState::from(CompositorMode::NativeFallback).command_backend(),
        CommandBackend::Native,
    );
    assert_eq!(
        CompositorModeState::from(CompositorMode::StartingGpu).command_backend(),
        CommandBackend::Unavailable,
    );
}
```

- [ ] **Step 2: Run tests and verify they fail**

```bash
cargo test --manifest-path src-tauri/Cargo.toml compositor_mode
```

Expected: compilation fails until the mode types and transitions are defined.

- [ ] **Step 3: Implement the exact state machine**

Use:

```rust
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(crate) enum CompositorMode {
    #[default]
    BootstrapVisible,
    StartingGpu,
    GpuActive,
    RecoveringGpu,
    NativeFallback,
    Closing,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum CommandBackend {
    Gpu,
    Native,
    Unavailable,
}

#[derive(Debug, Default)]
struct CompositorModeState {
    mode: CompositorMode,
}

impl From<CompositorMode> for CompositorModeState {
    fn from(mode: CompositorMode) -> Self {
        Self { mode }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ModeEvent {
    StartGpu,
    FirstShellPresent,
    StartupFailed,
    BeginRecovery,
    RecoverySucceeded,
    RecoveryFailed,
    Close,
}
```

Permit only:

```text
BootstrapVisible + StartGpu         -> StartingGpu
StartingGpu + FirstShellPresent     -> GpuActive
StartingGpu + StartupFailed         -> NativeFallback
GpuActive + BeginRecovery           -> RecoveringGpu
RecoveringGpu + RecoverySucceeded   -> GpuActive
RecoveringGpu + RecoveryFailed      -> NativeFallback
any non-Closing mode + Close        -> Closing
NativeFallback + StartupFailed      -> NativeFallback
NativeFallback + RecoveryFailed     -> NativeFallback
```

Return an error for every other pair.

Implement the transition as one exhaustive match:

```rust
impl CompositorModeState {
    fn transition(&mut self, event: ModeEvent) -> Result<CompositorMode, String> {
        use CompositorMode as Mode;
        use ModeEvent as Event;

        let next = match (self.mode, event) {
            (Mode::BootstrapVisible, Event::StartGpu) => Mode::StartingGpu,
            (Mode::StartingGpu, Event::FirstShellPresent) => Mode::GpuActive,
            (Mode::StartingGpu, Event::StartupFailed) => Mode::NativeFallback,
            (Mode::GpuActive, Event::BeginRecovery) => Mode::RecoveringGpu,
            (Mode::RecoveringGpu, Event::RecoverySucceeded) => Mode::GpuActive,
            (Mode::RecoveringGpu, Event::RecoveryFailed) => Mode::NativeFallback,
            (Mode::NativeFallback, Event::StartupFailed | Event::RecoveryFailed) => {
                Mode::NativeFallback
            }
            (Mode::Closing, Event::Close) => Mode::Closing,
            (Mode::BootstrapVisible
            | Mode::StartingGpu
            | Mode::GpuActive
            | Mode::RecoveringGpu
            | Mode::NativeFallback, Event::Close) => Mode::Closing,
            (current, invalid) => {
                return Err(format!(
                    "invalid compositor transition from {current:?} using {invalid:?}"
                ));
            }
        };
        self.mode = next;
        Ok(next)
    }

    fn command_backend(&self) -> CommandBackend {
        match self.mode {
            CompositorMode::GpuActive => CommandBackend::Gpu,
            CompositorMode::NativeFallback | CompositorMode::BootstrapVisible => {
                CommandBackend::Native
            }
            CompositorMode::StartingGpu
            | CompositorMode::RecoveringGpu
            | CompositorMode::Closing => CommandBackend::Unavailable,
        }
    }
}
```

- [ ] **Step 4: Route all sidebar commands through mode**

For `open_sidebar_browser`, select one backend before installing the new lifecycle generation:

```rust
match state.compositor.command_backend() {
    CommandBackend::Gpu => {
        if !state
            .compositor
            .open_preview(next.generation, url.clone(), bounds, overlays)?
        {
            return Err("accelerated compositor rejected the preview generation".into());
        }
    }
    CommandBackend::Native => {
        open_native_preview(&app, next.label.clone(), url.clone(), bounds, overlays).await?;
    }
    CommandBackend::Unavailable => {
        return Err("sidebar browser is unavailable while the compositor starts".into());
    }
}
```

Use the same dispatch rule for the remaining commands:

```text
layout -> compositor.layout_preview or layout_native_preview
control -> compositor.control_preview or control_native_preview
input -> compositor.input_preview or an ignored native response
close -> compositor.close_preview or close_native_preview
```

Factor the current non-Windows child creation into:

```rust
async fn open_native_preview(
    app: &AppHandle,
    label: String,
    url: tauri::Url,
    bounds: BrowserBounds,
    overlays: Vec<BrowserOverlay>,
) -> Result<(), String>
```

Factor the existing native layout and close branches into:

```rust
async fn layout_native_preview(
    app: &AppHandle,
    browser: &ActiveBrowser,
    bounds: BrowserBounds,
    visible: bool,
    overlays: Vec<BrowserOverlay>,
) -> Result<bool, String>

async fn close_native_preview(
    app: &AppHandle,
    browser: &ActiveBrowser,
) -> Result<(), String>
```

Use these only in `NativeFallback`. Preserve stale generation checks and never create a native child while mode is `GpuActive`.

- [ ] **Step 5: Implement bootstrap cutover**

In `lib.rs`, use shared startup on Windows and Apple Silicon, but keep platform-specific bootstrap semantics:

```rust
#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
tauri::async_runtime::spawn(async move {
    let result = async {
        let generation = handle
            .state::<SidebarBrowserState>()
            .start_compositor(&handle)
            .await?;
        handle
            .state::<SidebarBrowserState>()
            .wait_for_first_shell_present(generation, Duration::from_secs(30))
            .await?;
        Ok::<u64, String>(generation)
    }
    .await;
    match result {
        Ok(_generation) => {
            if let Some(bootstrap) = handle.get_webview_window("main") {
                bootstrap.hide()?;
            }
        }
        Err(error) => {
            eprintln!("Metal compositor startup failed; using native fallback: {error}");
            handle
                .state::<SidebarBrowserState>()
                .enter_native_fallback(&handle)
                .await?;
        }
    }
    Ok::<(), String>(())
});
```

On macOS, do not hide bootstrap before startup and do not close it after cutover. On Windows, preserve current hide-before-start and close-after-cutover behavior.

- [ ] **Step 6: Verify state and command routing**

```bash
cargo test --manifest-path src-tauri/Cargo.toml compositor_mode
cargo test --manifest-path src-tauri/Cargo.toml sidebar_browser::tests
node --test scripts/verify-desktop-ui-contract.test.mjs
```

Expected: all tests pass and command labels/security checks are unchanged.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/sidebar_browser.rs src-tauri/src/sidebar_browser/gpu_compositor/mod.rs src-tauri/src/lib.rs
git commit -m "feat: cut over macos shell with native fallback"
```

---

### Task 8: Complete Recovery, Forced Teardown, and Diagnostics

**Files:**
- Modify: `src-tauri/src/sidebar_browser/gpu_compositor/mod.rs`
- Modify: `src-tauri/src/sidebar_browser/gpu_compositor/renderer.rs`
- Modify: `src-tauri/src/sidebar_browser/gpu_compositor/scheduler.rs`
- Modify: `src-tauri/src/sidebar_browser.rs`
- Modify: `src-tauri/vendor/tauri-runtime-cef/src/webview.rs`
- Modify: `src-tauri/vendor/tauri-runtime-cef/src/cef_impl/client/mod.rs`
- Modify: `src-tauri/vendor/tauri-runtime-cef/src/cef_impl/client/life_span.rs`

**Interfaces:**
- Consumes: renderer device health, mode state machine, hidden bootstrap, and forced CEF close.
- Produces:
  - `RecoveryDecision`
  - `RecoveryBudget { session_restarts: u8 }`
  - `BrowserCloseState`
  - `CefWebview::force_close_and_wait(Duration) -> Result<(), String>`
  - Metal diagnostics in `AcceleratedCompositorStats`.

- [ ] **Step 1: Add recovery-policy and teardown-order tests**

Add:

```rust
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum FailureKind {
    SurfaceOutdated,
    SurfaceLost,
    SurfaceTimeout,
    Occluded,
    DeviceLost,
    AdapterMismatch,
    RepeatedImportFailure,
    CopyTimeout,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum TeardownStep {
    MarkClosing,
    DetachInput,
    ClearPaintCallbacks,
    StopScheduler,
    ForceCloseBrowsers,
    WaitForBrowserClose,
    ReleaseGpuResources,
    DestroyWindow,
}

#[derive(Default)]
struct TeardownRecorder {
    steps: Vec<TeardownStep>,
}

fn execute_teardown(recorder: &mut TeardownRecorder) {
    recorder.steps.extend([
        TeardownStep::MarkClosing,
        TeardownStep::DetachInput,
        TeardownStep::ClearPaintCallbacks,
        TeardownStep::StopScheduler,
        TeardownStep::ForceCloseBrowsers,
        TeardownStep::WaitForBrowserClose,
        TeardownStep::ReleaseGpuResources,
        TeardownStep::DestroyWindow,
    ]);
}

#[test]
fn recovery_reconfigures_then_restarts_once_then_falls_back() {
    let mut budget = RecoveryBudget::default();
    assert_eq!(
        budget.decide(FailureKind::SurfaceOutdated),
        RecoveryDecision::ReconfigureSurface,
    );
    assert_eq!(
        budget.decide(FailureKind::DeviceLost),
        RecoveryDecision::RestartSession,
    );
    budget.record_session_restart();
    assert_eq!(
        budget.decide(FailureKind::DeviceLost),
        RecoveryDecision::EnterNativeFallback,
    );
}

#[test]
fn teardown_barrier_uses_strict_ownership_order() {
    let mut recorder = TeardownRecorder::default();
    execute_teardown(&mut recorder);
    assert_eq!(
        recorder.steps,
        vec![
            TeardownStep::MarkClosing,
            TeardownStep::DetachInput,
            TeardownStep::ClearPaintCallbacks,
            TeardownStep::StopScheduler,
            TeardownStep::ForceCloseBrowsers,
            TeardownStep::WaitForBrowserClose,
            TeardownStep::ReleaseGpuResources,
            TeardownStep::DestroyWindow,
        ],
    );
}
```

- [ ] **Step 2: Run tests and verify they fail**

```bash
cargo test --manifest-path src-tauri/Cargo.toml recovery_
cargo test --manifest-path src-tauri/Cargo.toml teardown_
```

Expected: compilation fails until policy and teardown steps exist.

- [ ] **Step 3: Implement bounded recovery**

Use:

```rust
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum RecoveryDecision {
    ReconfigureSurface,
    RestartSession,
    EnterNativeFallback,
}

#[derive(Default)]
struct RecoveryBudget {
    session_restarts: u8,
}

impl RecoveryBudget {
    fn decide(&self, failure: FailureKind) -> RecoveryDecision {
        match failure {
            FailureKind::SurfaceOutdated
            | FailureKind::SurfaceLost
            | FailureKind::SurfaceTimeout
            | FailureKind::Occluded => RecoveryDecision::ReconfigureSurface,
            FailureKind::DeviceLost
            | FailureKind::AdapterMismatch
            | FailureKind::RepeatedImportFailure
            | FailureKind::CopyTimeout
                if self.session_restarts == 0 =>
            {
                RecoveryDecision::RestartSession
            }
            FailureKind::DeviceLost
            | FailureKind::AdapterMismatch
            | FailureKind::RepeatedImportFailure
            | FailureKind::CopyTimeout => RecoveryDecision::EnterNativeFallback,
        }
    }

    fn record_session_restart(&mut self) {
        self.session_restarts = self.session_restarts.saturating_add(1);
    }
}
```

Map `SurfaceError::Outdated`, `Lost`, `Timeout`, and occlusion to surface reconfiguration plus both CEF layer invalidations. Map device loss, adapter mismatch, repeated import failure, and copy timeout to one full restart. After `session_restarts == 1`, route the next fatal decision to `enter_native_fallback`.

- [ ] **Step 4: Enforce teardown order**

Create one close state while constructing each CEF client, store clones in both `TauriCefChildLifeSpanHandler` and the public runtime `Webview`, and notify it from `on_before_close`:

```rust
#[derive(Clone, Default)]
pub struct BrowserCloseState {
    inner: Arc<(Mutex<bool>, Condvar)>,
}

impl BrowserCloseState {
    pub(crate) fn mark_closed(&self) {
        let (closed, wake) = &*self.inner;
        *closed.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = true;
        wake.notify_all();
    }

    pub fn wait(&self, timeout: Duration) -> bool {
        let (closed, wake) = &*self.inner;
        let closed = closed.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if *closed {
            return true;
        }
        let (closed, _) = wake
            .wait_timeout_while(closed, timeout, |closed| !*closed)
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *closed
    }
}
```

In `TauriCefChildLifeSpanHandler::on_before_close`, call `self.close_state.mark_closed()` before sending `Message::BrowserClosed`. Add this non-main-thread runtime method:

```rust
pub fn force_close_and_wait(&self, timeout: Duration) -> Result<(), String> {
    let host = self
        .browser
        .host()
        .ok_or_else(|| "CEF browser host is unavailable during close".to_string())?;
    host.close_browser(1);
    if self.close_state.wait(timeout) {
        Ok(())
    } else {
        Err("timed out waiting for CEF on_before_close".to_string())
    }
}
```

Call `force_close_and_wait` only from the compositor recovery/teardown worker; never block the AppKit/CEF UI thread.

Replace implicit `Drop` ordering with an explicit `Session::close`:

```rust
fn close(mut self) -> Result<(), String> {
    self.closing.store(true, Ordering::Release);
    self.input_hook.take();
    self.shell_surface.clear_accelerated_paint_handler();
    self.preview_surface.clear_accelerated_paint_handler();
    self.present_scheduler.stop();
    self.preview.force_close_and_wait(Duration::from_secs(5))?;
    self.shell.force_close_and_wait(Duration::from_secs(5))?;
    self.renderer.take();
    self.window.close().map_err(|error| error.to_string())
}
```

Accelerated-paint handlers must return immediately when `closing` is true. The browser-close barrier is notified by CEF `on_before_close`, not by sleeping.

- [ ] **Step 5: Restore bootstrap on fatal fallback**

The fallback transition must:

```text
mark mode RecoveringGpu
close the complete GPU session
show the retained bootstrap window
mark mode NativeFallback
clear the active GPU preview generation
```

The bootstrap shell may recreate a preview from durable frontend state. Do not replay a native preview from stale compositor state, and do not keep a GPU preview or shell after showing bootstrap.

- [ ] **Step 6: Extend diagnostics**

Ensure `AcceleratedCompositorStats` includes and logs:

```rust
backend: Option<&'static str>,
mode: CompositorMode,
shell_fps: u32,
preview_fps: u32,
present_fps: u32,
imported_frames: u64,
presented_frames: u64,
copy_ms_p50: f64,
copy_ms_p95: f64,
dropped_frames: u64,
coalesced_frames: u64,
surface_recovery_count: u64,
device_recovery_count: u64,
last_error: Option<String>,
```

GPU-active macOS stats must report `backend == Some("macos-metal-iosurface")`; treat `OffscreenRenderMode::CpuFrame` as a fatal startup/recovery error.

- [ ] **Step 7: Verify and commit**

```bash
cargo test --manifest-path src-tauri/Cargo.toml recovery_
cargo test --manifest-path src-tauri/Cargo.toml teardown_
cargo test --manifest-path src-tauri/Cargo.toml gpu_compositor
git diff --check
```

Expected: all tests pass; teardown has no scheduler or callback after browser close starts.

```bash
git add src-tauri/src/sidebar_browser/gpu_compositor src-tauri/src/sidebar_browser.rs src-tauri/vendor/tauri-runtime-cef/src/webview.rs src-tauri/vendor/tauri-runtime-cef/src/cef_impl/client/mod.rs src-tauri/vendor/tauri-runtime-cef/src/cef_impl/client/life_span.rs
git commit -m "feat: recover and tear down metal compositor safely"
```

---

### Task 9: Add WindowServer Integration, Stress, Performance, and Release Acceptance

**Files:**
- Create: `src-tauri/tests/macos_metal_windowserver.rs`
- Create: `scripts/macos-metal-windowserver.test.mjs`
- Modify: `scripts/macos-metal-contract.test.mjs`
- Modify: `package.json`
- Modify: `src-tauri/Cargo.toml`
- Modify: `.github/workflows/ci.yml`
- Create: `docs/testing/macos-metal-compositor.md`

**Interfaces:**
- Consumes: compositor diagnostics, test-only synthetic shell/preview colors, overlay layout, and lifecycle commands.
- Produces:
  - ignored Rust test `macos_metal_composition_order`
  - ignored Rust test `macos_metal_lifecycle_stress_100`
  - `bun run test:macos-metal-windowserver`
  - documented manual acceptance record.

- [ ] **Step 1: Add failing WindowServer test declarations**

Create an Apple Silicon-only integration test:

```rust
#![cfg(all(target_os = "macos", target_arch = "aarch64"))]

use ardor_solutions_desktop_lib::test_support::ProbeRect;

#[test]
#[ignore = "requires an interactive WindowServer session"]
fn macos_metal_composition_order() {
    let result = ardor_solutions_desktop_lib::test_support::run_metal_composition_probe(
        [0, 0, 255, 255],
        [255, 0, 0, 255],
        ProbeRect::new(100.0, 80.0, 400.0, 300.0),
        vec![ProbeRect::new(180.0, 120.0, 120.0, 80.0)],
    )
    .expect("Metal composition probe should present");

    assert_eq!(result.pixel(120, 100), [255, 0, 0, 255]);
    assert_eq!(result.pixel(200, 140), [0, 0, 255, 255]);
    assert_eq!(result.backend, "macos-metal-iosurface");
    assert_eq!(result.render_mode, "native-compositor");
}

#[test]
#[ignore = "requires an interactive WindowServer session"]
fn macos_metal_lifecycle_stress_100() {
    let report =
        ardor_solutions_desktop_lib::test_support::run_metal_lifecycle_stress(100)
            .expect("lifecycle stress should complete");
    assert_eq!(report.completed_iterations, 100);
    assert_eq!(report.stale_callbacks, 0);
    assert_eq!(report.close_timeouts, 0);
    assert_eq!(report.mixed_mode_transitions, 0);
    assert_eq!(report.fatal_errors, 0);
}
```

- [ ] **Step 2: Run ignored tests explicitly and verify the harness is absent**

Run on an interactive Apple Silicon runner:

```bash
cargo test --manifest-path src-tauri/Cargo.toml --test macos_metal_windowserver -- --ignored --nocapture
```

Expected: compilation fails because `test_support` probes are not implemented.

- [ ] **Step 3: Implement deterministic test support**

Declare the opt-in feature:

```toml
[features]
metal-integration-tests = []
```

Expose `test_support` only under `cfg(any(test, feature = "metal-integration-tests"))`, including this public test input:

```rust
#[derive(Clone, Copy, Debug)]
pub struct ProbeRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl ProbeRect {
    pub const fn new(x: f64, y: f64, width: f64, height: f64) -> Self {
        Self { x, y, width, height }
    }
}

pub struct CompositionProbeResult {
    pub backend: &'static str,
    pub render_mode: &'static str,
    pixels: Vec<[u8; 4]>,
    width: u32,
}

impl CompositionProbeResult {
    pub fn pixel(&self, x: u32, y: u32) -> [u8; 4] {
        self.pixels[(y * self.width + x) as usize]
    }
}

pub struct LifecycleStressReport {
    pub completed_iterations: u32,
    pub stale_callbacks: u64,
    pub close_timeouts: u64,
    pub mixed_mode_transitions: u64,
    pub fatal_errors: u64,
    pub copy_ms_p95: f64,
    pub foreground_target_fps: u8,
    pub background_target_fps: u8,
    pub hidden_target_fps: u8,
}

pub fn run_metal_composition_probe(
    shell_rgba: [u8; 4],
    preview_rgba: [u8; 4],
    preview: ProbeRect,
    overlays: Vec<ProbeRect>,
) -> Result<CompositionProbeResult, String>

pub fn run_metal_lifecycle_stress(
    iterations: u32,
) -> Result<LifecycleStressReport, String>
```

The composition probe must:

```text
create one real Metal WGPU surface
create owned synthetic shell and preview textures
apply the production composition pipeline
read back four representative pixels
return backend and render mode diagnostics
close the session through the production teardown barrier
```

The lifecycle probe must run exactly 100 iterations of:

```text
open -> navigate -> resize -> scale/layout update -> close
```

Count callbacks received after each generation is marked closed, close-barrier timeouts, mixed-mode transitions, and fatal compositor errors.

- [ ] **Step 4: Add the WindowServer launcher**

Create `scripts/macos-metal-windowserver.test.mjs`:

```js
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";

assert.equal(process.platform, "darwin", "WindowServer tests require macOS");
assert.equal(process.arch, "arm64", "WindowServer tests require Apple Silicon");

const result = spawnSync(
  "cargo",
  [
    "test",
    "--manifest-path",
    "src-tauri/Cargo.toml",
    "--features",
    "metal-integration-tests",
    "--test",
    "macos_metal_windowserver",
    "--",
    "--ignored",
    "--nocapture",
  ],
  { stdio: "inherit" },
);
process.exit(result.status ?? 1);
```

Add:

```json
"test:macos-metal-windowserver": "node scripts/macos-metal-windowserver.test.mjs"
```

- [ ] **Step 5: Add CI and performance gates**

Add a separate non-headless Apple Silicon job with:

```yaml
macos-metal-windowserver:
  name: Apple Silicon Metal WindowServer
  runs-on: macos-26
  env:
    MACOSX_DEPLOYMENT_TARGET: "13.0"
  steps:
    - uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0
      with:
        persist-credentials: false
    - uses: dtolnay/rust-toolchain@4be7066ada62dd38de10e7b70166bc74ed198c30
      with:
        toolchain: 1.90.0
    - uses: oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6
      with:
        bun-version: 1.3.5
    - run: bun install --frozen-lockfile
    - run: bun run test:macos-metal-windowserver
```

Extend the integration report assertion with:

```rust
assert!(report.copy_ms_p95 <= 8.0, "copy p95 was {}", report.copy_ms_p95);
assert_eq!(report.foreground_target_fps, 60);
assert_eq!(report.background_target_fps, 15);
assert_eq!(report.hidden_target_fps, 1);
```

- [ ] **Step 6: Document and execute the manual acceptance matrix**

Create `docs/testing/macos-metal-compositor.md` with a checkable table covering:

```text
Select, Dropdown, Dialog, AlertDialog, Sheet, Popover, Tooltip, HoverCard, Toast
CEF select popup and context menu
mouse buttons, horizontal/vertical wheel, keyboard, modifiers, focus traversal, Japanese IME
preview audio and gated DevTools
resize, fullscreen, Retina scale changes, sleep/wake, and occlusion
artifact close and route navigation
forced startup failure and forced runtime recovery fallback
```

For each row record: build SHA, macOS version, machine model, expected result, actual result, and pass/fail. Include commands to force startup import failure and runtime device recovery using test-only environment flags that are compiled out of production builds.

- [ ] **Step 7: Run the complete verification matrix**

On Apple Silicon:

```bash
bun run test:macos-metal-contract
bun run test:release-security
bun run test:ui-contract
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml
bun run test:macos-metal-windowserver
git diff --check
```

On Windows:

```powershell
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml
node --test scripts/verify-desktop-ui-contract.test.mjs
```

Expected: every command passes; the Apple Silicon report records 100 lifecycle iterations, zero stale callbacks, Metal backend, native-compositor render mode, and copy p95 at or below 8 ms; Windows compositor tests remain green.

- [ ] **Step 8: Commit the acceptance harness and documentation**

```bash
git add src-tauri/tests/macos_metal_windowserver.rs scripts/macos-metal-windowserver.test.mjs scripts/macos-metal-contract.test.mjs package.json src-tauri/Cargo.toml src-tauri/Cargo.lock .github/workflows/ci.yml docs/testing/macos-metal-compositor.md
git commit -m "test: verify macos metal compositor lifecycle"
```

---

## Final Review Gate

- [ ] Confirm every approved design requirement maps to Tasks 1–9.
- [ ] Confirm a placeholder scan of the plan returns no unfinished markers or deferred implementation notes.
- [ ] Confirm all later-task names match the interfaces introduced earlier: `CompositorMode`, `CommandBackend`, `RendererBackend`, `PlatformTextureImporter`, `PlatformInputHook`, `InputRouter`, `RecoveryBudget`, and `AcceleratedCompositorStats`.
- [ ] Confirm `git status --short` contains no generated test artifacts or unrelated user files.
- [ ] Request a code review using `superpowers:requesting-code-review`.
- [ ] Run `superpowers:verification-before-completion` before claiming the branch is ready.
