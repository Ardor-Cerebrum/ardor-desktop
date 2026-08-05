import { describe, expect, test } from "bun:test";

import { DesktopAuthCallbackServer } from "./callback-server";

describe("DesktopAuthCallbackServer", () => {
  test("serves the callback handoff and returns focus to the desktop window", async () => {
    let focused = 0;
    const server = new DesktopAuthCallbackServer({
      onFocus: () => {
        focused += 1;
        return true;
      },
    });

    await server.start();
    try {
      server.beginAuthorization("https://auth.example/authorize?state=expected");
      const callback = await fetch(
        "http://127.0.0.1:17631/auth/callback?code=good&state=expected",
      );
      const callbackHtml = await callback.text();
      const token = callbackHtml.match(/name="token" value="([^"]+)"/)?.[1];

      expect(callback.status).toBe(200);
      expect(callbackHtml).toContain("Sign-in received");
      expect(callbackHtml).toContain("Return to Ardor");
      expect(token).toBeTruthy();

      const focus = await fetch(
        `http://127.0.0.1:17631/auth/focus?token=${encodeURIComponent(token ?? "")}`,
      );
      const focusHtml = await focus.text();

      expect(focus.status).toBe(200);
      expect(focusHtml).toContain("Returning to Ardor");
      expect(focusHtml).toContain("window.close()");
      expect(focused).toBe(1);

      const replay = await fetch(
        `http://127.0.0.1:17631/auth/focus?token=${encodeURIComponent(token ?? "")}`,
      );
      expect(replay.status).toBe(404);
      expect(focused).toBe(1);
    } finally {
      await server.stop();
    }
  });
});
