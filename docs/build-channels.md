# Desktop build channels

Ardor Desktop has separate Electron build channels. A production bundle must never silently switch
to a cloud environment intended for stage1.

## Channels

| Channel | Command | App name | Bundle identifier | Cloud |
| --- | --- | --- | --- | --- |
| `stage1` | `bun run build:stage1` | `Ardor Dev` | `cloud.ardor.desktop.stage1` | `https://stage1.dev.ardor.cloud` |
| `prod` | `bun run build:prod` | `Ardor` | `cloud.ardor.desktop` | `https://console.ardor.cloud` |

`bun run build` is an alias for the stage1 build. The current public production release targets
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
ARDOR_IDENTITY_BFF_BASE_URL=https://console.ardor.cloud
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
  release CI validates all three and publishes the unsigned setup executable plus the verified
  `.nupkg` used by the signed updater.

The build wrapper accepts `ARDOR_SOLUTIONS_UI_DIR` for a different local UI checkout. Release CI
resolves one immutable `solutions-ui` SHA, builds its `dist` once per target platform, and packages
that static output without running another UI build.

## Current unsigned production distribution

The current release workflow creates two production builds without platform-trusted code signing:
an ad-hoc-signed macOS Apple Silicon DMG and an Authenticode-free Windows x64 Setup EXE. It does not
read Apple or Windows code-signing credentials or notarize. Update authenticity is independent:
Sparkle verifies an Ed25519 signature over the macOS ZIP, while the Windows main process verifies a
signed manifest, expiration, target, size, and SHA-256 before handing a private local `.nupkg` feed
to Squirrel. The macOS app still has no Browser WebAuthn Keychain access group or Touch ID
platform-passkey integration.

