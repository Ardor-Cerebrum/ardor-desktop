import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DesktopUpdateNativeEvent } from "./bridge-contract";
import { createSignedUpdateEnvelope, deriveEd25519PublicKey } from "./update-signature";
import {
  createSecureWindowsUpdater,
  parseWindowsUpdateManifest,
  type WindowsUpdateManifest,
} from "./windows-secure-updater";

const PRIVATE_SEED = Buffer.alloc(32, 9).toString("base64");
const PUBLIC_KEY = deriveEd25519PublicKey(PRIVATE_SEED);
const FEED_URL = "https://github.com/Ardor-Cerebrum/ardor-desktop/releases/download/electron-update-feed/windows-x64.json";
const PACKAGE_URL = "https://github.com/Ardor-Cerebrum/ardor-desktop/releases/download/v0.6.0/Ardor-0.6.0-full.nupkg";
const PACKAGE = Buffer.from("signed Windows update package");

class FakeAutoUpdater extends EventEmitter {
  feedUrl: string | undefined;
  checks = 0;
  relaunches = 0;

  setFeedURL(options: { url: string }) {
    this.feedUrl = options.url;
  }

  checkForUpdates() {
    this.checks += 1;
    queueMicrotask(() => this.emit("update-downloaded", {}, "notes", "0.6.0"));
  }

  quitAndInstall() {
    this.relaunches += 1;
  }
}

function manifest(overrides: Partial<WindowsUpdateManifest> = {}): WindowsUpdateManifest {
  return {
    arch: "x64",
    artifact: {
      packageName: "Ardor-0.6.0-full.nupkg",
      sha256: createHash("sha256").update(PACKAGE).digest("hex"),
      size: PACKAGE.byteLength,
      url: PACKAGE_URL,
    },
    channel: "prod",
    expiresAt: "2026-09-01T00:00:00.000Z",
    platform: "win32",
    publishedAt: "2026-08-15T00:00:00.000Z",
    schema: 1,
    version: "0.6.0",
    ...overrides,
  };
}

function response(body: Buffer, streaming = false) {
  return {
    ok: true,
    status: 200,
    arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
    body: streaming
      ? (async function* () {
          yield body.subarray(0, 8);
          yield body.subarray(8);
        })()
      : null,
  };
}

function signedManifest(value = manifest()) {
  const payload = Buffer.from(JSON.stringify(value));
  return Buffer.from(JSON.stringify(createSignedUpdateEnvelope(payload, PRIVATE_SEED)));
}

describe("secure Windows updater", () => {
  test("verifies, downloads, stages, and explicitly relaunches a signed update", async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), "ardor-windows-update-"));
    const native = new FakeAutoUpdater();
    const events: DesktopUpdateNativeEvent[] = [];
    let persisted = false;
    try {
      const updater = createSecureWindowsUpdater({
        appIsPackaged: true,
        arch: "x64",
        autoUpdater: native as never,
        beforeRelaunch: async () => {
          persisted = true;
        },
        cacheRoot,
        channel: "prod",
        currentVersion: "0.5.1",
        feedUrl: FEED_URL,
        fetch: async (url) => (url.startsWith(FEED_URL) ? response(signedManifest()) : response(PACKAGE, true)),
        now: () => new Date("2026-08-15T12:00:00.000Z"),
        onEvent: (event) => events.push(event),
        platform: "win32",
        publicKey: PUBLIC_KEY,
        updatesEnabled: true,
      });
      expect(updater).not.toBeNull();
      expect(await updater!.check()).toEqual({ status: "available", version: "0.6.0" });
      expect(await updater!.install()).toBe("installed");
      expect(native.checks).toBe(1);
      expect(native.feedUrl).toContain(join(cacheRoot, "0.6.0"));
      expect(await readFile(join(cacheRoot, "0.6.0", "Ardor-0.6.0-full.nupkg"))).toEqual(PACKAGE);
      expect(await readFile(join(cacheRoot, "0.6.0", "RELEASES"), "utf8")).toContain(
        `Ardor-0.6.0-full.nupkg ${PACKAGE.byteLength}`,
      );
      expect(events.map((event) => event.event)).toEqual([
        "Started",
        "Progress",
        "Progress",
        "Verifying",
        "Installing",
      ]);
      await updater!.relaunch();
      expect(persisted).toBe(true);
      expect(native.relaunches).toBe(1);
    } finally {
      await rm(cacheRoot, { force: true, recursive: true });
    }
  });

  test("rejects a tampered signed manifest before downloading a package", async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), "ardor-windows-update-"));
    let requests = 0;
    try {
      const envelope = JSON.parse(signedManifest().toString("utf8"));
      envelope.payload = Buffer.from(JSON.stringify(manifest({ version: "9.9.9" }))).toString("base64");
      const updater = createSecureWindowsUpdater({
        appIsPackaged: true,
        arch: "x64",
        autoUpdater: new FakeAutoUpdater() as never,
        cacheRoot,
        channel: "prod",
        currentVersion: "0.5.1",
        feedUrl: FEED_URL,
        fetch: async () => {
          requests += 1;
          return response(Buffer.from(JSON.stringify(envelope)));
        },
        now: () => new Date("2026-08-15T12:00:00.000Z"),
        onEvent: () => undefined,
        platform: "win32",
        publicKey: PUBLIC_KEY,
        updatesEnabled: true,
      });
      await expect(updater!.check()).rejects.toThrow("signature is invalid");
      expect(requests).toBe(1);
    } finally {
      await rm(cacheRoot, { force: true, recursive: true });
    }
  });

  test("rejects expired, mismatched, malformed, and non-newer manifests", () => {
    const expected = {
      arch: "x64",
      channel: "prod",
      currentVersion: "0.5.1",
      now: new Date("2026-08-15T12:00:00.000Z"),
      platform: "win32",
    };
    expect(parseWindowsUpdateManifest(manifest({ version: "0.5.1" }), expected)).toBeNull();
    expect(() =>
      parseWindowsUpdateManifest(manifest({ expiresAt: "2026-08-15T11:59:59.000Z" }), expected),
    ).toThrow("validity window");
    expect(() =>
      parseWindowsUpdateManifest(
        manifest({ expiresAt: "2026-08-15T12:01:00.000Z", publishedAt: "2026-08-15T12:02:00.000Z" }),
        expected,
      ),
    ).toThrow("validity window");
    expect(() => parseWindowsUpdateManifest({ ...manifest(), arch: "arm64" }, expected)).toThrow(
      "manifest is invalid",
    );
    expect(() =>
      parseWindowsUpdateManifest(
        { ...manifest(), artifact: { ...manifest().artifact, packageName: "../update.nupkg" } },
        expected,
      ),
    ).toThrow("package name is invalid");
  });

  test("stays disabled outside a packaged production Windows x64 build", () => {
    const common = {
      appIsPackaged: true,
      arch: "x64",
      autoUpdater: new FakeAutoUpdater() as never,
      cacheRoot: "/tmp/unused",
      channel: "prod",
      currentVersion: "0.5.1",
      feedUrl: FEED_URL,
      fetch: async () => response(signedManifest()),
      onEvent: () => undefined,
      platform: "win32",
      publicKey: PUBLIC_KEY,
      updatesEnabled: true,
    };
    expect(createSecureWindowsUpdater({ ...common, appIsPackaged: false })).toBeNull();
    expect(createSecureWindowsUpdater({ ...common, channel: "stage1" })).toBeNull();
    expect(createSecureWindowsUpdater({ ...common, platform: "darwin" })).toBeNull();
    expect(createSecureWindowsUpdater({ ...common, publicKey: undefined })).toBeNull();
  });
});
