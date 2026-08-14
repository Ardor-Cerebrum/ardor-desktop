import { describe, expect, test } from "bun:test";

import { DesktopAuthCallbackServer } from "./callback-server";

const callbackUrl = (port: number, path: string) => `http://127.0.0.1:${port}${path}`;

describe("DesktopAuthCallbackServer", () => {
  test("focuses the desktop window when the browser callback arrives", async () => {
    const listenPort = 27_631;
    let focused = 0;
    const server = new DesktopAuthCallbackServer({
      listenPort,
      onFocus: () => {
        focused += 1;
        return true;
      },
    });

    expect(server.getStatus().listening).toBe(false);
    await server.start();
    try {
      expect(server.getStatus()).toEqual({
        callbackUrl: "http://127.0.0.1:17631/auth/callback",
        listening: true,
        error: null,
      });
      server.beginAuthorization("https://auth.example/authorize?state=expected");
      const callback = await fetch(
        callbackUrl(listenPort, "/auth/callback?code=good&state=expected"),
      );

      expect(callback.status).toBe(200);
      expect(focused).toBe(1);

      const replay = await fetch(
        callbackUrl(listenPort, "/auth/callback?code=replay&state=expected"),
      );
      expect(replay.status).toBe(400);
      expect(server.getPending()?.callbackUrl).toContain("code=good");
    } finally {
      await server.stop();
    }
    expect(server.getStatus().listening).toBe(false);
  });

  test("serves the callback handoff and returns focus to the desktop window", async () => {
    const listenPort = 27_632;
    let focused = 0;
    const server = new DesktopAuthCallbackServer({
      listenPort,
      onFocus: () => {
        focused += 1;
        return true;
      },
    });

    await server.start();
    try {
      server.beginAuthorization("https://auth.example/authorize?state=expected");
      const callback = await fetch(
        callbackUrl(listenPort, "/auth/callback?code=good&state=expected"),
      );
      const callbackHtml = await callback.text();
      const token = callbackHtml.match(/name="token" value="([^"]+)"/)?.[1];

      expect(callback.status).toBe(200);
      expect(callbackHtml).toContain("Sign-in received");
      expect(callbackHtml).toContain("Return to Ardor");
      expect(token).toBeTruthy();

      const focus = await fetch(
        callbackUrl(listenPort, `/auth/focus?token=${encodeURIComponent(token ?? "")}`),
      );
      const focusHtml = await focus.text();

      expect(focus.status).toBe(200);
      expect(focusHtml).toContain("Returning to Ardor");
      expect(focusHtml).toContain("window.close()");
      expect(focused).toBe(2);

      const replay = await fetch(
        callbackUrl(listenPort, `/auth/focus?token=${encodeURIComponent(token ?? "")}`),
      );
      expect(replay.status).toBe(404);
      expect(focused).toBe(2);
    } finally {
      await server.stop();
    }
  });

  test("reports a callback listener bind failure", async () => {
    const listenPort = 27_633;
    const owner = new DesktopAuthCallbackServer({ listenPort });
    const blocked = new DesktopAuthCallbackServer({ listenPort });

    await owner.start();
    try {
      await expect(blocked.start()).rejects.toThrow();
      expect(blocked.getStatus().listening).toBe(false);
      expect(blocked.getStatus().error).toBeTruthy();
    } finally {
      await blocked.stop();
      await owner.stop();
    }
  });

  test("shares one pending listen attempt across concurrent callers", async () => {
    const server = new DesktopAuthCallbackServer({ listenPort: 27_634 });
    const first = server.start();
    const second = server.start();

    expect(second).toBe(first);
    try {
      await Promise.all([first, second]);
      expect(server.getStatus().listening).toBe(true);
    } finally {
      await server.stop();
    }
  });
});
