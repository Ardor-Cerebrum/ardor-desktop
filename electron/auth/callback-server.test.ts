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
      expect(focusHtml).toContain("Back in Ardor");
      expect(focusHtml).toContain("<script>window.close()</script>");
      // The page's only script is allowed by its hash, so a changed script must change the header too.
      const scriptHash = new Bun.CryptoHasher("sha256").update("window.close()").digest("base64");
      expect(focus.headers.get("content-security-policy")).toContain(`'sha256-${scriptHash}'`);
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

  test("focuses the desktop window and reports a connector sign-in that returns with its state", async () => {
    const listenPort = 27_641;
    const state = "d3skt0p-St4te_0123456789abcdef";
    let focused = 0;
    const results: unknown[] = [];
    const server = new DesktopAuthCallbackServer({
      listenPort,
      onFocus: () => {
        focused += 1;
        return true;
      },
    });
    server.onConnectorResult((result) => results.push(result));

    await server.start();
    try {
      server.beginConnection(state);
      const returned = await fetch(
        callbackUrl(listenPort, `/connector/callback?connector=gitlab&status=connected&state=${state}`),
      );
      const page = await returned.text();

      expect(returned.status).toBe(200);
      expect(page).toContain("Connected");
      expect(page).toContain("Return to Ardor");
      expect(focused).toBe(1);
      expect(results).toEqual([{ provider: "gitlab", status: "connected" }]);

      const replay = await fetch(
        callbackUrl(listenPort, `/connector/callback?connector=gitlab&status=connected&state=${state}`),
      );
      expect(replay.status).toBe(400);
      expect(focused).toBe(1);
      expect(results).toHaveLength(1);
    } finally {
      await server.stop();
    }
  });

  test("reports a failed connector sign-in without offering the handoff as a success", async () => {
    const listenPort = 27_642;
    const state = "d3skt0p-St4te_0123456789abcdef";
    const results: unknown[] = [];
    const server = new DesktopAuthCallbackServer({ listenPort, onFocus: () => true });
    server.onConnectorResult((result) => results.push(result));

    await server.start();
    try {
      server.beginConnection(state);
      const returned = await fetch(
        callbackUrl(listenPort, `/connector/callback?connector=slack&status=error&state=${state}`),
      );

      expect(returned.status).toBe(200);
      expect(await returned.text()).toContain("Not connected");
      expect(results).toEqual([{ provider: "slack", status: "error" }]);
    } finally {
      await server.stop();
    }
  });

  test("ignores a connector return that was never registered or has the wrong state", async () => {
    const listenPort = 27_643;
    let focused = 0;
    const results: unknown[] = [];
    const server = new DesktopAuthCallbackServer({
      listenPort,
      onFocus: () => {
        focused += 1;
        return true;
      },
    });
    server.onConnectorResult((result) => results.push(result));

    await server.start();
    try {
      const unregistered = await fetch(
        callbackUrl(listenPort, "/connector/callback?connector=gitlab&status=connected&state=d3skt0p-St4te_0123456789abcdef"),
      );
      server.beginConnection("d3skt0p-St4te_0123456789abcdef");
      const wrong = await fetch(
        callbackUrl(listenPort, "/connector/callback?connector=gitlab&status=connected&state=another-St4te_0123456789abc"),
      );

      expect([unregistered.status, wrong.status]).toEqual([400, 400]);
      expect(focused).toBe(0);
      expect(results).toEqual([]);
    } finally {
      await server.stop();
    }
  });

  test("forgets a connector sign-in that was cancelled", async () => {
    const listenPort = 27_644;
    const state = "d3skt0p-St4te_0123456789abcdef";
    const server = new DesktopAuthCallbackServer({ listenPort, onFocus: () => true });

    await server.start();
    try {
      server.beginConnection(state);
      server.cancelConnection(state);
      const returned = await fetch(
        callbackUrl(listenPort, `/connector/callback?connector=gitlab&status=connected&state=${state}`),
      );

      expect(returned.status).toBe(400);
    } finally {
      await server.stop();
    }
  });
});
