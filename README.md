# Ardor Desktop

Electron desktop shell for Ardor.

This repository owns the Electron main process, preload bridge, BrowserWindow/WebContentsView
surfaces, packaging, local IPC, and future local agent capabilities. The cloud-first React UI
stays in `solutions-ui` (private).

## Download & updates

Install production builds from the stable
[Electron downloads page](https://github.com/Ardor-Cerebrum/ardor-desktop/releases/tag/electron-downloads):

- macOS Apple Silicon: `Ardor-macOS-Apple-Silicon-unsigned.dmg`;
- Windows x64: `Ardor-Windows-x64-unsigned-setup.exe`.

Both are unsigned prerelease installers. After the one-time manual install, Electron releases use
Ardor-controlled Ed25519 update signatures: Sparkle on macOS and a verified local Squirrel staging
flow on Windows. The final Tauri-signed migration update opens that stable downloads page.
Developer ID signing, notarization, and Windows Authenticode signing remain separate concerns; see
[docs/build-channels.md](docs/build-channels.md#auto-update).

## Local layout

For local development, keep this repository next to `solutions-ui`:

```text
Ardor/
  ardor-desktop/
  solutions-ui/
```

The Electron packager loads the UI from:

```text
../solutions-ui/dist
```

To build against a different local UI checkout, set `ARDOR_SOLUTIONS_UI_DIR` to its absolute path:

```bash
ARDOR_SOLUTIONS_UI_DIR=/absolute/path/to/solutions-ui bun run build:prod
```

The build wrapper passes that checkout to the UI build and packages the resulting `dist` directory,
so the UI that was validated is the UI that is embedded in the Electron resources.

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

Production packaging produces a constrained ad-hoc macOS app/DMG and an unsigned Windows x64 Setup
EXE, plus independently signed updater payloads. Pushes to `main` run the release workflow
automatically; when semantic-release creates a version, it publishes both installers and their
update packages as a prerelease. Use the stage1 channel for ordinary local smoke packages.

Stage1 is the default local channel:

```bash
bun run build:stage1
```

On Windows, the stage1 installer is produced with:

```bash
bun run build:windows:stage1
```

Electron Forge writes packaged applications to `out/` and maker artifacts to `out/make/`. The
Windows maker is Squirrel.Windows; macOS uses the DMG maker. Linux is intentionally not a
release target.

## Run

For development, build the main/preload bundles and launch Electron:

```bash
bun run electron:dev
```

## Boundary

- `ardor-desktop` owns Electron main/preload code, app protocol (`ardor://app`), bundle metadata,
  icons, loopback callback server, native surfaces, and narrow desktop IPC commands.
- `solutions-ui` owns React UI and optional desktop-aware hooks guarded by `ELECTRON_BUILD` or the
  runtime bridge check.
- `desktop-ui-requirements.json` pins the release UI and defines the shell/UI protocol required by
  release CI.
- `window.ardorDesktop` is the only renderer-facing native bridge. Do not expose broad native APIs;
  add a narrow Electron IPC channel for each local capability.

See the [build-channel documentation](docs/build-channels.md) for environment, release, updater,
and Auth0 requirements.
