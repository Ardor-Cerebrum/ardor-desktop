# Desktop Build Channels

Ardor Desktop uses separate build channels. Do not switch cloud environments inside a production bundle.

## Channels

| Channel | Command | App name | Bundle identifier | Cloud |
| --- | --- | --- | --- | --- |
| `stage1` | `bun run build:stage1` | `Ardor Dev` | `cloud.ardor.desktop.stage1` | `https://stage1.dev.ardor.cloud` |
| `prod` | `bun run build:prod` | `Ardor` | `cloud.ardor.desktop` | `https://console.ardor.cloud` |

`bun run build` is an alias for `bun run build:stage1` while the local client is still an internal prototype.

## Stage1 Build

Stage1 is fully configured in [env/stage1.env](../env/stage1.env).

```bash
bun install
bun run build:stage1
open "src-tauri/target/release/bundle/macos/Ardor Dev.app"
```

The stage1 app uses the `Ardor Dev` name and the DEV-badged icon so it can sit next to the production app without Dock/keychain confusion.

## Production Build

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

Then build:

```bash
bun run build:prod
open src-tauri/target/release/bundle/macos/Ardor.app
```

`env/prod.env` is intentionally gitignored. Production builds fail fast when required production env values are missing, so a prod bundle cannot silently inherit stage values from `solutions-ui/.env.local`.

## GitHub Release Assets

The public release workflow distributes only production builds. When `semantic-release` publishes a new version, it creates:

```text
Ardor-vX.Y.Z-macos.zip
Ardor-vX.Y.Z-windows-x64-setup.exe
```

