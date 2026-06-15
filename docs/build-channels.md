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

The release workflow creates downloadable macOS app archives when `semantic-release` publishes a new version:

```text
Ardor-Dev-vX.Y.Z-macos.zip
Ardor-vX.Y.Z-macos.zip
```

The workflow checks out this repository at the released tag and checks out `Ardor-Cerebrum/solutions-ui` next to it, matching the local layout:

```text
work/
  ardor-desktop/
  solutions-ui/
```

By default the workflow builds UI from `solutions-ui@main`. Override it with this repository variable when a release must be pinned to another UI ref:

```text
DESKTOP_SOLUTIONS_UI_REF=<branch, tag, or commit sha>
```

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

These values are embedded in the frontend bundle, so they are not treated as runtime secrets. Code signing, notarization, DMG packaging, and auto-update metadata are intentionally separate release-hardening steps.

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
