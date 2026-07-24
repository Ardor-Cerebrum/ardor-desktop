# macOS Metal Sidebar Compositor Design

**Status:** Approved

**Date:** 2026-07-23

## Objective

Replace the macOS native-child preview layering path with a full CEF offscreen compositor matching the Windows architecture. Both the Ardor shell and artifact preview render into CEF OSR surfaces, and one WGPU surface backed by Metal composes them in this order:

1. artifact preview;
2. shell regions outside the preview;
3. shell regions occupied by Radix overlays.

This removes visual `NSView` cutout masks from the primary macOS path and makes shell overlays, preview rendering, and input routing follow the same model as Windows.

## Supported Platform

- Apple Silicon only: `aarch64-apple-darwin`.
- Minimum supported operating system: macOS 13 Ventura.
- Intel macOS and universal binaries are outside this design.
- The existing Windows D3D12 compositor remains supported and must retain its current behavior.

## Success Criteria

The Metal path is complete only when it reaches functional parity with the Windows compositor:

- shell and preview are both CEF OSR webviews;
- Radix overlays render and receive input above the preview without visual masks;
- mouse, keyboard, modifiers, wheel, focus traversal, and IME input are routed correctly;
- CEF select popups and context menus use correct screen coordinates;
- audio and DevTools retain their existing behavior and security gates;
- window resize, Retina scale changes, sleep/wake, navigation, and teardown are stable;
- closing an artifact or leaving its page does not leave stale browser or AppKit callbacks;
- foreground rendering targets 60 FPS, background rendering 15 FPS, and hidden rendering 1 FPS;
- frame-import latency on Apple Silicon targets a p95 of at most 8 ms;
- GPU mode never silently switches to CPU-frame rendering.

## Non-goals

- Intel Mac support.
- A native Metal renderer that duplicates the WGPU pipelines.
- Changes to the frontend overlay registration contract.
- Accessibility behavior beyond parity with the existing Windows CEF OSR shell.
- Removal of the current native-child implementation; it remains the macOS fallback.

## Architecture

### Shared compositor

The existing Windows compositor is split into a platform-neutral core plus platform adapters. The shared core owns:

- shell and preview CEF OSR webviews;
- preview generation and navigation lifecycle;
- logical and physical layout state;
- overlay rectangles;
- render scheduling and activity rates;
- owned shell and preview GPU textures;
- the common WGPU ingest and presentation pipelines;
- rendering statistics and recovery health checks;
- input target selection.

The shared presentation pass preserves the existing Windows order:

1. draw the preview texture inside the preview rectangle;
2. draw the shell texture outside the preview rectangle;
3. draw the shell texture again inside every registered overlay rectangle.

The compositor does not understand Radix components. It consumes the existing overlay rectangle contract supplied by `solutions-ui`.

### Platform adapters

Platform-specific code is limited to four boundaries:

1. importing callback-scoped CEF GPU frames;
2. selecting and creating a compatible GPU device;
3. receiving native window input and converting it to CEF events;
4. calculating physical screen origins for CEF OSR popups.

The intended module boundaries are:

```text
sidebar_browser/
  gpu_compositor/
    mod.rs
    common.rs
    renderer.rs
    scheduler.rs
    texture_import/
      mod.rs
      windows.rs
      macos.rs
    input/
      mod.rs
      windows.rs
      macos.rs
```

The exact file split may be adjusted during implementation if the public boundaries remain equivalent and each module retains one responsibility.

### macOS GPU backend

The macOS backend creates a WGPU instance restricted to the Metal backend and presents to one compositor window. The window contains no native CEF preview child. CEF shell and preview browsers are created windowless with accelerated shared textures enabled.

The macOS texture importer treats the CEF shared texture handle as an `IOSurfaceRef`:

