# Native Agent Notification Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver silent native operating-system banners from Ardor Desktop while the application is running in the background, restore the existing window, and open the originating chat when a banner is clicked.

**Architecture:** `solutions-ui` keeps ownership of agent events, preferences, attention state, and audio. A typed preload capability sends bounded notification payloads to an Electron main-process controller; the controller validates, deduplicates, displays, and reports clicks back as session IDs. Closing the window hides it, while explicit Quit preserves the existing persistence and shutdown path.

**Tech Stack:** Electron `Notification`/`Tray`, TypeScript, context-isolated IPC, React 19, Vitest/Bun test, Electron Forge.

## Global Constraints

- Browser `Notification` and Service Worker Web Push behavior must remain unchanged.
- Native banners must be silent; the renderer audio player is the only sound source.
- Closing the main window keeps Ardor running; explicit Quit terminates it.
- No daemon, polling, additional backend endpoint, or duplicate event subscription.
- IPC accepts no arbitrary paths, URLs, tokens, account IDs, or message content.
- Older desktop shells and browser builds must fail closed.
- Use the existing `feature/ard-2622-add-configurable-web-notifications-for-agent-run-outcomes` branch in both repositories.

---

### Task 1: Add the native notification contract and controller

**Files:**
- Create: `electron/notification-controller.ts`
- Test: `electron/notification-controller.test.ts`
- Modify: `electron/bridge-contract.ts`

**Interfaces:**
- Produces: `DesktopNotificationPayload`, `DesktopNotificationStatus`, `DesktopNotificationResult`, `parseDesktopNotificationPayload(value)`, and `DesktopNotificationController`.
- Consumes: a factory compatible with Electron `Notification`, a `focusWindow()` callback, and an `emitOpened(sessionId)` callback.

- [ ] **Step 1: Write failing parser and controller tests**

Cover a valid payload, unknown properties, invalid kinds, blank/oversized identifiers, unsupported/denied status, silent construction, same-tag replacement, cleanup on close/failure, and click focus/open behavior. Use this contract in the test:

```ts
const payload = {
  body: "The agent has finished the task.",
  kind: "success",
  sessionId: "session-1",
  tag: "ardor-agent:session-1:run-1",
  title: "Building Tic Tac Toe",
};
```

- [ ] **Step 2: Run the tests and verify RED**

Run: `bun test electron/notification-controller.test.ts`

Expected: FAIL because `notification-controller.ts` and its exported contract do not exist.

- [ ] **Step 3: Add bridge types and bounded parsing**

Add these types to `electron/bridge-contract.ts` and the new controller module:

```ts
export type DesktopNotificationKind = "success" | "action_required";

export interface DesktopNotificationPayload {
  body: string;
  kind: DesktopNotificationKind;
  sessionId: string;
  tag: string;
  title: string;
}

export type DesktopNotificationStatus =
  | { status: "ready" }
  | { status: "unsupported"; message: string }
  | { status: "denied"; message: string };

export type DesktopNotificationResult =
  | { status: "shown" }
  | { status: "unsupported" | "denied" | "failed"; message: string };
```

`parseDesktopNotificationPayload` must require exactly the five keys above, accept only the two kinds, cap `sessionId` at 256 code units, `tag` at 512, `title` at 160, and `body` at 240, and reject malformed Unicode with the existing `isWellFormedString` helper.

- [ ] **Step 4: Implement the focused controller**

```ts
export class DesktopNotificationController {
  private readonly active = new Map<string, NativeNotification>();

  getStatus(): DesktopNotificationStatus;
  show(value: unknown): DesktopNotificationResult;
  dispose(): void;
}
```

`show` must parse first, close/replace an existing tag, construct `{ title, body, silent: true }`, install `click`, `close`, and `failed` handlers before `show()`, and never log title/body. `click` calls `focusWindow()` and emits the payload `sessionId`. All construction/show exceptions return `{ status: "failed", message: "System notification could not be shown." }`.

- [ ] **Step 5: Run focused tests and static checks**

Run:

```bash
bun test electron/notification-controller.test.ts
bun run electron:type-check
```

Expected: all controller tests pass and TypeScript exits 0.

- [ ] **Step 6: Commit the controller slice**

```bash
git add electron/bridge-contract.ts electron/notification-controller.ts electron/notification-controller.test.ts
git commit -m "feat(ARD-2622): add native notification controller"
```

### Task 2: Expose the preload capability and wire Electron main

**Files:**
- Modify: `electron/bridge-contract.ts`
- Modify: `electron/preload.ts`
- Modify: `electron/main.ts`
- Test: `electron/bridge-contract.test.ts`
- Test: `electron/preload.test.ts`
- Test: `scripts/verify-desktop-ui-contract.test.mjs`

