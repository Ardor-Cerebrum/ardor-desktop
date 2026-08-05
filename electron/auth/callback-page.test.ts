import { describe, expect, test } from "bun:test";

import { renderAuthCallbackPage, renderAuthFocusPage } from "./callback-page";

describe("desktop auth callback pages", () => {
  test("renders the Tauri-style success handoff", () => {
    const page = renderAuthCallbackPage(200, "Sign-in is continuing in Ardor Desktop.", "focus-token");

    expect(page).toContain('data-state="success"');
    expect(page).toContain("Sign-in received");
    expect(page).toContain("ARDOR");
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

    expect(page).toContain("Returning to Ardor");
    expect(page).toContain("If this tab does not close automatically, you can close it.");
    expect(page).toContain("<script>setTimeout(() => window.close(), 5000)</script>");
  });
});
