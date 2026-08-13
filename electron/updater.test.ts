import { EventEmitter } from "node:events";

import { describe, expect, test } from "bun:test";

import {
  buildUpdateFeedUrl,
  DesktopUpdater,
  type AutoUpdaterLike,
} from "./updater";

class FakeAutoUpdater extends EventEmitter implements AutoUpdaterLike {
  feedUrl: string | undefined;
  checkCalls = 0;
  quitAndInstallCalls = 0;

  setFeedURL(options: { url: string }): void {
    this.feedUrl = options.url;
  }

  checkForUpdates(): void {
    this.checkCalls += 1;
  }

  quitAndInstall(): void {
    this.quitAndInstallCalls += 1;
  }
}

const baseOptions = {
  appIsPackaged: true,
  channel: "prod",
  platform: "win32",
  arch: "x64",
  version: "0.4.3",
};

function createUpdater(overrides: Partial<typeof baseOptions> = {}) {
  const native = new FakeAutoUpdater();
  const events: unknown[] = [];
  const updater = new DesktopUpdater({
    ...baseOptions,
    ...overrides,
    autoUpdater: native,
    onEvent: (event) => events.push(event),
  });
  return { native, events, updater };
}

describe("buildUpdateFeedUrl", () => {
  test("builds a production feed for supported Electron platforms", () => {
    expect(
      buildUpdateFeedUrl({ channel: "prod", platform: "win32", arch: "x64", version: "0.4.3" }),
    ).toBe("https://update.electronjs.org/Ardor-Cerebrum/ardor-desktop/win32-x64/0.4.3");
    expect(
      buildUpdateFeedUrl({ channel: "prod", platform: "darwin", arch: "arm64", version: "0.4.3" }),
    ).toBe("https://update.electronjs.org/Ardor-Cerebrum/ardor-desktop/darwin-arm64/0.4.3");
  });

  test("does not create feeds for stage, development, or unsupported platforms", () => {
    expect(buildUpdateFeedUrl({ channel: "stage1", platform: "win32", arch: "x64", version: "0.4.3" })).toBeNull();
    expect(buildUpdateFeedUrl({ channel: "prod", platform: "linux", arch: "x64", version: "0.4.3" })).toBeNull();
    expect(buildUpdateFeedUrl({ channel: "prod", platform: "darwin", arch: "x64", version: "0.4.3" })).toBeNull();
    expect(buildUpdateFeedUrl({ channel: "prod", platform: "win32", arch: "arm64", version: "0.4.3" })).toBeNull();
    expect(buildUpdateFeedUrl({ channel: "prod", platform: "win32", arch: "x64", version: "" })).toBeNull();
  });
});

describe("DesktopUpdater", () => {
  test("deduplicates checks and reports no update", async () => {
    const { native, updater } = createUpdater();
    const first = updater.check();
    const second = updater.check();

    expect(native.checkCalls).toBe(1);
    native.emit("update-not-available");

    await expect(first).resolves.toEqual({ status: "up-to-date" });
    await expect(second).resolves.toEqual({ status: "up-to-date" });
    expect(native.feedUrl).toBe("https://update.electronjs.org/Ardor-Cerebrum/ardor-desktop/win32-x64/0.4.3");
  });

  test("waits for the downloaded update and exposes its release name", async () => {
    const { native, updater } = createUpdater();
    const check = updater.check();

    native.emit("update-available");
    let settled = false;
    void check.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    native.emit("update-downloaded", {}, "", "0.4.4", new Date(), "https://example.test/update");
    await expect(check).resolves.toEqual({ status: "available", version: "0.4.4" });
  });

  test("replays coarse native lifecycle phases and relaunches only after download", async () => {
    const { native, events, updater } = createUpdater();
    const check = updater.check();
    native.emit("update-available");
    native.emit("update-downloaded", {}, "", "0.4.4", new Date(), "https://example.test/update");
    await expect(check).resolves.toEqual({ status: "available", version: "0.4.4" });

    expect(await updater.install()).toBe("installed");
    expect(events).toEqual([
      { event: "Started", data: {} },
      { event: "Verifying" },
      { event: "Installing" },
    ]);

    await updater.relaunch();
    expect(native.quitAndInstallCalls).toBe(1);
  });

  test("fails a check on native updater errors", async () => {
    const { native, updater } = createUpdater();
    const check = updater.check();
    native.emit("error", new Error("feed unavailable"));

    await expect(check).rejects.toThrow("feed unavailable");
    await expect(updater.install()).resolves.toBe("up-to-date");
  });

  test("keeps stage1 and unpackaged builds inert", async () => {
    const stage = createUpdater({ channel: "stage1" });
    await expect(stage.updater.check()).resolves.toEqual({ status: "up-to-date" });
    await expect(stage.updater.install()).resolves.toBe("up-to-date");
    expect(stage.native.checkCalls).toBe(0);
    await stage.updater.relaunch();
    expect(stage.native.quitAndInstallCalls).toBe(0);

    const unpackaged = createUpdater({ appIsPackaged: false });
    await expect(unpackaged.updater.check()).resolves.toEqual({ status: "up-to-date" });
    expect(unpackaged.native.checkCalls).toBe(0);
  });

  test("flushes browser persistence before relaunching into an update", async () => {
    let releasePersistence!: () => void;
    const persistence = new Promise<void>((resolve) => {
      releasePersistence = resolve;
    });
    const native = new FakeAutoUpdater();
    const updater = new DesktopUpdater({
      ...baseOptions,
      autoUpdater: native,
      beforeRelaunch: () => persistence,
      onEvent: () => undefined,
    });
    const check = updater.check();
    native.emit("update-downloaded", {}, "", "0.4.4", new Date(), "https://example.test/update");
    await check;

    const relaunch = updater.relaunch();
    expect(native.quitAndInstallCalls).toBe(0);
    releasePersistence();
    await relaunch;

    expect(native.quitAndInstallCalls).toBe(1);
  });
});
