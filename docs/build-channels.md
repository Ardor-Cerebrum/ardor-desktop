# Desktop build channels

Ardor Desktop has separate Electron build channels. A production bundle must never silently switch
to a cloud environment intended for stage1.

## Channels

| Channel | Command | App name | Bundle identifier | Cloud |
| --- | --- | --- | --- | --- |
| `stage1` | `bun run build:stage1` | `Ardor Dev` | `cloud.ardor.desktop.stage1` | `https://stage1.dev.ardor.cloud` |
| `prod` | `bun run build:prod` | `Ardor` | `cloud.ardor.desktop` | `https://console.ardor.cloud` |

`bun run build` is an alias for the stage1 build. The current public production prerelease targets
Apple Silicon macOS and Windows x64. Linux is not a release target.

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

`env/prod.env` is gitignored. Required cloud values fail fast, so a production bundle cannot inherit
stage1 values from `solutions-ui/.env.local`.

Electron Forge writes the packaged application to `out/` and maker artifacts to `out/make/`:

- macOS: a DMG maker targeting Apple Silicon;
- Windows: Squirrel.Windows setup executable, `RELEASES`, and `.nupkg` package assets. Production
  release CI validates all three, but publishes only the unsigned setup executable.

The build wrapper accepts `ARDOR_SOLUTIONS_UI_DIR` for a different local UI checkout. Release CI
resolves one immutable `solutions-ui` SHA, builds its `dist` once per target platform, and packages
that static output without running another UI build.

## Current unsigned production distribution

The current release workflow creates two manual production builds without platform-trusted code
signing: an ad-hoc-signed macOS Apple Silicon DMG and an Authenticode-free Windows x64 Setup EXE. It
does not read Apple or Windows signing credentials, notarize, or publish updater archives. Both apps
ship with auto-update disabled. The macOS app also has no Browser WebAuthn Keychain access group or
Touch ID platform-passkey integration.

On macOS, first try to open Ardor and dismiss the warning. Then open System Settings > Privacy &
Security, click **Open Anyway**, and confirm **Open**, following
[Apple's instructions](https://support.apple.com/102445). Because each ad-hoc build has a different
code identity, macOS may ask for Keychain/Safe Storage approval again after a manual update. On
Windows, Microsoft Defender SmartScreen may require **More info** > **Run anyway**.

Developer ID signing, notarization, Touch ID entitlements, Authenticode signing, and a
Tauri-to-Electron updater migration are deferred until the required credentials and migration path
exist. They are not alternate branches of the current workflow.

Electron Forge flips the hardened fuse contract before packaging. CI reads the finished macOS app,
mounted DMG, Windows package, and Setup EXE back and verifies their unsigned identities, absence of
signing-only capabilities, disabled updater, and every configured fuse. The exact
`@electron-forge/plugin-fuses` and `@electron/fuses` pins are intentional: Electron 43 has the ninth
`WasmTrapHandlers` fuse, while Forge 7's published peer range predates the ESM-only fuses v2 package.
The packaged-binary smoke check guards that compatibility until Forge 8 is stable.

## GitHub release assets

Pushes to `main` run semantic-release automatically. When a conventional commit produces a new
version, the workflow creates a warned prerelease, builds the pinned UI for macOS and Windows,
packages and verifies both applications, uploads exactly one `-unsigned.dmg` and one
`-unsigned-setup.exe`, and publishes the prerelease. A `chore(release):` loop guard prevents the
semantic-release version commit from starting another run. Stage1 remains an internal local channel.

The release UI is pinned by [desktop-ui-requirements.json](../desktop-ui-requirements.json). CI uses
that immutable SHA and runs the Electron bridge contract, callback tests, and UI type-check before
packaging. To change the embedded UI, update the pinned requirement in a reviewed desktop commit.

If installer creation fails after semantic-release created a tag, dispatch the same workflow with
`existing_release_tag` set to that release tag. The recovery path accepts only the latest validated
semantic-release commit contained in `main`; it creates a missing draft or resumes the existing
draft, reuses the tag's original UI requirements snapshot, rebuilds both platform assets, and
publishes only after the macOS package and mounted DMG plus the Windows package and installer pass
verification.

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

The current production builds do not use Electron's native `autoUpdater`. Their packaged runtime
flag is explicitly false and fail-closed. The release omits the macOS ZIP and Windows Squirrel
`RELEASES`/`.nupkg` updater assets. Updates are installed manually from the unsigned DMG or Setup
EXE.

The previous public v0.5.1 Tauri client polls `releases/latest/download/latest.json`. Although its
macOS app was also ad-hoc signed, Tauri updates had a separate `TAURI_SIGNING_PRIVATE_KEY` signature.
The Electron release has no equivalent independent updater-signature layer and does not publish the
Tauri `latest.json` or signed updater archives, so existing Tauri installations do not migrate
automatically. An ad-hoc Electron release remains a prerelease and
must be installed manually, leaving the latest Tauri updater endpoint unchanged. A future signed
Electron migration requires an explicit updater transition plan.

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