1. reject null handles, zero dimensions, unsupported formats, and dimensions that disagree with CEF metadata;
2. retain the IOSurface for the duration of the import operation;
3. create a plane-zero `MTLTexture` with a matching pixel format and dimensions;
4. expose the Metal texture to WGPU inside one isolated unsafe importer boundary;
5. copy it into a compositor-owned WGPU texture before the CEF accelerated-paint callback returns;
6. release all imported Metal and IOSurface references after the copy completes.

No CEF-owned IOSurface or Metal texture may survive the callback. A timed-out copy is dropped and recorded instead of being used later.

The WGPU adapter and the `MTLDevice` used to create the imported texture must identify the same Apple GPU. A mismatch aborts GPU startup or triggers recovery rather than performing a cross-device copy.

## Startup and Mode State

`AcceleratedCompositorState` becomes available on Windows and macOS. macOS tracks one of these states:

```text
BootstrapVisible
  -> StartingGpu
  -> GpuActive
  -> RecoveringGpu
  -> GpuActive

StartingGpu   -> NativeFallback
RecoveringGpu -> NativeFallback
Any state     -> Closing
```

The bootstrap `main` webview remains visible while the GPU compositor starts. It is hidden only after the first valid shell frame has been imported and presented.

Unlike the current Windows startup, macOS retains the hidden bootstrap webview after cutover so a fatal GPU failure can restore a usable application shell. A fallback transition is session-wide: GPU shell and preview are both closed before native mode is enabled. The application never runs a Metal shell with an `NSView` preview or any other mixed rendering mode.

Sidebar-browser commands consult the active compositor mode:

- `GpuActive` routes open, layout, control, input, and close operations to the OSR compositor;
- `NativeFallback` uses the existing macOS child-webview and `PreviewHost` path;
- stale generations continue to be ignored.

## Frame Flow

CEF accelerated-paint callbacks arrive independently for shell and preview. Each valid callback performs the following flow:

```text
CEF IOSurface
  -> validate metadata and format
  -> create MTLTexture
  -> wrap/import for WGPU
  -> copy into owned layer texture
  -> release callback-scoped resources
  -> request coalesced present
```

The renderer stores only owned layer textures. Rapid shell and preview callbacks are coalesced so one display update does not produce redundant presents.

Resize and scale changes update the following values as one layout transaction:

- WGPU surface dimensions;
- shell OSR bounds;
- preview OSR bounds;
- logical-to-physical scale;
- preview rectangle;
- overlay rectangles;
- popup screen origins;
- input coordinate conversion.

The renderer must never present a layout assembled from different scale generations.

## Input and Popup Routing

macOS installs one transparent, full-window `CompositorInputView`. It has no visual mask and does not correspond to the preview rectangle. It becomes the window's first responder and owns native event forwarding for:

- mouse movement, enter, leave, button down/up, and click counts;
- vertical and horizontal scrolling;
- key down/up and modifier changes;
- focus gain/loss and focus traversal;
- text composition through `NSTextInputClient`;
- cursor updates.

The shared input router receives logical window coordinates. It targets preview only when all of the following are true:

- preview is visible;
- the point lies inside the preview rectangle;
- the point does not lie inside a shell overlay rectangle.

Every other point targets the shell. Preview-targeted coordinates are translated into preview-local coordinates before producing CEF events.

Focus is exclusive: shell and preview cannot both be focused. Focus changes call CEF's offscreen focus API before keyboard or IME events are forwarded.

CEF popup frames, including HTML select popups, are composed into the owning OSR surface by the runtime. Native context menus receive physical screen origins derived from the compositor window, preview offset, and Retina scale.

Preview audio continues to use Chromium's native audio output. DevTools remain available only when the existing desktop production gate allows them.

## Teardown

Teardown follows a strict ownership order:

1. mark the compositor session closing and reject new generation work;
2. detach the `CompositorInputView` from its router;
3. clear shell and preview paint callbacks;
4. stop the present scheduler;
5. close preview and shell CEF browsers with forced asynchronous close;
6. wait for CEF browser-close bookkeeping;
7. release owned WGPU textures and imported-resource state;
8. destroy the WGPU surface and compositor window.

