# Ardor Desktop Prototype

This is the `0.1.0` desktop prototype for running `solutions-ui` inside a local Tauri shell.

## Scope

- macOS bundle for the current prototype.
- Desktop shell, bundle metadata, icons, loopback auth callback, and Tauri IPC live in `ardor-desktop`.
- React UI and cloud-first product behavior remain in `solutions-ui`.
- Desktop-specific UI code in `solutions-ui` is guarded by `TAURI_BUILD` and runtime desktop checks.

## Local Layout

Keep both repositories as siblings:

```text
Ardor/
  ardor-desktop/
  solutions-ui/
```

The desktop repo invokes `solutions-ui` scripts and loads the built UI from `../solutions-ui/dist`.

## Auth0 Configuration

The Auth0 application must allow these desktop URLs:

- Allowed Callback URLs: `http://127.0.0.1:17631/auth/callback`
- Allowed Logout URLs: `tauri://localhost`
- Allowed Web Origins: `tauri://localhost`

The Auth0 branding logo URL must point to a reachable image. Avoid stale URLs such as `/full_2x_transparent.png` if the asset is not actually hosted.

## Build

```bash
bun install
bun run build:stage1
```

The build runs `solutions-ui` type-check, builds the UI with `TAURI_BUILD=true`, and then bundles the Tauri app.

The stage1 macOS app is produced at:

```text
src-tauri/target/release/bundle/macos/Ardor Dev.app
```

Use [build-channels.md](build-channels.md) for production build setup.

## Run

```bash
open "src-tauri/target/release/bundle/macos/Ardor Dev.app"
```

The desktop auth callback listener binds:

```text
127.0.0.1:17631
```

If that port is busy, the signed-out screen shows an error and disables Sign in.

## Integrated Window Chrome

macOS uses Tauri's overlay title-bar mode with native decorations. The native title is hidden, while a macOS-only AppKit hook positions the system traffic lights at a deliberate `17 x 17` point inset matching Claude's integrated 45-point toolbar geometry. Tauri's `trafficLightPosition` option is intentionally unset because its current Wry implementation does not apply `y` as a true top inset. React only supplies the surrounding sidebar/chat toolbar and draggable surface. Do not replace this with `decorations: false`: that removes native window controls and behavior.

The UI observes Tauri's native fullscreen state. While macOS hides the traffic lights in fullscreen, the shell replaces their reserved lane with the regular surface inset; leaving fullscreen restores the native-control safe area.

The UI build receives `VITE_DESKTOP_PLATFORM` from the desktop build wrapper. `solutions-ui` uses it to reserve the macOS traffic-light safe area without changing normal browser geometry.

Windows and Linux intentionally retain their native system decorations for now. This is the safe fallback for Snap Layouts, high contrast, Wayland/X11 compositor differences, resize borders, and system menus. Their UI chrome mode is still exposed to `solutions-ui`, so a future native caption-overlay implementation can be introduced without spreading OS checks across feature components.

## Smoke Checklist

1. Fresh launch opens the app and does not auto-open the browser.
2. Signed-out state shows the local Ardor signed-out screen.
3. Sign in opens one system browser tab.
4. Auth0 redirects back to `http://127.0.0.1:17631/auth/callback`.
5. The callback returns to the Tauri app.
6. Reopening the app preserves the authenticated session.
7. Logout returns to the signed-out screen and does not immediately auto-login.
8. Sending a chat message works against the configured cloud environment.
9. The Dock icon uses the Ardor app icon, not the generic macOS fallback.
10. DevTools do not open automatically in the release bundle.
11. `bun run build` in `solutions-ui` still builds the normal web app without Tauri runtime assumptions.
12. The packaged macOS app has no separate title strip, retains all three native traffic lights, and drags from unused sidebar/chat-toolbar space.
13. Sidebar buttons, chat actions, menus, inputs, and popovers remain clickable and never initiate window dragging.
14. Collapsed and expanded sidebar states keep controls clear of the native traffic-light safe area.

## Known Limitations

- Fixed callback port: `17631`.
- Auth opens in the system browser, not an in-app native auth session.
- No Windows bundle validation yet.
- No local file/shell/docker agent capabilities are wired yet.

## Isolation Rules

- Keep `src-tauri` and bundle output out of `solutions-ui`.
- Keep desktop CSP in `solutions-ui/config/csp/desktop.ts` and only load it when `TAURI_BUILD=true`.
- Do not enable global Tauri APIs in the WebView unless there is a specific security review.
- Expose desktop capabilities through narrow Tauri IPC commands.
