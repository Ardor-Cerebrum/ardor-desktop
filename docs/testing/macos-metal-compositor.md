# macOS Metal compositor acceptance

Run this matrix on an Apple Silicon Mac with an interactive WindowServer
session. The automated probe verifies the Metal backend, production compositor
shader and pass order, representative output pixels, 100 lifecycle iterations,
real CEF close acknowledgements, callback generation gating, mode exclusivity,
frame-rate policy, and production IOSurface ingest-copy p95.

## Automated gate

```bash
bun install --frozen-lockfile
bun run test:macos-metal-contract
bun run test:macos-metal-windowserver
```

The WindowServer command must report:

- backend `macos-metal-iosurface`
- render mode `native-compositor`
- 100 completed lifecycle iterations
- zero stale callbacks, close timeouts, mixed-mode transitions, and fatal errors
- production IOSurface ingest-copy p95 no greater than 8 ms
- foreground/background/hidden targets of 60/15/1 FPS

## Manual record

Fill the build and machine fields once per acceptance run. Do not mark a row as
passing without observing it on the stated build.

| Done | Area | Scenario | Build SHA | macOS | Machine | Expected | Actual | Result |
|---|---|---|---|---|---|---|---|---|
| [ ] | Radix overlay | Select and Dropdown above preview | — | — | — | Overlay is fully visible and clickable | Not run | — |
| [ ] | Radix overlay | Dialog, AlertDialog, and Sheet above preview | — | — | — | Modal paints above preview; focus remains trapped | Not run | — |
| [ ] | Radix overlay | Popover, Tooltip, HoverCard, and Toast above preview | — | — | — | Content is not clipped or hidden by preview | Not run | — |
| [ ] | CEF popup | Native select popup and CEF context menu | — | — | — | Popup origin follows preview on Retina and resize | Not run | — |
| [ ] | Pointer | Primary/secondary buttons and horizontal/vertical wheel | — | — | — | Events reach the visually topmost shell/preview region | Not run | — |
| [ ] | Keyboard | Text, modifiers, focus traversal, shortcuts | — | — | — | Command/Option/Control/Shift and focus match macOS | Not run | — |
| [ ] | IME | Japanese IME set, update, commit, cancel | — | — | — | Composition text and caret remain synchronized | Not run | — |
| [ ] | Media | Preview audio | — | — | — | Chromium native audio remains audible | Not run | — |
| [ ] | Diagnostics | Gated DevTools | — | — | — | Available only in debug/stage or explicit opt-in | Not run | — |
| [ ] | Window | Resize, fullscreen, Retina scale change | — | — | — | Shell, preview, hit testing, and popups share one layout | Not run | — |
| [ ] | Power | Sleep/wake and occlusion | — | — | — | Surface recovers without mixed compositor modes | Not run | — |
| [ ] | Lifecycle | Artifact close and route navigation | — | — | — | No crash, stale callback, orphan window, or close timeout | Not run | — |
| [ ] | Recovery | Forced startup failure | — | — | — | Bootstrap returns and native fallback owns the session | Not run | — |
| [ ] | Recovery | Forced runtime recovery fallback | — | — | — | One GPU restart is attempted, then native fallback wins | Not run | — |

## Test-only failure injection

Failure injection is compiled only when `metal-integration-tests` is enabled;
production builds do not contain these branches.

```bash
ARDOR_TEST_METAL_STARTUP_FAILURE=1 \
  cargo run --manifest-path src-tauri/Cargo.toml \
  --features metal-integration-tests

ARDOR_TEST_METAL_RUNTIME_RECOVERY=1 \
  cargo run --manifest-path src-tauri/Cargo.toml \
  --features metal-integration-tests
```

For startup failure, confirm `NativeFallback`, a visible bootstrap window, and
no compositor child windows. For runtime recovery, confirm exactly one session
restart followed by `NativeFallback`, with no GPU callbacks after teardown.
