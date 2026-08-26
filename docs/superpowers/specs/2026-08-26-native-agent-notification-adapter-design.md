# Native Agent Notification Adapter Design

## Summary

Add a native Electron notification adapter for agent completion and action-required events while preserving the existing browser and Service Worker delivery paths. The lifecycle follows Codex desktop behavior: closing the main window keeps Ardor running in the background, while an explicit Quit fully terminates the application and notification delivery.

The implementation spans `ardor-desktop` and `solutions-ui`. It does not require backend changes, polling, a background daemon, or a second event subscription.

## Goals

- Show native operating-system banners when Ardor Desktop is running but its window is hidden or unfocused.
- Restore the existing window and open the originating chat when a banner is clicked.
- Reuse the existing notification preferences, event classification, attention state, tab coordination, and custom audio playback.
- Keep browser notifications and Service Worker Web Push unchanged.
- Avoid duplicate banners and duplicate sounds.
- Expose structured capability and delivery failures to the notification settings UI.
- Maintain strict renderer isolation and bounded IPC payloads.

## Non-goals

- Deliver notifications after the user explicitly quits Ardor.
- Add a daemon, startup service, polling loop, or new backend subscription.
- Move agent event processing or authentication into the Electron main process.
- Play notification audio from the operating-system banner.
- Replace browser Web Push or change backend notification APIs.

## Lifecycle

| State | Expected behavior |
| --- | --- |
| Window focused | Existing preference policy decides whether to play sound or show a banner. |
| Window unfocused | Native banner is available according to `bannerMode`; custom audio remains renderer-owned. |
| Window closed | The window is hidden rather than destroyed, preserving the renderer event stream and notification coordinator. |
| Banner clicked | The hidden window is restored, focused, and navigated to the originating chat. |
| Explicit Quit | The normal shutdown path destroys the window and terminates notification delivery. |
| Renderer crash | Delivery is unavailable until the renderer recovers; no daemon or polling fallback is introduced. |

Windows exposes a tray menu with `Open Ardor` and `Quit`. macOS keeps the normal Dock application lifecycle while retaining the hidden renderer window required for event delivery.

## Architecture

### Solutions UI

The existing agent notification coordinator remains the only component that consumes agent events and resolves user preferences. Banner delivery is expressed through a small adapter interface selected at runtime:

- Browser runtime: current `Notification` and Service Worker behavior.
- Electron runtime with the `notifications` preload capability: native desktop adapter through `window.ardorDesktop.notifications`.

The desktop adapter registers one open-event listener for the active coordinator and sends one IPC request per banner. The renderer audio player remains the only audio source, including custom sounds and volume control.

### Preload bridge

The isolated preload exposes a frozen `notifications` capability:

- `getStatus()` returns support and availability information.
- `show(payload)` requests a native banner and returns a structured result.
- `onOpened(handler)` reports the validated `sessionId` selected from a native banner.

The bridge contains no generic IPC escape hatch and accepts no arbitrary paths or URLs.

### Electron main process

A focused notification controller owns Electron `Notification` instances and deduplication tags. It:

- validates and normalizes every request;
- creates silent native banners;
- replaces an existing banner with the same tag;
- restores and focuses the main window on click;
- emits only the originating `sessionId` to the trusted renderer;
- contains notification failures without affecting agent execution or the renderer stream.

The main window lifecycle controller distinguishes ordinary close from explicit quit. Ordinary close hides the existing window. Tray or Dock activation restores it. Explicit Quit sets a quit flag and follows the existing shutdown path.

## Contracts

The renderer-to-main payload contains only:

- `sessionId`: a bounded, non-empty identifier;
- `title`: bounded display text derived from the chat title, with `Ardor` fallback;
- `body`: one of the existing English completion/action-required messages;
- `kind`: `success` or `action_required`;
- `tag`: a deterministic bounded key derived from session and run identity.

The result is one of:

- `shown`;
- `unsupported`;
- `denied`;
- `failed` with a stable, user-safe error code.

The main-to-renderer open event contains only the validated `sessionId`. The pinned desktop UI contract requires the top-level `notifications` capability, while runtime method checks let older desktop shells and browser builds fail closed.

## Delivery flow

1. The existing coordinator receives and deduplicates an agent notification candidate.
2. The existing delivery policy resolves sound and banner behavior from preferences and focus state.
3. The renderer plays the configured sound once when allowed.
4. In Electron, the native adapter requests a silent banner. In the browser, the existing banner or Web Push fallback runs unchanged.
5. Electron main validates the request, replaces any banner with the same tag, and shows it.
6. On click, Electron restores and focuses the main window, then emits the `sessionId`.
7. The coordinator's existing `onOpenSession` callback selects the correct chat and attention state is cleared by the existing path.

## Error handling and settings

- Unsupported native notifications are reported as `unsupported`, not thrown through the coordinator.
- Permission denial is reported as `denied` with desktop-specific settings guidance.
- Construction and display failures return a stable `failed` result and are logged without sensitive payload text.
- Clicking a stale notification after shutdown is a no-op.
- The settings test action uses the runtime-selected adapter and shows its structured result.
- Browser permission primer copy remains browser-specific; Electron uses native capability/status copy.
- Native banners are always silent to prevent a second operating-system sound after Ardor's configured sound.

## Security and privacy

- Existing trusted-shell sender validation applies to all notification IPC requests.
- Payload parsing rejects unknown kinds, malformed identifiers, oversized strings, and unexpected object properties.
- No account IDs, tokens, message contents, workspace paths, or arbitrary navigation URLs cross the notification bridge.
- The click path emits a session identifier instead of accepting a renderer-provided URL.
- Logs contain stable error codes and identifiers only where already allowed; banner title and body are not logged.

## Performance

- No polling, timers for delivery, daemon, background network connection, or duplicate event subscription is added.
- The hidden renderer reuses the existing event stream and coordinator.
- Main process state is limited to active notification instances keyed by bounded tags.
- Notification instances are removed from the map on close, failure, replacement, or shutdown.
- Tray resources are created once and disposed during the normal quit path.

## Testing

### Solutions UI

- Runtime adapter selection for browser, supported Electron, and older Electron shells.
- Structured `show` results and open-event unsubscribe behavior.
- Coordinator uses native banners in Electron without invoking browser `Notification` or Service Worker APIs.
- One Ardor sound is played and the native request remains silent.
- Click/open events select the originating session.
- Settings preview reports unsupported, denied, and failed states.

### Ardor Desktop

- Payload parser boundary and rejection tests.
- Notification controller support, deduplication, cleanup, failure, and click tests.
- Preload bridge channel and frozen API contract tests.
- Trusted sender enforcement.
- Close-to-hide, restore, tray Open, tray Quit, and explicit-quit lifecycle tests.
- Runtime capability contract update.
- Electron type-check, shell contract, package smoke, Windows package build, and a visible runtime smoke.

## Delivery order

1. Add the typed Electron contract, notification controller, window lifecycle, and tests in `ardor-desktop`.
2. Add the runtime-selected adapter and coordinator/settings integration in `solutions-ui`.
3. Validate `solutions-ui` against the desktop contract and build a desktop package using the UI feature SHA.
4. Merge `solutions-ui`, then update the immutable `solutionsUiRef` in a reviewed desktop commit before release.

Both repositories use the existing ARD-2622 feature branch naming. The web and desktop PRs remain independently reviewable, and older shells continue using the browser-safe unsupported path.
