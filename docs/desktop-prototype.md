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
bun run build
```

The build runs `solutions-ui` type-check, builds the UI with `TAURI_BUILD=true`, and then bundles the Tauri app.

The macOS app is produced at:

```text
src-tauri/target/release/bundle/macos/Ardor.app
```

## Run

```bash
open src-tauri/target/release/bundle/macos/Ardor.app
```

The desktop auth callback listener binds:

```text
127.0.0.1:17631
```

If that port is busy, the signed-out screen shows an error and disables Sign in.

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
