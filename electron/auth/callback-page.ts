import type { DesktopConnectorStatus } from "../bridge-contract";

const AUTH_FOCUS_PATH = "/auth/focus";
/** SECURITY: callback-server.ts allows exactly this script by its hash, so nothing else can run on the page. */
export const FOCUS_SCRIPT_SOURCE = "window.close()";

const CALLBACK_PAGE_TEMPLATE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="color-scheme" content="light dark">
    <title>%%DOCUMENT_TITLE%%</title>
    <style>
      :root {
        color-scheme: light dark;
        --background: #fafafa;
        --card: #ffffff;
        --foreground: #09090b;
        --muted-foreground: #71717a;
        --border: #e4e4e7;
      }

      * { box-sizing: border-box; }
      html { min-height: 100%; }

      body {
        min-height: 100vh;
        min-height: 100svh;
        margin: 0;
        padding: 32px 20px;
        display: grid;
        place-items: center;
        background: var(--background);
        color: var(--foreground);
        font-family: "Inter Variable", Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        text-rendering: optimizeLegibility;
      }

      .card {
        width: min(520px, 100%);
        padding: 52px;
        border: 1px solid var(--border);
        border-radius: 24px;
        background: var(--card);
        text-align: center;
      }

      .app-icon {
        width: 80px;
        height: 80px;
        display: grid;
        place-items: center;
        margin: 0 auto 36px;
        border: 1px solid var(--border);
        border-radius: 18px;
        background: #ffffff;
      }

      .app-icon svg { width: 56px; height: 56px; }

      h1 {
        margin: 0;
        font-size: 28px;
        font-weight: 500;
        line-height: 1.2;
      }

      .message {
        margin: 14px auto 0;
        max-width: 340px;
        color: var(--muted-foreground);
        font-size: 15px;
        line-height: 22px;
      }

      .handoff-form { margin: 32px 0 0; }

      .handoff {
        width: 100%;
        height: 44px;
        border: 0;
        border-radius: 9999px;
        background: var(--foreground);
        color: var(--background);
        cursor: pointer;
        font: inherit;
        font-size: 15px;
        font-weight: 500;
        transition: opacity 150ms ease;
      }

      .handoff:hover { opacity: 0.9; }
      .handoff:focus-visible { outline: 2px solid var(--foreground); outline-offset: 2px; }

      @media (prefers-color-scheme: dark) {
        :root {
          --background: #09090b;
          --card: #18181b;
          --foreground: #fafafa;
          --muted-foreground: #a1a1aa;
          --border: rgba(255, 255, 255, 0.1);
        }
      }

      @media (max-width: 480px) {
        body { padding: 20px 16px; }
        .card { padding: 36px 24px; }
      }

      @media (prefers-reduced-motion: reduce) {
        .handoff { transition: none; }
      }
    </style>
  </head>
  <body data-state="%%STATE%%">
    <main class="card" aria-labelledby="page-title" aria-live="polite">
      <div class="app-icon" role="img" aria-label="Ardor Desktop">
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path fill-rule="evenodd" clip-rule="evenodd" d="M16.4479 9.8086L20.6503 5.6038C20.7853 5.46875 20.7853 5.24777 20.6503 5.11273L18.8834 3.34487C18.7485 3.20982 18.5276 3.20982 18.3926 3.34487L14.1902 7.54967C13.9693 7.77065 13.5951 7.61105 13.5951 7.30413V1.34989C13.5951 1.1596 13.4417 1 13.2454 1H10.7485C10.5583 1 10.3988 1.15346 10.3988 1.34989V7.30413C10.3988 7.61719 10.0245 7.77065 9.80369 7.54967L5.59509 3.33873C5.46013 3.20368 5.23927 3.20368 5.1043 3.33873L3.33742 5.10659C3.20246 5.24163 3.20246 5.46261 3.33742 5.59766L7.53988 9.80246C7.76074 10.0234 7.60123 10.3979 7.29448 10.3979H1.34969C1.15951 10.3979 1 10.5513 1 10.7478V13.2461C1 13.4364 1.15337 13.596 1.34969 13.596H4.66871C5.57055 13.596 6.39878 13.1295 6.88344 12.3683C7.29448 11.7238 7.82822 11.159 8.44786 10.7109C8.60123 10.6005 8.75461 10.4961 8.92025 10.404C9.38037 10.1339 9.87117 9.91909 10.3988 9.77791C10.8528 9.65514 11.3313 9.58148 11.8221 9.56306H12.1718C12.6626 9.57534 13.1411 9.649 13.5951 9.77177C14.1227 9.91295 14.6258 10.1278 15.0859 10.3979C15.2454 10.49 15.3988 10.5943 15.5522 10.7048C16.1779 11.1529 16.7117 11.7176 17.1288 12.3683C17.6135 13.1295 18.4417 13.596 19.3436 13.596H22.6503C22.8405 13.596 23 13.4425 23 13.2461V10.7478C23 10.5575 22.8466 10.3979 22.6503 10.3979H16.7055C16.3804 10.404 16.227 10.0296 16.4479 9.8086ZM8.14697 13.6021H8.14108L8.71777 13.0251C8.90182 12.798 9.11041 12.5895 9.3374 12.4051C9.48464 12.2824 9.64415 12.1719 9.80366 12.0736C9.80479 12.073 9.80593 12.0723 9.80706 12.0716L9.80321 12.0677C9.99339 11.9511 10.1897 11.8529 10.3983 11.7669C10.8891 11.5644 11.429 11.4539 11.9934 11.4539C12.5578 11.4539 13.0977 11.5644 13.5885 11.7669C13.7971 11.8529 13.9934 11.9511 14.1836 12.0677C14.3492 12.1659 14.5026 12.2764 14.656 12.3992L14.6867 12.4299C14.8919 12.5996 15.0817 12.7895 15.2513 12.9948L15.2756 13.0192L15.8523 13.5962L18.0732 15.8183L20.656 18.4025C20.7848 18.5376 20.7848 18.7586 20.6498 18.8936L18.883 20.6615C18.748 20.7965 18.5271 20.7965 18.3922 20.6615L16.9259 19.1944L15.6008 17.8685L13.5947 15.8613V23.0002H10.3984V15.8632L7.07316 19.1944L5.60077 20.6676C5.4658 20.8026 5.24494 20.8026 5.10997 20.6676L3.3431 18.8997C3.20813 18.7647 3.20813 18.5437 3.3431 18.4087L5.93206 15.8183L8.14065 13.6084L8.14697 13.6021Z" fill="url(#brand-gradient)"/>
          <defs><linearGradient id="brand-gradient" x1="12" y1="2" x2="12" y2="22" gradientUnits="userSpaceOnUse"><stop stop-color="#FF9700"/><stop offset="1" stop-color="#9000AF"/></linearGradient></defs>
        </svg>
      </div>
      <h1 id="page-title">%%TITLE%%</h1>
      <p class="message">%%MESSAGE%%</p>
      %%HANDOFF%%
    </main>
    %%SCRIPT%%
  </body>