**Interfaces:**
- Consumes: `DesktopNotificationController` from Task 1.
- Produces: the pinned top-level `window.ardorDesktop.notifications` capability with `.getStatus()`, `.show(payload)`, and `.onOpened(handler)`.

- [ ] **Step 1: Add failing channel and preload contract tests**

Require these channels:

```ts
"desktop:notifications:get-status"
"desktop:notifications:show"
"desktop:notifications:opened"
```

Require a frozen `notifications` object that invokes only the two request channels and subscribes only to `desktop:notifications:opened`. Extend the desktop UI verifier fixture so `notifications` is a required bridge capability.

- [ ] **Step 2: Run the contract tests and verify RED**

Run:

```bash
bun test electron/bridge-contract.test.ts electron/preload.test.ts scripts/verify-desktop-ui-contract.test.mjs
```

Expected: FAIL because the notification channels/capability are absent.

- [ ] **Step 3: Extend the typed bridge**

Expose this exact shape from `electron/preload.ts` and the corresponding `ArdorDesktopBridge` type:

```ts
notifications: Object.freeze({
  getStatus: () => invoke<DesktopNotificationStatus>("desktop:notifications:get-status"),
  show: (payload: DesktopNotificationPayload) =>
    invoke<DesktopNotificationResult>("desktop:notifications:show", payload),
  onOpened: (handler: (sessionId: string) => void) =>
    subscribe<string>("desktop:notifications:opened", handler),
}),
```

- [ ] **Step 4: Wire the main-process controller**

Create one controller after the main window exists. Use Electron `Notification.isSupported()`, native notification construction, `focusMainWindow()`, and:

```ts
mainWindow?.webContents.send("desktop:notifications:opened", sessionId);
```

Register trusted handlers for `get-status` and `show`, and dispose active notifications during quit. Do not change `desktop-ui-requirements.json` yet: adding a required capability while its existing `solutionsUiRef` still points to an older UI would make the pinned contract internally inconsistent.

- [ ] **Step 5: Run focused bridge/controller tests**

Run:

```bash
bun test electron/notification-controller.test.ts electron/bridge-contract.test.ts electron/preload.test.ts scripts/verify-desktop-ui-contract.test.mjs
bun run electron:type-check
```

Expected: all tests pass and TypeScript exits 0.

- [ ] **Step 6: Commit the bridge slice**

```bash
git add electron/bridge-contract.ts electron/preload.ts electron/main.ts electron/bridge-contract.test.ts electron/preload.test.ts scripts/verify-desktop-ui-contract.test.mjs
git commit -m "feat(ARD-2622): expose native notification bridge"
```

### Task 3: Keep the desktop renderer alive after window close

**Files:**
- Create: `electron/background-window-lifecycle.ts`
- Test: `electron/background-window-lifecycle.test.ts`
- Modify: `electron/main.ts`

**Interfaces:**
- Produces: `createBackgroundWindowLifecycle(options)` with `handleClose(event)`, `restore()`, `markQuitting()`, and `dispose()`.
- Consumes: existing `focusMainWindow`, `flushBrowserPersistentData`, and normal `before-quit` shutdown.

- [ ] **Step 1: Write failing lifecycle tests**

Cover close prevention plus hide, no destroy/persistence flush on ordinary close, restore from hidden/minimized states, explicit quit bypass, activation restore, and disposal. Assert that existing browser/terminal persistence still happens in `before-quit`, not ordinary close.

- [ ] **Step 2: Run the lifecycle tests and verify RED**

Run: `bun test electron/background-window-lifecycle.test.ts`

Expected: FAIL because the lifecycle module does not exist.

- [ ] **Step 3: Implement close-to-hide lifecycle**

```ts
export interface BackgroundWindowLifecycle {
  dispose(): void;
  markQuitting(): void;
  restore(): boolean;
}
```

Attach one `close` listener. Before quitting it calls `event.preventDefault()` and `window.hide()` without destroying the renderer or native pane controllers. After `markQuitting()`, close is allowed through unchanged. `restore()` delegates to the existing focus helper.

- [ ] **Step 4: Add the Windows tray and macOS activation behavior**

Create one Windows tray using `assets/icons/<channel>/icon.ico`, with `Open Ardor` calling `restore()` and `Quit` calling `app.quit()`. On macOS `activate` restores the hidden window. Destroy the tray only during explicit shutdown. Do not add a Linux daemon or autostart behavior.

- [ ] **Step 5: Run lifecycle and existing shell tests**

Run:

```bash
bun test electron/background-window-lifecycle.test.ts electron/focus-main-window.test.ts electron/main-window-startup.test.ts
bun run electron:type-check
bun run test:electron-shell-contract
```

Expected: all tests pass; shell contract remains green.

- [ ] **Step 6: Commit the lifecycle slice**

