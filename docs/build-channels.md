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

`env/prod.env` is gitignored. Required cloud values fail fast, so a production bundle cannot inherit
stage1 values from `solutions-ui/.env.local`. Platform signing uses the complete-or-absent rules
below.

Electron Forge writes the packaged application to `out/` and maker artifacts to `out/make/`:

- macOS: DMG and ZIP makers, targeting Apple Silicon;
- Windows: Squirrel.Windows setup executable, `RELEASES`, and `.nupkg` package assets.

The build wrapper accepts `ARDOR_SOLUTIONS_UI_DIR` for a different local UI checkout. Release CI
resolves one immutable `solutions-ui` SHA, builds its `dist` once per target platform, and packages
that static output without running another UI build.

## Production signing

macOS production packages prefer a Developer ID Application identity and App Store Connect API key:

```text
APPLE_SIGNING_IDENTITY
APPLE_KEYCHAIN_PATH                 # optional when the identity is in the default keychain
APPLE_API_KEY                       # absolute path to AuthKey_<id>.p8
APPLE_API_KEY_ID
APPLE_API_ISSUER
```

When this complete tuple is present, the build enables Hardened Runtime through Electron's signing
defaults, emits the Browser WebAuthn Keychain entitlement/runtime group, notarizes the app with
`notarytool`, and staples the ticket before publishing. A partial tuple fails before runtime config
or signing entitlements are generated.

When the entire tuple is absent (or the identity is explicitly `-` with every other value absent),
production packaging falls back to an ad-hoc signature. That build has no Browser WebAuthn Keychain
access group, no Touch ID platform-passkey integration, and no macOS auto-update feed. Release CI
publishes only an `-unsigned.dmg` as a GitHub prerelease; it omits the macOS ZIP and Windows target.
For first launch, try to open Ardor and dismiss the warning. Then open System Settings > Privacy &
Security, click **Open Anyway**, and confirm **Open**, following
[Apple's instructions](https://support.apple.com/102445). Because each ad-hoc build has a different
code identity, macOS may ask for Keychain/Safe Storage approval again after a manual update.

Windows production packages require either a PFX pair:

```text
WINDOWS_CERTIFICATE_FILE
WINDOWS_CERTIFICATE_PASSWORD
```

or a signtool-compatible custom/cloud provider:

```text
WINDOWS_SIGNTOOL_PATH
WINDOWS_SIGN_WITH_PARAMS
```

Optional Windows metadata is configured through `WINDOWS_TIMESTAMP_SERVER`,
`WINDOWS_SIGN_DESCRIPTION`, and `WINDOWS_SIGN_WEBSITE`. The packaged binaries and Squirrel installer
must both have valid Authenticode signatures.

Release CI materializes credentials only on the target runner. Configure these GitHub Actions
secrets:

```text
APPLE_CERTIFICATE_P12_BASE64
APPLE_CERTIFICATE_PASSWORD
APPLE_KEYCHAIN_PASSWORD
APPLE_SIGNING_IDENTITY
APPLE_API_KEY_P8_BASE64
APPLE_API_KEY_ID
APPLE_API_ISSUER
WINDOWS_CERTIFICATE_PFX_BASE64      # omit only when a custom provider is configured
WINDOWS_CERTIFICATE_PASSWORD
WINDOWS_SIGN_WITH_PARAMS            # optional custom-provider arguments
```

Custom Windows providers may also use repository variable `WINDOWS_SIGNTOOL_PATH`; the timestamp
server may be overridden with `WINDOWS_TIMESTAMP_SERVER`.

Electron Forge flips the hardened fuse contract before signing. CI reads the finished binary back
and verifies every configured fuse, platform signature, and the macOS notarization ticket. The exact
`@electron-forge/plugin-fuses` and `@electron/fuses` pins are intentional: Electron 43 has the ninth
`WasmTrapHandlers` fuse, while Forge 7's published peer range predates the ESM-only fuses v2 package.
The packaged-binary smoke check guards that compatibility until Forge 8 is stable.

## GitHub release assets

The public release workflow is manual-only, so merging `main` cannot silently downgrade a release
based on missing secrets. Dispatch it with `macos_release_mode=developer-id` for the existing signed
macOS plus signed Windows matrix, or explicitly choose `macos-adhoc` for the manual macOS-only
prerelease. The selected mode must match a complete or entirely absent Apple credential tuple before
semantic-release can create a tag or draft.

The workflow records the distribution mode in immutable draft metadata. Resume refuses a signing-
mode or prerelease-state change, then replaces nondeterministic Forge assets only within that same
verified draft mode and checks the exact final asset set. Stage1 remains an internal local channel.

The release UI is pinned by [desktop-ui-requirements.json](../desktop-ui-requirements.json). CI uses
that immutable SHA and runs the Electron bridge contract, callback tests, and UI type-check before
packaging. To change the embedded UI, update the pinned requirement in a reviewed desktop commit.

If installer creation fails after semantic-release created a tag, dispatch the same workflow with
`existing_release_tag` set to that draft release. The resume path reuses the tag's original UI
requirements snapshot, rebuilds the missing assets, and publishes only after both platforms pass.

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

Distribution-signed production builds use Electron's native `autoUpdater` with the public
[update.electronjs.org](https://www.electronjs.org/docs/latest/tutorial/updates) service. The feed
is configured only for the `prod` channel and only for supported targets (`darwin/arm64` and
`win32/x64`):

```text
https://update.electronjs.org/Ardor-Cerebrum/ardor-desktop/<platform>-<arch>/<version>
```

Stage1, development, and ad-hoc production macOS builds have no feed configured. The packaged
runtime flag is fail-closed, so a missing or invalid flag does not enable the updater. The UI keeps
background update failures non-blocking; installing an update is exposed only after Electron
reports a downloaded release.

Squirrel.Windows supplies the Windows setup executable, `RELEASES`, and `.nupkg` assets. A signed
macOS release publishes the Forge ZIP used by the native updater and a DMG for manual installation;
an ad-hoc release publishes only the explicitly unsigned DMG.

The previous public v0.5.1 Tauri client polls `releases/latest/download/latest.json`. Electron
releases do not publish the Tauri `latest.json` and signed updater archives, so existing Tauri
installations do not migrate automatically. An ad-hoc Electron release remains a prerelease and
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