plus the auto-update artifacts described in [Auto-update](#auto-update):

```text
Ardor-vX.Y.Z-macos-aarch64.app.tar.gz (+ .sig)
Ardor-vX.Y.Z-windows-x64-setup.exe.sig
latest.json
```

Stage1 remains an internal, local build channel. The public workflow does not build or upload stage1 installers, updater artifacts, or manifests.

The workflow checks out this repository at the released tag and checks out `Ardor-Cerebrum/solutions-ui` next to it, matching the local layout:

```text
work/
  ardor-desktop/
  solutions-ui/
```

For each desktop release, CI reads the immutable `solutionsUiTag` and `solutionsUiRef` pair checked into [desktop-ui-requirements.json](../desktop-ui-requirements.json). It verifies that the release tag resolves to that exact SHA, then reuses the SHA for every platform asset. Release builds do not accept a branch, floating ref, or repository-variable override.

After `solutions-ui` publishes a release, its release workflow dispatches the exact tag and SHA to this repository. The desktop receiver validates the pair, reconciles queued events with the latest published release, and updates one canonical bot PR. A newer release replaces the pending bot update; stale or divergent release dispatches cannot move the pin backward.

The bot enables squash auto-merge on that PR. The `main` ruleset must require both the normal desktop CI and `Verify production desktop bundle` without a bot bypass. Once those checks pass, GitHub merges the `fix(release)` pin commit; the resulting `main` push runs the normal desktop semantic release and publishes the macOS, Windows, and updater artifacts.

Before semantic-release can publish a commit or tag, release CI compares
`solutions-ui/desktop-shell-contract.json` with the desktop requirements, installs the
selected UI, and runs the mounted callback-boundary tests and type-check. The contract
covers event and command names, request/response payload shapes, retained delivery
with a 10-minute terminal expiry, and ACK timing. Any mismatch stops the release;
there is no manifest-less source fallback.

Run the same check locally with:

```bash
node scripts/verify-desktop-ui-contract.mjs
```

For a local build against a different UI checkout, set `ARDOR_SOLUTIONS_UI_DIR` to its absolute path:

```bash
ARDOR_SOLUTIONS_UI_DIR=/absolute/path/to/solutions-ui bun run build:stage1
```

The Tauri wrapper resolves this path once, passes the absolute checkout path to the nested UI build, and appends a final `frontendDist` config overlay for that checkout's `dist`. This prevents local builds from compiling one UI worktree while packaging another. Release CI leaves the variable unset and keeps using its fixed sibling `solutions-ui/dist` artifact layout.

If a UI-only change needs fresh desktop packages, update `env/solutions-ui-release-trigger.md` with a conventional commit such as `ci: trigger desktop release for solutions-ui`.

Production release builds read public Vite config from GitHub repository variables. Required:

```text
DESKTOP_PROD_API_URL
DESKTOP_PROD_ARTIFACT_API_URL
DESKTOP_PROD_AUTH0_DOMAIN
DESKTOP_PROD_AUTH0_CLIENT_ID
```

Optional, but should be set for production parity with the web app:

```text
DESKTOP_PROD_AMPLITUDE_API_KEY
DESKTOP_PROD_SENTRY_DSN
DESKTOP_PROD_STRIPE_PRICING_TABLE_ID
DESKTOP_PROD_STRIPE_PUBLISHABLE_KEY
```

`DESKTOP_PROD_SENTRY_DSN` must point to the dedicated `ardor-desktop` Sentry project, not the shared `solutions-ui` web project. Leave it empty until that project and client key are configured. Desktop builds forward it to `solutions-ui` as `VITE_DESKTOP_SENTRY_DSN`; the web `VITE_SENTRY_DSN` is deliberately removed from desktop builds.

These values are embedded in the frontend bundle, so they are not treated as runtime secrets. Apple code signing, notarization, and DMG packaging are intentionally separate release-hardening steps.

## Auto-update

Production builds use the [Tauri updater plugin](https://v2.tauri.app/plugin/updater/) and poll the manifest on the latest GitHub release of this repository:

```text
.../releases/latest/download/latest.json
```

Public auto-update is intentionally unavailable for stage1, so internal test builds are not distributed through GitHub Releases. Its configured manifest endpoint has no published manifest, and the UI keeps failed background checks hidden.

The release is created as a draft before platform builds start. CI signs every production updater artifact, generates `latest.json`, uploads the complete asset set, and only then publishes the release as `latest`. A failed build, metadata-signing step, or upload therefore cannot expose a partial update through the stable endpoint.

The manifest is generated by [scripts/generate-update-manifest.mjs](../scripts/generate-update-manifest.mjs) and references the per-platform updater artifacts (`darwin-aarch64`, `windows-x86_64`). Generation is intentionally split into `prepare` and `finalize`: CI first creates canonical production metadata, signs those exact bytes, and only then embeds the payload and its signature in `latest.json`. The generator has a black-box test available through `bun run test:update-manifest`.

The Rust command `install_desktop_update` verifies that signed envelope before it downloads anything. It rejects a missing or invalid signature, an unexpected schema/channel/bundle identifier, an equal or older version, and any top-level version, publication date, platform URL, or artifact signature that differs from the signed payload. The WebView does not receive `updater:*` permissions and cannot bypass this gate by calling the updater plugin directly.

Release authority is split across isolated jobs and steps:

1. The independently versioned frontend is type-checked and built in a dedicated job/runner that has no updater signing secrets; only its static `dist` artifact crosses the boundary.
2. A fresh native-packaging runner downloads that static UI, receives the artifact-signing key, and uses an overlay whose `beforeBuildCommand` is empty, so it never executes frontend source or dependencies.
3. A separate signer job prepares and signs channel metadata but has no release-publishing token.
4. The publisher job receives the release token and finalized manifests but never receives the updater signing key.

As defense in depth, [scripts/run-ui.mjs](../scripts/run-ui.mjs) also removes every current and legacy Tauri private-key/key-path/password variable before spawning any `solutions-ui` process. These boundaries are regression-tested with:

```bash
bun run test:release-security
```

Update packages are signed with a minisign key (independent from Apple/Windows code signing). The public key lives in `tauri.conf.json` (`plugins.updater.pubkey`); the private key and its password live only in GitHub Secrets:

```text
TAURI_SIGNING_PRIVATE_KEY
TAURI_SIGNING_PRIVATE_KEY_PASSWORD
```

Losing this key means shipped apps can no longer verify new updates, so keep an offline backup. Rotating it requires shipping a release with the new public key while it is still signed with the old private key; do not regenerate it casually.

CI enables updater-artifact generation by appending [src-tauri/tauri.updater-artifacts.conf.json](../src-tauri/tauri.updater-artifacts.conf.json) as an extra `--config`. Local `bun run build:*` does not produce updater artifacts and therefore does not need the signing key. To test updater packaging locally, build the UI before putting a throwaway key in the native packaging environment:

```bash
bun run ui:type-check
bun run ui:build:stage1
bunx --bun @tauri-apps/cli@2.11.2 signer generate -w /tmp/test.key -p test
export TAURI_SIGNING_PRIVATE_KEY=$(cat /tmp/test.key)
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=test
bun run tauri:build:stage1 -- --bundles app --config src-tauri/tauri.updater-artifacts.conf.json
unset TAURI_SIGNING_PRIVATE_KEY TAURI_SIGNING_PRIVATE_KEY_PASSWORD
```

## Sentry

Desktop Sentry is opt-in per build channel. Without a `VITE_DESKTOP_SENTRY_DSN`, Ardor Desktop does not initialize Sentry and no `envelope` requests should be sent.

Use a separate Sentry project for desktop telemetry:

```text
Project: ardor-desktop
Allowed Domains: tauri://localhost
```

If preview or callback pages later report directly from loopback origins, also allow:

```text
http://127.0.0.1:17631
```

Desktop events are tagged by the shared UI bundle with:

```text
app=ardor-desktop
runtime=desktop
channel=stage1|prod
bundleId=cloud.ardor.desktop.stage1|cloud.ardor.desktop
shellVersion=<ardor-desktop package version>
uiApp=solutions-ui
```

Web `solutions-ui` builds continue to use `VITE_SENTRY_DSN` and report to the web Sentry project. Desktop builds use only `VITE_DESKTOP_SENTRY_DSN`, so a stale web DSN cannot accidentally enable desktop reporting.

## Auth0

Both channels use the loopback desktop callback:

```text
http://127.0.0.1:17631/auth/callback
```

Configure it in the corresponding Auth0 application:

- stage1 app: `auth-dev.ardor.cloud`
- production app: `auth.ardor.cloud`

Also keep desktop logout/origin settings aligned if the Auth0 app enforces them:

```text
tauri://localhost
```

## Implementation

- Tauri config overlays:
  - [src-tauri/tauri.stage1.conf.json](../src-tauri/tauri.stage1.conf.json)
  - [src-tauri/tauri.prod.conf.json](../src-tauri/tauri.prod.conf.json)
- UI env loader: [scripts/run-ui.mjs](../scripts/run-ui.mjs)
- Stage1 icon assets: [src-tauri/icons-stage](../src-tauri/icons-stage)
- Production icon assets: [src-tauri/icons](../src-tauri/icons)

Tauri merges each overlay through `tauri build --config ...`. The UI build channel is passed to `solutions-ui` through:

```text
TAURI_BUILD_CHANNEL=stage1|prod
VITE_DESKTOP_BUILD_CHANNEL=stage1|prod
VITE_DESKTOP_APP_NAME=Ardor Dev|Ardor
VITE_DESKTOP_BUNDLE_ID=cloud.ardor.desktop.stage1|cloud.ardor.desktop
VITE_DESKTOP_SHELL_VERSION=<ardor-desktop package version>
VITE_DESKTOP_SENTRY_DSN=<optional dedicated desktop DSN>
```

`solutions-ui` uses `TAURI_BUILD_CHANNEL` to choose the matching desktop CSP at build time.

## Auth callback diagnostics

The native shell keeps the latest 64 desktop auth callback phase transitions per app
process in `auth-callback-phases-<session-id>.jsonl` under Tauri's app-specific log
directory, retaining at most eight session files. Per-session paths prevent concurrent
app launches from overwriting each other's evidence. Production and stage1 builds
remain isolated by bundle identifier. Each entry contains only a random process
session ID, a monotonic transition sequence, the callback protocol version, a
process-local callback ID, the phase (`queued`, `consumed`, `acknowledged`, or
`expired`), elapsed milliseconds, and a timestamp. Writes use a same-directory
replacement file, and oversized prior logs are discarded before reading. Callback
URLs, OAuth `code`/`state`, tokens, cookies, email, and other PII are never included.
