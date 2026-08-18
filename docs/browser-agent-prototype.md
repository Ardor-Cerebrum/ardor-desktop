# Desktop Browser agent prototype

This branch connects the existing cloud agent to the same native Browser tabs that the signed-in desktop user sees and controls. The model receives a bounded semantic Browser protocol; it never receives a raw CDP method or an Electron `webContents` identifier.

## Request path

1. The desktop UI advertises protocol version 2 and its runtime-generated desktop instance ID with a prompt. The web client does not advertise this capability.
2. Copilot registers the complete Browser tool surface only for that run.
3. Each model tool call is stored in Redis with a 45-second TTL and a random one-time token. A targeted Pub/Sub event is delivered over the authenticated user SSE stream for that desktop instance.
4. The root UI relay accepts only protocol-v2 events and the exact tool allowlist, then forwards `{name, input}` through the preload bridge.
5. Electron resolves the chat-owned Browser context and stable tab ID, applies read/action origin policy and navigation-generation checks, and executes the command against the live WebContentsView.
6. The UI submits the bounded result with the one-time token. Copilot validates user ownership, desktop instance, token, and the single-result guard before returning it to the model.

## Protocol v2 tools

Preview lifecycle:

- `preview_start`
- `preview_stop`
- `preview_list`
- `preview_logs`

Page understanding and diagnostics:

- `read_page`
- `find`
- `get_page_text`
- `javascript_tool`
- `read_console_messages`
- `read_network_requests`

Interaction and presentation:

- `computer`
- `form_input`
- `navigate`
- `resize_window`

Tab lifecycle:

- `tabs_context`
- `tabs_create`
- `tabs_select`
- `tabs_close`

`read_page` returns a YAML-style semantic tree with document-scoped `ref_N` handles, a default depth of 15, a maximum depth of 50, a 10,000-node ceiling, and bounded text. Password, hidden, OTP, and payment values are redacted. `find` searches the latest cached tree. `form_input` operates on those refs through native element setters and input/change events.

`computer` supports left/right/double/triple click, type, screenshot, wait, scroll, key sequences, drag, zoom, scroll-to-ref, and hover. Screenshots are JPEG quality 75 and at most 800 pixels wide. Coordinate actions are interpreted in the latest screenshot coordinate space and rejected after navigation or resize.

Console and network diagnostics are collected from CDP in the Electron main process. Buffers are bounded, reset when the committed main-frame origin changes, and network response bodies are truncated before crossing the bridge.

## Trust boundaries

- The desktop bridge is absent in the web build, so the existing web preview/iframe path is unchanged.
- Browser contexts are bound by the mounted desktop UI; the model cannot address an arbitrary native tab.
- Public origins require separate read and action confirmation. Each approval can apply once or for the rest of the chat; loopback development origins are approved automatically.
- A navigation URL containing username/password credentials requires its own one-shot warning and is never remembered as a credential grant.
- Origin, WebContents generation, and navigation epoch are checked around approvals and tool execution. Stale `ref_N` and screenshot coordinates fail closed.
- Page reads run in an isolated world and do not return raw HTML or framework props.
- Tool calls time out after 30 seconds. Result submission is authenticated, instance-targeted, bounded to 2 MiB for screenshots, and accepted once.
- Tool dispatch remains semantic. Raw CDP is private to Electron and cannot be selected by the model.

## Known prototype boundary

The cloud agent has no desktop-local workspace process runtime. Therefore `preview_start(url=...)` works, while `preview_start(name=...)`, `preview_stop`, and `preview_logs` return an explicit error for local processes. Closing this gap requires a separately owned local process/log bridge; silently pretending that the cloud shell owns desktop processes would be incorrect.

Redis Pub/Sub delivery is live-only, and cancellation does not yet abort an in-flight native approval dialog or CDP command. The prototype must pass a real cloud-to-desktop acceptance run before production enablement.