</html>`;

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      case "'":
        return "&#39;";
      default:
        return character;
    }
  });
}

export function renderAuthCallbackPage(status: number, message: string, focusToken?: string): string {
  const success = status >= 200 && status < 300;
  return renderCallbackPage({
    success,
    documentTitle: success ? "Return to Ardor" : "Sign-in issue — Ardor",
    title: success ? "Sign-in received" : "Return to Ardor",
    message,
    focusToken,
  });
}

/** NOTE: What the browser shows once a connector sign-in is over; the same Return to Ardor handoff as sign-in. */
export function renderConnectorCallbackPage(status: DesktopConnectorStatus, focusToken?: string): string {
  const connected = status === "connected";
  return renderCallbackPage({
    success: connected,
    documentTitle: connected ? "Return to Ardor" : "Connection issue — Ardor",
    title: connected ? "Connected" : "Not connected",
    message: connected
      ? "You can return to Ardor Desktop."
      : "The connection did not finish. Return to Ardor Desktop and try again.",
    focusToken,
  });
}

function renderCallbackPage(page: {
  success: boolean;
  documentTitle: string;
  title: string;
  message: string;
  focusToken?: string;
  script?: string;
}): string {
  const handoff = page.success && page.focusToken
    ? `<form class="handoff-form" method="get" action="${AUTH_FOCUS_PATH}"><input type="hidden" name="token" value="${escapeHtml(page.focusToken)}"><button class="handoff" type="submit">Return to Ardor</button></form>`
    : "";

  return CALLBACK_PAGE_TEMPLATE
    .replace("%%DOCUMENT_TITLE%%", page.documentTitle)
    .replace("%%STATE%%", page.success ? "success" : "error")
    .replace("%%TITLE%%", page.title)
    .replace("%%MESSAGE%%", escapeHtml(page.message))
    .replace("%%HANDOFF%%", handoff)
    .replace("%%SCRIPT%%", page.script ?? "");
}

/** NOTE: The browser only closes a tab the page may close, so the page says the tab can be closed either way. */
export function renderAuthFocusPage(): string {
  return renderCallbackPage({
    success: true,
    documentTitle: "Back in Ardor",
    title: "Back in Ardor",
    message: "You can close this tab.",
    script: `<script>${FOCUS_SCRIPT_SOURCE}</script>`,
  });
}