```bash
git add electron/background-window-lifecycle.ts electron/background-window-lifecycle.test.ts electron/main.ts
git commit -m "feat(ARD-2622): keep desktop active after window close"
```

### Task 4: Add the Solutions UI native banner adapter

**Files:**
- Create: `src/features/agent-notifications/desktop-banner.ts`
- Test: `src/features/agent-notifications/desktop-banner.test.ts`
- Modify: `src/lib/desktop-bridge.ts`
- Test: `src/lib/desktop-bridge.test.ts`

**Interfaces:**
- Consumes: the preload `notifications` contract from Task 2.
- Produces: `createDesktopBannerAdapter({ bridge, onOpenSession })`, `supportsDesktopNotifications()`, `readDesktopNotificationPermission()`, and `DesktopBannerAdapter`.

- [ ] **Step 1: Write failing adapter and bridge tests**

Cover supported/older shells, safe status mapping, payload generation, the exact English body copy, deterministic tag, structured failure, open-event routing, unsubscribe, and no browser `Notification` use.

- [ ] **Step 2: Run the tests and verify RED**

Run:

```bash
VITE_API_URL=http://localhost VITE_AUTH0_DOMAIN=example.auth0.com VITE_AUTH0_CLIENT_ID=test-client bunx --bun vitest run src/features/agent-notifications/desktop-banner.test.ts src/lib/desktop-bridge.test.ts
```

Expected: FAIL because the bridge capability and adapter are absent.

- [ ] **Step 3: Extend the UI bridge types**

Add the typed `notifications` methods matching Task 2. Capability detection must check method presence so older shells return unsupported without invoking IPC; the coordinated desktop release pin requires `notifications` as a top-level bridge capability.

- [ ] **Step 4: Implement the adapter**

```ts
export interface DesktopBannerAdapter {
  dispose(): Promise<void>;
  getStatus(): Promise<DesktopNotificationStatus>;
  sendTest(): Promise<DesktopNotificationResult>;
  show(candidate: DesktopBannerCandidate): Promise<DesktopNotificationResult>;
}
```

Subscribe once to `onOpened`, route only non-empty session IDs to `onOpenSession`, use `Ardor` when the title is blank, and generate `ardor-agent:<sessionId>:<runId>` tags. `sendTest()` uses session/tag values reserved for settings and the success copy.

- [ ] **Step 5: Run adapter tests and type-check**

Run:

```bash
VITE_API_URL=http://localhost VITE_AUTH0_DOMAIN=example.auth0.com VITE_AUTH0_CLIENT_ID=test-client bunx --bun vitest run src/features/agent-notifications/desktop-banner.test.ts src/lib/desktop-bridge.test.ts
bun run type-check
```

Expected: all tests pass and TypeScript exits 0.

- [ ] **Step 6: Commit the adapter slice**

```bash
git add src/features/agent-notifications/desktop-banner.ts src/features/agent-notifications/desktop-banner.test.ts src/lib/desktop-bridge.ts src/lib/desktop-bridge.test.ts
git commit -m "feat(notifications): add Electron banner adapter"
```

### Task 5: Select native delivery in the coordinator and settings

**Files:**
- Modify: `src/features/agent-notifications/agent-notification-coordinator.tsx`
- Test: `src/features/agent-notifications/agent-notification-coordinator.test.tsx`
- Modify: `src/features/settings/notifications/index.tsx`
- Test: `src/features/settings/notifications/notifications-settings.test.tsx`
- Modify: `src/features/agent-notifications/permission-primer.tsx`
- Test: `src/features/agent-notifications/permission-primer.test.tsx`

**Interfaces:**
- Consumes: `DesktopBannerAdapter` from Task 4 and the existing browser/Web Push adapters.
- Produces: runtime-selected banner delivery and desktop-specific settings health/test behavior.

- [ ] **Step 1: Add failing coordinator tests**

Assert that Electron delivery:

- calls the desktop adapter instead of `showBrowserBanner`;
- does not wait for a Service Worker receipt;
- still calls the existing audio player exactly once;
- disposes the desktop open listener;
- routes a native open event through the existing `onOpenSession` callback.

- [ ] **Step 2: Add failing settings and primer tests**

Assert that Electron settings show `System notification` status, use native `sendTest`, never call Web Push sync/request permission, keep the test-button spinner, and display structured unsupported/denied/failed messages. Assert that the browser primer remains unchanged and no primer opens in Electron.

- [ ] **Step 3: Run focused UI tests and verify RED**

Run:

```bash
VITE_API_URL=http://localhost VITE_AUTH0_DOMAIN=example.auth0.com VITE_AUTH0_CLIENT_ID=test-client bunx --bun vitest run \
  src/features/agent-notifications/agent-notification-coordinator.test.tsx \
  src/features/agent-notifications/permission-primer.test.tsx \
  src/features/settings/notifications/notifications-settings.test.tsx
```

