# Ardor Desktop

Tauri desktop shell for Ardor.

This repository owns native desktop runtime, packaging, local IPC, and future local agent capabilities. The cloud-first React UI stays in `solutions-ui` (private).

## Download & Updates

Install the latest production version from the [Releases page](https://github.com/Ardor-Cerebrum/ardor-desktop/releases/latest):

- `Ardor-vX.Y.Z-macos.zip` for Apple Silicon macOS;
- `Ardor-vX.Y.Z-windows-x64-setup.exe` for 64-bit Windows.

When a newer signed release is available, Ardor Desktop shows an update action beside the account
entry in the sidebar. The native updater verifies signed metadata and the selected platform artifact
before installation; see [docs/build-channels.md](docs/build-channels.md#auto-update).

## License

Source-available, all rights reserved — see [LICENSE](LICENSE). The source is published for transparency; the binaries are the product.

## Local Layout

For local development, keep this repository next to `solutions-ui`:

```text
Ardor/
  ardor-desktop/
  solutions-ui/
```

The Tauri config builds and loads the UI from:

```text
../solutions-ui/dist
```

To build against a different local UI checkout, set `ARDOR_SOLUTIONS_UI_DIR` to its absolute path:

```bash
ARDOR_SOLUTIONS_UI_DIR=/absolute/path/to/solutions-ui bun run build:prod
```

The desktop build wrapper converts that directory into a final Tauri `frontendDist` overlay, so the UI that is built is also the UI that is packaged.

## Build

Create a local production env file and fill the required Auth0/client values:

```bash
cp env/prod.env.example env/prod.env
```

Then build the production app:

```bash
bun install
bun run build:prod
```

The production macOS app is produced at:

```text
src-tauri/target/release/bundle/macos/Ardor.app
```

See the [production build documentation](docs/build-channels.md#production-build) for env setup, Tauri overlays, and Auth0 requirements.

## Run

```bash
open src-tauri/target/release/bundle/macos/Ardor.app
```

## Boundary

- `ardor-desktop` owns Tauri config, bundle metadata, icons, loopback callback server, and desktop IPC commands.
- `solutions-ui` owns React UI and small desktop-aware hooks guarded by `TAURI_BUILD` / runtime checks.
- Do not expose broad native APIs to the WebView. Add narrow Tauri commands for each local capability.

See the [production build documentation](docs/build-channels.md#production-build) for build and packaging details.
