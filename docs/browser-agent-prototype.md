# Desktop Browser agent prototype

This branch is a clean-room implementation of an observed desktop-browser tool contract. It does not contain copied vendor source. The first vertical slice connects the existing cloud agent to the Browser tiles owned by the signed-in desktop client.

## Request path

1. The desktop UI advertises protocol version 1 and its runtime-generated desktop instance ID with a prompt.
2. Copilot registers Browser tools only for that run. Web clients do not advertise the capability and receive no Browser tools.
3. A tool call is stored in Redis with a 45-second TTL and a random one-time token. A targeted Redis Pub/Sub event is delivered over the authenticated user SSE stream for that desktop instance.
4. The root UI relay validates the event and calls a semantic preload API. The cloud never sends raw CDP methods or chooses an Electron `webContents` ID.
5. Electron resolves the chat session to its mounted Browser contexts and tab IDs, enforces origin approval and navigation epochs, then executes the bounded command.
6. The UI submits the result with the one-time token. Copilot validates the authenticated user, desktop instance, token and single-result guard before returning it to the model.

## Protocol v1 tools

- `browser_tabs`: lists only Browser tiles attached to the current chat session.
- `browser_navigate`: navigates an attached tab to public HTTPS or loopback HTTP(S); public HTTP is upgraded.
- `browser_read_page`: returns up to 500 visible semantic elements and stable document-scoped `ref_N` identifiers.
- `browser_click`: clicks only an element returned by the latest page read.
- `browser_type`: replaces text in a referenced editable element and can press Enter.

## Trust boundaries

- The desktop bridge is absent in the web build, so existing web preview/iframe behavior is unchanged.
- Browser contexts are bound by the mounted desktop UI; the model cannot address an arbitrary native tab.
- The first access to an origin in a chat session requires a native user confirmation.
- Origin and navigation epoch are checked after approval/read and immediately before input dispatch. A click or submitted edit may then navigate normally.
- Page reads run in an isolated world, return no raw HTML or framework props, and cap both element count and total text.
- Password, hidden, one-time-code and payment fields are redacted. Agent typing into those fields is blocked.
- Result calls are authenticated, targeted to one desktop instance, bounded to 256 KiB and accepted once.

## Prototype limitations

- Redis Pub/Sub delivery is live-only. A tool request can time out if the desktop SSE connection is reconnecting.
- Cancellation is reported by Copilot but does not yet close a native approval dialog or abort an in-flight Electron command.
- Origin approval is session-wide; there is no separate destructive-action confirmation policy yet.
- There is no screenshot, scrolling, key-sequence, select-option or file-upload tool in protocol v1.
- This branch is not enabled in production and must pass a real cloud-to-desktop acceptance test before merge.