Expected: the new Electron expectations fail against browser-only delivery.

- [ ] **Step 4: Implement runtime selection**

Create the desktop adapter only when the bridge capability exists. For desktop candidates, call it immediately when policy allows a banner; retain the current receipt grace/fallback only for browser delivery. Keep `safePlaySound` unchanged and ensure the native payload is silent in main.

- [ ] **Step 5: Implement desktop settings behavior**

Select one settings delivery adapter per runtime. Browser continues using `createWebPushAdapter`. Desktop calls native `getStatus`/`sendTest`, uses desktop-specific copy, treats ready native status as granted for policy controls, and does not render browser permission actions. All adapter cleanup runs on unmount/account change.

- [ ] **Step 6: Run focused and full UI verification**

Run:

```bash
VITE_API_URL=http://localhost VITE_AUTH0_DOMAIN=example.auth0.com VITE_AUTH0_CLIENT_ID=test-client bunx --bun vitest run \
  src/features/agent-notifications/desktop-banner.test.ts \
  src/features/agent-notifications/agent-notification-coordinator.test.tsx \
  src/features/agent-notifications/permission-primer.test.tsx \
  src/features/settings/notifications/notifications-settings.test.tsx
VITE_API_URL=http://localhost VITE_AUTH0_DOMAIN=example.auth0.com VITE_AUTH0_CLIENT_ID=test-client bun run test
bun run type-check
bun run check
```

Expected: focused and full suites pass; type-check/Biome exit 0.

- [ ] **Step 7: Commit the integration slice**

```bash
git add src/features/agent-notifications src/features/settings/notifications
git commit -m "feat(notifications): use native banners in Electron"
```

### Task 6: Cross-repository contract, package, and runtime verification

**Files:**
- Modify only after the UI commit is approved for pinning: `desktop-ui-requirements.json`
- Verify: `scripts/verify-desktop-ui-contract.mjs`
- Verify: packaged `resources/dist`

**Interfaces:**
- Consumes: final UI feature SHA and desktop native bridge.
- Produces: a desktop package proven to contain the same UI and contract.

- [ ] **Step 1: Verify the unmerged pair through a workspace snapshot**

Build the UI worktree and run the desktop contract verifier with `ARDOR_DESKTOP_UI_REQUIREMENTS_SOURCE=workspace-snapshot`. This proves the two feature branches together without weakening or prematurely changing the repository's immutable UI pin.

- [ ] **Step 2: Update the immutable UI pin only when eligible**

After the UI commit has been reviewed and is eligible for the desktop repository's immutable pin, update `solutionsUiRef` and add `notifications` to `requiredCapabilities` in the same commit. If it is not yet eligible, leave `desktop-ui-requirements.json` untouched and report that post-merge pin as the only deferred integration step.

- [ ] **Step 3: Run desktop static and behavioral verification**

Run:

```bash
bun run electron:type-check
bun test electron/notification-controller.test.ts electron/background-window-lifecycle.test.ts electron/auth/*.test.ts electron/browser/*.test.ts electron/updater.test.ts
bun run test:electron-shell-contract
bun test scripts/verify-desktop-ui-contract.test.mjs
bun run electron:build
```

Expected: all tests/builds pass.

- [ ] **Step 4: Build a Windows stage package using the UI worktree**

Run with official Node 22 first on PATH:

```bash
ARDOR_SOLUTIONS_UI_DIR=/home/warenek/projects/ardor-worktrees/solutions-ui-agent-notifications-plan \
  bun run build:windows:stage1
```

Expected: `out/Ardor Dev-win32-x64` contains the native Electron bundle and notification-enabled UI.

- [ ] **Step 5: Run package smoke**

```bash
ARDOR_ELECTRON_CHANNEL=stage1 \
ARDOR_ELECTRON_PACKAGE_DIR="$PWD/out/Ardor Dev-win32-x64" \
  bun run test:electron-package
```

Expected: all package identity/resource/smoke tests pass.

- [ ] **Step 6: Perform visible runtime smoke**

Launch the packaged Windows app from a Windows-local temporary directory. Verify sign-in/renderer load, close-to-background, tray restore, one native test banner, and click-to-chat navigation. Do not automate authentication or OS privacy settings.

- [ ] **Step 7: Commit the final desktop pin only when Step 2 is eligible**

```bash
git add desktop-ui-requirements.json
git commit -m "chore(ARD-2622): pin notification-enabled desktop UI"
```

- [ ] **Step 8: Run final diff and CI readiness checks**

In both repositories run `git diff --check origin/main`, confirm clean worktrees, then push the existing ARD-2622 branches normally without force. Wait for all UI and desktop CI checks and report web, running-background desktop, and explicit-Quit behavior separately.
