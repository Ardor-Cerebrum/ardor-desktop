# Ardor Desktop

Electron desktop shell for Ardor.

This repository owns the Electron main process, preload bridge, BrowserWindow/WebContentsView
surfaces, packaging, local IPC, and future local agent capabilities. The cloud-first React UI
stays in `solutions-ui` (private).

## Download & updates

Install production builds from the latest Electron release on the
[GitHub Releases page](https://github.com/Ardor-Cerebrum/ardor-desktop/releases):

- macOS Apple Silicon: `Ardor-vX.Y.Z-mac-arm64-unsigned.dmg`;
- Windows x64: `Ardor-vX.Y.Z-windows-x64-unsigned-setup.exe`.

Both are unsigned installers. After the one-time manual install, Electron releases use
Ardor-controlled Ed25519 update signatures: Sparkle on macOS and a verified local Squirrel staging
flow on Windows. Each latest release also carries the signed v0.5.2 Tauri migration manifest so
older installations can still reach the migration screen.
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
update packages as the latest GitHub release. Use the stage1 channel for ordinary local smoke
packages.

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

## Local terminal architecture

The renderer uses xterm through the narrow, generation-aware `window.ardorDesktop.terminal`
contract. Electron main validates the trusted renderer, owns each terminal by `webContents.id`,
orders commands, and supervises a dedicated utility process. Only that utility process imports
`node-pty`, selects a discovered allowlisted shell profile, retains bounded replay, batches output, and applies
credit-based pause/resume backpressure.

On Windows, the broker discovers WSL (default distribution), PowerShell 7, Windows PowerShell,
Git Bash, and Command Prompt only at their standard installation paths. The renderer receives stable
profile identifiers and labels, never executable paths or caller-controlled arguments. New terminals
prefer WSL, then PowerShell 7, Windows PowerShell, and Command Prompt; changing profile atomically
starts the replacement before retiring the current PTY.

Every request and event carries broker, owner, terminal, generation, and ordered sequence identity
where applicable. A restarted PTY therefore cannot be mutated by delayed input from its predecessor.
React remounts detach and reattach to the same session; renderer loss gets a bounded cleanup grace
period, while window close and app shutdown close the owning sessions. Pending data is emitted before
exit, and retained output is bounded by UTF-8 bytes without splitting code points.

The utility process is a fault-isolation boundary, not an operating-system privilege sandbox. The
renderer never chooses a shell executable, arguments, or environment. Native `node-pty` artifacts are
unpacked from ASAR and validated by macOS and Windows package jobs. Cleanup guarantees cover the PTY
and interactive shell; independently detached descendants are outside this prototype unless future
work adds process-group ownership on Unix and Job Objects on Windows.

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