No native input callback, IOSurface callback, or present request may retain the session after step 4.

## Failure and Recovery

### Before GPU cutover

Any Metal device, WGPU surface, IOSurface import, first-frame, or startup timeout failure closes the partial GPU session and enters `NativeFallback`. The bootstrap webview remains visible throughout this transition.

### After GPU cutover

Recovery is attempted in this order:

1. an outdated, lost, or occluded WGPU surface is reconfigured and both CEF layers are invalidated;
2. Metal device loss or repeated import failure triggers one complete compositor-session restart;
3. a failed or unhealthy restart closes GPU mode and enters `NativeFallback`.

Fatal mid-session fallback may reset transient frontend state because the hidden bootstrap shell becomes active. Durable application data must remain available. This trade-off is accepted in preference to a blank, frozen, or crashing window.

Diagnostics record:

- active backend and final mode;
- shell, preview, and present FPS;
- import and present counts;
- copy latency, including p50 and p95;
- dropped and coalesced frames;
- surface and device recovery counts;
- last startup, import, or present error.

## Security

The Metal path does not expand preview privileges:

- preview navigation remains restricted to public HTTPS destinations;
- downloads and new windows retain their current policy;
- preview device APIs retain the defense-in-depth initialization script;
- shell-only Tauri commands remain unavailable to preview labels;
- DevTools remain disabled in production unless explicitly enabled by the existing gate;
- fallback mode uses the same generation and caller validation as GPU mode.

## Testing

### Cross-platform unit tests

- shell regions cover only the area outside the preview;
- overlay regions are drawn after preview;
- logical-to-physical conversion is stable across Retina scales;
- input selects shell for overlay points and preview for unobscured preview points;
- stale generations and invalid layouts are rejected;
- activity policies remain 60/15/1 FPS.

### macOS unit tests

- IOSurface null, dimensions, plane, and pixel formats are validated;
- importer ownership releases resources on success, timeout, and error;
- WGPU adapter and Metal device identity must match;
- `NSEvent` mouse, wheel, key, modifiers, focus, and IME data map to expected CEF events;
- popup screen origins account for preview offset and Retina scale;
- startup and recovery state transitions never produce mixed mode.

### macOS integration tests

A WindowServer-backed integration harness creates synthetic shell and preview OSR surfaces, moves an overlay across the preview, and verifies GPU readback for the expected composition order.

A lifecycle stress test performs at least 100 iterations of:

```text
open -> navigate -> resize -> scale/layout update -> close
```

The test fails on stale callbacks, retained generations, unexpected mode mixing, browser-close timeout, or compositor errors.

### Manual acceptance matrix

- Select, Dropdown, Dialog, AlertDialog, Sheet, Popover, Tooltip, HoverCard, and Toast;
- CEF select popup and context menu;
- mouse, all supported buttons, wheel, keyboard, modifiers, focus traversal, and IME;
- preview audio and DevTools;
- resize, fullscreen, Retina scale changes, sleep/wake, and occlusion;
- artifact close and route navigation;
- forced Metal startup failure and runtime recovery fallback.

### CI and performance

- Existing macOS `cargo fmt`, `cargo clippy`, and `cargo test` checks remain mandatory.
- The release job must compile the Apple Silicon Metal compositor with minimum system version 13.0.
- WindowServer-dependent integration tests remain separate from headless unit tests.
- Foreground target: 60 FPS.
- Background target: 15 FPS.
- Hidden target: 1 FPS.
- Apple Silicon frame-import p95 target: at most 8 ms.
- GPU mode must report Metal and must not report `CpuFrame`.

## Rollout

The native-child path remains compiled as a fallback until Metal startup, recovery, and lifecycle telemetry are proven stable in production. Removing it requires a separate decision and is not part of this work.
