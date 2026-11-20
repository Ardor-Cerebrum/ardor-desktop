import { describe, expect, test } from "bun:test";

import { renderAuthCallbackPage, renderAuthFocusPage, renderConnectorCallbackPage } from "./callback-page";

describe("desktop auth callback pages", () => {
  test("renders the desktop success handoff", () => {
    const page = renderAuthCallbackPage(200, "Sign-in is continuing in Ardor Desktop.", "focus-token");

    expect(page).toContain('data-state="success"');
    expect(page).toContain("Sign-in received");
    expect(page).toContain('aria-label="Ardor Desktop"');
    expect(page).toContain('method="get" action="/auth/focus"');
    expect(page).toContain('name="token" value="focus-token"');
    expect(page).toContain(">Return to Ardor</button>");
    expect(page).toContain("prefers-color-scheme: dark");
    expect(page).not.toContain("Authentication complete");
    expect(page).not.toContain("window.close()");
  });

  test("escapes callback messages and omits handoff controls for errors", () => {
    const page = renderAuthCallbackPage(400, "Try <again> & don't panic.");

    expect(page).toContain('data-state="error"');
    expect(page).toContain("Return to Ardor");
    expect(page).toContain("Try &lt;again&gt; &amp; don&#39;t panic.");
    expect(page).not.toContain('<form class="handoff-form"');
    expect(page).not.toContain("Try <again>");
  });

  test("renders the focus handoff page with a safe auto-close script", () => {
    const page = renderAuthFocusPage();

    expect(page).toContain("Back in Ardor");
    expect(page).toContain("You can close this tab.");
    expect(page).toContain("<script>window.close()</script>");
  });

  test("follows the simple centered card: app icon in the card, short title, one full-width pill", () => {
    const page = renderConnectorCallbackPage("connected", "focus-token");

    expect(page).toContain("text-align: center");
    expect(page).toContain('class="app-icon"');
    expect(page).toContain("width: 100%");
    expect(page).not.toContain('class="brand"');
    expect(page).not.toContain("status-icon");
  });

  test("renders the connector success handoff with the Return to Ardor button", () => {
    const page = renderConnectorCallbackPage("connected", "focus-token");

    expect(page).toContain('data-state="success"');
    expect(page).toContain("<h1 id=\"page-title\">Connected</h1>");
    expect(page).toContain('method="get" action="/auth/focus"');
    expect(page).toContain('value="focus-token"');
    expect(page).not.toContain("Sign-in received");
  });

  test("renders a failed connector as an error without the handoff, even with a token", () => {
    const page = renderConnectorCallbackPage("error", "focus-token");

    expect(page).toContain('data-state="error"');
    expect(page).toContain("Not connected");
    expect(page).not.toContain("focus-token");
  });

  test("renders a connected page without the button when the handoff has expired", () => {
    expect(renderConnectorCallbackPage("connected")).not.toContain("/auth/focus");
  });
});