On macOS, first try to open Ardor and dismiss the warning. Then open System Settings > Privacy &
Security, click **Open Anyway**, and confirm **Open**, following
[Apple's instructions](https://support.apple.com/102445). Because each ad-hoc build has a different
code identity, macOS may ask for Keychain/Safe Storage approval again after a manual update. On
Windows, Microsoft Defender SmartScreen may require **More info** > **Run anyway**.

Developer ID signing, notarization, Touch ID entitlements, and Authenticode signing remain separate
from the completed one-time Tauri-to-Electron migration. OS signing will remove Gatekeeper/SmartScreen warnings;
it is not the trust root for the current Electron update payloads.

Electron Forge flips the hardened fuse contract before packaging. CI reads the finished macOS app,
mounted DMG, Windows package, and Setup EXE back and verifies their unsigned identities, absence of
signing-only capabilities, embedded updater keys/feed configuration, and every configured fuse. The
exact `@electron-forge/plugin-fuses` and `@electron/fuses` pins are intentional: Electron 43 has the
ninth `WasmTrapHandlers` fuse, while Forge 7's published peer range predates the ESM-only fuses v2
package. The packaged-binary smoke check guards that compatibility until Forge 8 is stable.

## GitHub release assets

Pushes to `main` first recover the latest validated semantic-release draft when one exists; otherwise
they run semantic-release automatically. When a conventional commit produces a new version, the
workflow creates a draft, builds the pinned UI for macOS and Windows,
packages and verifies both applications, uploads one `-unsigned.dmg`, one Sparkle ZIP, one
`-unsigned-setup.exe`, one Squirrel `.nupkg`, and the signed v0.5.2 Tauri migration `latest.json`.
Only after that exact asset set is present does it append the unsigned-distribution warning and
atomically publish the canonical tag as the latest GitHub release. It then advances the rolling
signed feeds. A `chore(release):` loop guard prevents the
semantic-release version commit from starting another run. Stage1 remains an internal local channel.

The release UI is pinned by [desktop-ui-requirements.json](../desktop-ui-requirements.json). CI uses
that immutable SHA and runs the Electron bridge contract, callback tests, and UI type-check before
packaging. To change the embedded UI, update the pinned requirement in a reviewed desktop commit.

If installer creation fails after semantic-release created a tag, the next push to `main`
automatically resumes that latest validated draft instead of allocating another version. It can also
be resumed immediately by dispatching the same workflow with `existing_release_tag` set to the tag.
The recovery path accepts only the latest semantic-release commit contained in `main`; it creates a
missing draft or resumes the existing draft, reuses the tag's original UI requirements snapshot,
rebuilds both platform assets, and publishes only after the macOS package and mounted DMG plus the
Windows package and installer pass verification.

If the version release was published but the rolling feed update failed, run **Refresh Electron
update feed** with that published release tag. The recovery workflow accepts only a strict `vX.Y.Z`
tag contained in `main`, verifies the release's exact five-asset set, recreates signatures from the
release's immutable ZIP/`.nupkg`, and replaces only `macos-arm64.xml` and `windows-x64.json` on the
managed technical `electron-update-feed` prerelease.

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

Electron update signing uses GitHub Actions secrets and variables:

```text
secret: ELECTRON_SPARKLE_PRIVATE_KEY
secret: ELECTRON_WINDOWS_UPDATE_PRIVATE_KEY
variable: ELECTRON_SPARKLE_PUBLIC_KEY
variable: ELECTRON_WINDOWS_UPDATE_PUBLIC_KEY
variable: ELECTRON_UPDATE_KEYS_FINALIZED=true
```

Private values are base64-encoded 32-byte Ed25519 seeds. They are materialized with mode `0600` only
for the signing job and removed in an `always()` cleanup step. Public keys are embedded in the app.
The finalized gate must remain false while temporary CI keys are in use. Immediately before the
first Electron release, generate new pairs, save both private seeds in the external backup vault,
replace the GitHub secrets and public variables together, run a local `N -> N+1` smoke, and only then
set the gate to true. After the first release, key rotation requires a transition release that still
verifies with the old key and embeds the new public key.

Generate the final keys in a private temporary directory outside the repository. The commands print
only public keys; never paste the private files into a terminal, issue, PR, or chat:

```bash
umask 077
ELECTRON_UPDATE_KEY_DIR="$(mktemp -d /private/tmp/ardor-electron-update-keys.XXXXXX)"
bun scripts/generate-electron-update-key.ts --output "$ELECTRON_UPDATE_KEY_DIR/macos-private.key"
bun scripts/generate-electron-update-key.ts --output "$ELECTRON_UPDATE_KEY_DIR/windows-private.key"
```

Save each private file as a secure-file or secret value in Bitwarden Secrets Manager before using
it in GitHub. Then upload the files through stdin, set the printed public values as repository
variables, verify both pairs, run the update smoke, and finally set
`ELECTRON_UPDATE_KEYS_FINALIZED=true`. Delete the temporary directory after both BWS and GitHub are
verified. GitHub Actions does not fetch these keys from BWS; GitHub Secrets are the active CI copy,
and BWS is the recovery backup.

## Auto-update

The macOS build uses Sparkle rather than Electron's stock `autoUpdater`. Sparkle downloads and stages
an Ed25519-signed ZIP, then waits for the explicit **Restart and update** action. Windows downloads a
signed JSON envelope, validates its target and validity window, streams the `.nupkg` into a private
cache while checking its signed size and SHA-256, then gives only that verified local directory to
Squirrel. The stock remote Squirrel feed is never trusted directly.

The previous public v0.5.1 Tauri client polls `releases/latest/download/latest.json`. Although its
macOS app was also ad-hoc signed, Tauri updates had a separate `TAURI_SIGNING_PRIVATE_KEY` signature.
Electron uses different Ed25519 key pairs and formats. The final Tauri-signed v0.5.2 manifest points
to immutable v0.5.2 migration assets, so every latest Electron release includes that same signed
`latest.json` compatibility asset. Existing Tauri installations therefore continue to update to the
migration screen through `releases/latest/download/latest.json`, while the GitHub latest release and
its normal versioned assets belong to Electron. After users install Electron once, subsequent
Electron updates use the signed feeds above.

## Desktop identity callback

Both channels use the loopback desktop callback:

```text
http://127.0.0.1:17631/auth/callback
```

Electron main starts authentication through the configured identity BFF, retains the expected OAuth
state, and accepts only the matching state plus a one-time desktop grant on this exact loopback URL.
The BFF must round-trip that consumed state with the grant. Main redeems and rotates the opaque
session handle in an Electron `safeStorage`-protected vault; the renderer sees only the versioned
`authSessionV1` bridge and short-lived internal tokens.

The shell protocol remains `ardor://app`. Configure the corresponding Auth0 application and identity
BFF for each channel; never point an HTTP BFF URL at anything other than an exact loopback host.

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
