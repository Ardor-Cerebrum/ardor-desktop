# Desktop build channels

Ardor Desktop has separate Electron build channels. A production bundle must never silently switch
to a cloud environment intended for stage1.

## Channels

| Channel | Command | App name | Bundle identifier | Cloud |
| --- | --- | --- | --- | --- |
| `stage1` | `bun run build:stage1` | `Ardor Dev` | `cloud.ardor.desktop.stage1` | `https://stage1.dev.ardor.cloud` |
| `prod` | `bun run build:prod` | `Ardor` | `cloud.ardor.desktop` | `https://console.ardor.cloud` |

`bun run build` is an alias for the stage1 build. Production release packaging supports Apple
Silicon macOS and Windows x64. Linux is not a release target.

## Stage1 build

Stage1 is configured in [env/stage1.env](../env/stage1.env):

```bash
bun install
bun run build:stage1
```

For a Windows package from WSL, use:

```bash
bun run build:windows:stage1
```

The stage1 app is named `Ardor Dev`, uses the stage1 bundle identifier, and does not contact the
production update feed.

## Production build

Create a local production env file:

```bash
cp env/prod.env.example env/prod.env
```

Fill at least:

```text
VITE_API_URL=https://console.ardor.cloud
VITE_ARTIFACT_API_URL=https://artifact.ardor.build/artifact-api
VITE_AUTH0_DOMAIN=auth.ardor.cloud
VITE_AUTH0_CLIENT_ID=<production Auth0 client id>
```

Then run:

```bash
bun run build:prod
```

`env/prod.env` is gitignored. Required values fail fast, so a production bundle cannot inherit
stage1 values from `solutions-ui/.env.local`.

Electron Forge writes the packaged application to `out/` and maker artifacts to `out/make/`:

- macOS: DMG and ZIP makers, targeting Apple Silicon;
- Windows: Squirrel.Windows setup executable, `RELEASES`, and `.nupkg` package assets.

The build wrapper accepts `ARDOR_SOLUTIONS_UI_DIR` for a different local UI checkout. Release CI
resolves one immutable `solutions-ui` SHA, builds its `dist` once per target platform, and packages
that static output without running another UI build.

## GitHub release assets

The public release workflow builds only production artifacts. It creates a draft GitHub Release,
builds macOS and Windows assets, uploads every maker artifact, and publishes the release only after
both platforms succeed. Stage1 remains an internal local channel.

The release UI is pinned by [desktop-ui-requirements.json](../desktop-ui-requirements.json). A release
override may set `DESKTOP_SOLUTIONS_UI_REF` to a branch, tag, or commit; CI resolves it to an immutable
SHA and runs the Electron bridge contract, callback tests, and UI type-check before packaging.

Production UI configuration comes from GitHub repository variables:

```text
DESKTOP_PROD_API_URL
DESKTOP_PROD_ARTIFACT_API_URL
DESKTOP_PROD_AUTH0_DOMAIN
DESKTOP_PROD_AUTH0_CLIENT_ID
```

Optional public values are forwarded as `VITE_DESKTOP_*` variables:

```text
DESKTOP_PROD_AMPLITUDE_API_KEY
DESKTOP_PROD_SENTRY_DSN
DESKTOP_PROD_STRIPE_PRICING_TABLE_ID
DESKTOP_PROD_STRIPE_PUBLISHABLE_KEY
```

These values are embedded in the renderer bundle and are not runtime secrets. Keep desktop Sentry in
a dedicated project and leave the DSN empty until that project is configured.

## Auto-update

Production builds use Electron's native `autoUpdater` with the public
[update.electronjs.org](https://www.electronjs.org/docs/latest/tutorial/updates) service. The feed
is configured only for the `prod` channel and only for supported targets (`darwin/arm64` and
`win32/x64`):

```text
https://update.electronjs.org/Ardor-Cerebrum/ardor-desktop/<platform>-<arch>/<version>
```

Stage1 and development builds have no feed configured. The UI keeps background update failures
non-blocking; installing an update is exposed only after Electron reports a downloaded release.

Squirrel.Windows supplies the Windows setup executable, `RELEASES`, and `.nupkg` assets. macOS
publishes the Forge ZIP used by the native updater and a DMG for manual installation. Public
auto-update requires the release artifacts to be code-signed according to the platform distribution
requirements; unsigned local packages are for smoke testing only.

## Auth0 callback

Both channels use the loopback desktop callback:

```text
http://127.0.0.1:17631/auth/callback
```

The shell protocol is `ardor://app`. Configure the corresponding Auth0 application for the stage1
or production domain and keep desktop logout/origin settings aligned with the loopback callback.

## Renderer/native boundary

- The Electron main process owns `BrowserWindow`, `WebContentsView`, the `ardor://app` protocol,
  native browser/artifact surfaces, and the narrow IPC handlers.
- The preload exposes the typed `window.ardorDesktop` bridge. The renderer never receives raw
  `ipcRenderer` or unrestricted Node APIs.
- `solutions-ui` can fall back to normal web behavior when the bridge is unavailable.

Run the local contract check with:

```bash
node scripts/verify-desktop-ui-contract.mjs
```

The check verifies the pinned UI reference, Electron bridge global, required capabilities, and
desktop auth callback mount.

## Sentry

Desktop Sentry is opt-in through `VITE_DESKTOP_SENTRY_DSN`. Without it, the desktop UI must not send
Sentry envelopes. Tag events with `runtime=desktop`, `channel=stage1|prod`, and the Electron shell
version so desktop and web telemetry remain distinguishable.
