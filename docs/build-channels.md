# Desktop Build Channels

Ardor Desktop uses separate build channels. Do not switch cloud environments inside a production bundle.

## Channels

| Channel | Command | App name | Bundle identifier | Cloud |
| --- | --- | --- | --- | --- |
| `stage1` | `bun run build:stage1` | `Ardor Dev` | `cloud.ardor.desktop.stage1` | `https://stage1.dev.ardor.cloud` |
| `prod` | `bun run build:prod` | `Ardor` | `cloud.ardor.desktop` | `https://app.ardor.cloud` |

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
VITE_API_URL=https://app.ardor.cloud
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
```

`solutions-ui` uses `TAURI_BUILD_CHANNEL` to choose the matching desktop CSP at build time.
