# Ardor Desktop

Tauri desktop shell for Ardor.

This repository owns native desktop runtime, packaging, local IPC, and future local agent capabilities. The cloud-first React UI stays in `solutions-ui`.

## Local Layout

For the current `0.1.0` prototype, keep this repository next to `solutions-ui`:

```text
Ardor/
  ardor-desktop/
  solutions-ui/
```

The Tauri config builds and loads the UI from:

```text
../solutions-ui/dist
```

## Build

```bash
bun install
bun run build
```

The macOS app is produced at:

```text
src-tauri/target/release/bundle/macos/Ardor.app
```

## Run

```bash
open src-tauri/target/release/bundle/macos/Ardor.app
```

## Boundary

- `ardor-desktop` owns Tauri config, bundle metadata, icons, loopback callback server, and desktop IPC commands.
- `solutions-ui` owns React UI and small desktop-aware hooks guarded by `TAURI_BUILD` / runtime checks.
- Do not expose broad native APIs to the WebView. Add narrow Tauri commands for each local capability.

See [docs/desktop-prototype.md](docs/desktop-prototype.md) for the current prototype checklist and Auth0 settings.
