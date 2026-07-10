# Ardor Desktop

Tauri desktop shell for Ardor.

This repository owns native desktop runtime, packaging, local IPC, and future local agent capabilities. The cloud-first React UI stays in `solutions-ui` (private).

## Download & Updates

Install the latest version from the [Releases page](https://github.com/Ardor-Cerebrum/ardor-desktop/releases/latest) (`Ardor-*-macos.zip` for macOS, `Ardor-*-windows-x64-setup.exe` for Windows). Installed apps update through the Settings button via a native, signed-metadata-gated Tauri updater; see [docs/build-channels.md](docs/build-channels.md#auto-update).

## License

Source-available, all rights reserved — see [LICENSE](LICENSE). The source is published for transparency; the binaries are the product.

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

To build against a different local UI checkout, point both the UI build and Tauri bundler at it with:

```bash
ARDOR_SOLUTIONS_UI_DIR=../solutions-ui-ard2397 bun run build:stage1
```

The desktop build wrapper converts that directory into a final Tauri `frontendDist` overlay, so the UI that is built is also the UI that is packaged.

## Build

Stage1 is the default internal channel:

```bash
bun install
bun run build
```

Explicit channel builds:

```bash
bun run build:stage1
bun run build:prod
```

The stage1 macOS app is produced at:

```text
src-tauri/target/release/bundle/macos/Ardor Dev.app
```

The production macOS app is produced at:

```text
src-tauri/target/release/bundle/macos/Ardor.app
```

See [docs/build-channels.md](docs/build-channels.md) for stage1/prod env setup, Tauri overlays, and Auth0 requirements.

## Run

```bash
open "src-tauri/target/release/bundle/macos/Ardor Dev.app"
```

## Boundary

- `ardor-desktop` owns Tauri config, bundle metadata, icons, loopback callback server, and desktop IPC commands.
- `solutions-ui` owns React UI and small desktop-aware hooks guarded by `TAURI_BUILD` / runtime checks.
- Do not expose broad native APIs to the WebView. Add narrow Tauri commands for each local capability.

See [docs/desktop-prototype.md](docs/desktop-prototype.md) for the current prototype checklist and [docs/build-channels.md](docs/build-channels.md) for stage1/prod build setup.
