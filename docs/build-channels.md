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

Optional public web integrations:

```text
DESKTOP_PROD_AMPLITUDE_API_KEY
DESKTOP_PROD_STRIPE_PRICING_TABLE_ID
DESKTOP_PROD_STRIPE_PUBLISHABLE_KEY
```

`DESKTOP_PROD_SENTRY_DSN` is intentionally ignored by `solutions-ui` desktop builds for `0.1.0`. The desktop WebView origin is `tauri://localhost`, and the shared web Sentry client key rejects that origin unless the Sentry client key is explicitly configured for desktop.

These values are embedded in the frontend bundle, so they are not treated as runtime secrets. Code signing, notarization, DMG packaging, and auto-update metadata are intentionally separate release-hardening steps.

## Auth0

Both channels use the loopback desktop callback:

```text
http://127.0.0.1:17631/auth/callback
```

Configure it in the corresponding Auth0 application:

- stage1 app: `auth-dev.ardor.cloud`
- production app: `auth.ardor.cloud`

Required Auth0 application URL settings:

```text
Allowed Callback URLs: http://127.0.0.1:17631/auth/callback
Allowed Logout URLs: tauri://localhost, http://127.0.0.1:17631
Allowed Web Origins: tauri://localhost, http://127.0.0.1:17631
Allowed Origins (CORS): tauri://localhost
```

`http://127.0.0.1:17631/auth/callback` is the browser redirect target. `tauri://localhost` is the WebView origin used for the Auth0 token exchange.

Enable Auth0 Non-Verifiable Callback URI End-User Confirmation for production desktop clients.

If Sentry is enabled for desktop later, configure the Sentry client key to allow:

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
```

`solutions-ui` uses `TAURI_BUILD_CHANNEL` to choose the matching desktop CSP at build time.
