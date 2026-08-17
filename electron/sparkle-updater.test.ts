import { describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";

import type { SparkleBridge, SparkleBridgeEvent } from "electron-sparkle-updater";

import {
  createSparkleDesktopUpdater,
  resolveSparkleTestMode,
  runSparkleTestMode,
  SparkleDesktopUpdater,
} from "./sparkle-updater";

class FakeSparkleBridge implements SparkleBridge {
  readonly checkForUpdates = mock(() => undefined);
  readonly init = mock(() => true);
  readonly installReadyUpdate = mock(() => undefined);
  readonly installUpdateNow = mock(() => undefined);
  readonly resetUpdate = mock(() => undefined);
  readonly setAutomaticChecks = mock((_enabled: boolean) => undefined);
  readonly startUpdateDownload = mock(() => undefined);
  events: SparkleBridgeEvent[] = [];
  ready = false;

  isUpdateReady(): boolean {
    return this.ready;
  }

  takeEvents(): SparkleBridgeEvent[] {
    return this.events.splice(0);
  }
}

function createUpdater(bridge = new FakeSparkleBridge()) {
  const events: unknown[] = [];
  const updater = new SparkleDesktopUpdater({
    bridge,
    onEvent: (event) => events.push(event),
    pollIntervalMs: 1,
    stageTimeoutMs: 100,
  });
  return { bridge, events, updater };
}

describe("Sparkle updater native contract", () => {
  test("keeps staged download and explicit relaunch exports in the dependency patch", () => {
    const packageJson = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { patchedDependencies?: Record<string, string> };
    const patchPath = packageJson.patchedDependencies?.["electron-sparkle-updater@0.2.0"];

    expect(patchPath).toBe("patches/electron-sparkle-updater@0.2.0.patch");
    if (!patchPath) {
      throw new Error("Sparkle updater native patch is not configured.");
    }
    const nativePatch = readFileSync(new URL(`../${patchPath}`, import.meta.url), "utf8");
    expect(nativePatch).toContain("startUpdateDownload");
    expect(nativePatch).toContain("installReadyUpdate");
    expect(nativePatch).toContain("showReadyToInstallAndRelaunch");
    expect(nativePatch).toContain("update staged and ready to relaunch");
  });
});

describe("SparkleDesktopUpdater", () => {
  test("reports availability, streams download state, and waits for an explicit relaunch", async () => {
    const { bridge, events, updater } = createUpdater();
    const check = updater.check();
    expect(bridge.startUpdateDownload).toHaveBeenCalledTimes(1);

    bridge.events.push({ event: "Found", data: { version: "0.5.3" } });
    await expect(check).resolves.toEqual({ status: "available", version: "0.5.3" });

    const install = updater.install();
    bridge.events.push(
      { event: "Started" },
      { event: "ContentLength", data: { contentLength: 100 } },
      { event: "Progress", data: { chunkLength: 40 } },
      { event: "Verifying" },
    );
    await waitFor(() => events.length === 3);
    expect(events).toEqual([
      { event: "Started", data: { contentLength: 100 } },
      { event: "Progress", data: { chunkLength: 40 } },
      { event: "Verifying" },
    ]);
    expect(bridge.installReadyUpdate).not.toHaveBeenCalled();

    bridge.ready = true;
    bridge.events.push({ event: "Ready" });
    await expect(install).resolves.toBe("installed");
    expect(bridge.installReadyUpdate).not.toHaveBeenCalled();

    await updater.relaunch();
    expect(bridge.installReadyUpdate).toHaveBeenCalledTimes(1);
  });

  test("buffers lifecycle events until installation is requested", async () => {
    const { bridge, events, updater } = createUpdater();
    const check = updater.check();
    bridge.events.push(
      { event: "Found", data: { version: "0.5.3" } },
      { event: "Started" },
      { event: "Progress", data: { chunkLength: 12 } },
      { event: "Verifying" },
    );
    await check;
    await waitFor(() => bridge.events.length === 0);
    expect(events).toEqual([]);

    const install = updater.install();
    expect(events).toEqual([
      { event: "Started", data: {} },
      { event: "Progress", data: { chunkLength: 12 } },
      { event: "Verifying" },
    ]);
    bridge.ready = true;
    bridge.events.push({ event: "Ready" });
    await expect(install).resolves.toBe("installed");
  });

  test("returns up to date and restarts a failed download when the user retries", async () => {
    const noUpdate = createUpdater();
    const noUpdateCheck = noUpdate.updater.check();
    noUpdate.bridge.events.push({ event: "NotFound" });
    await expect(noUpdateCheck).resolves.toEqual({ status: "up-to-date" });
    await expect(noUpdate.updater.install()).resolves.toBe("up-to-date");
    expect(noUpdate.bridge.resetUpdate).toHaveBeenCalledTimes(2);

    const failed = createUpdater();
    const failedCheck = failed.updater.check();
    failed.bridge.events.push({ event: "Error", data: { message: "signature rejected" } });
    await expect(failedCheck).rejects.toThrow("signature rejected");

    const retry = failed.updater.install();
    expect(failed.bridge.startUpdateDownload).toHaveBeenCalledTimes(2);
    failed.bridge.events.push({ event: "Found", data: { version: "0.5.3" } });
    await waitFor(() => failed.bridge.events.length === 0);
    failed.bridge.ready = true;
    failed.bridge.events.push({ event: "Ready" });
    await expect(retry).resolves.toBe("installed");
  });

  test("flushes persistent data before installing the staged update", async () => {
    const bridge = new FakeSparkleBridge();
    let releasePersistence!: () => void;
    const persistence = new Promise<void>((resolve) => {
      releasePersistence = resolve;
    });
    const updater = new SparkleDesktopUpdater({
      beforeRelaunch: () => persistence,
      bridge,
      onEvent: () => undefined,
      pollIntervalMs: 1,
      stageTimeoutMs: 100,
    });
    const check = updater.check();
    bridge.events.push({ event: "Found", data: { version: "0.5.3" } });
    await check;
    bridge.ready = true;
    bridge.events.push({ event: "Ready" });
    await updater.install();

    const relaunch = updater.relaunch();
    expect(bridge.installReadyUpdate).not.toHaveBeenCalled();
    releasePersistence();
    await relaunch;
    expect(bridge.installReadyUpdate).toHaveBeenCalledTimes(1);
  });
});

describe("Sparkle updater wiring", () => {
  test("loads the native updater only for enabled packaged macOS builds", async () => {
    const bridge = new FakeSparkleBridge();
    const loadBridge = mock(async () => bridge);
    const common = {
      loadBridge,
      onEvent: () => undefined,
      platform: "darwin",
      updatesEnabled: true,
    };

    expect(await createSparkleDesktopUpdater({ ...common, appIsPackaged: false })).toBeNull();
    expect(await createSparkleDesktopUpdater({ ...common, appIsPackaged: true, platform: "win32" })).toBeNull();
    expect(await createSparkleDesktopUpdater({ ...common, appIsPackaged: true, updatesEnabled: false })).toBeNull();
    expect(loadBridge).not.toHaveBeenCalled();

    expect(await createSparkleDesktopUpdater({ ...common, appIsPackaged: true })).toBeInstanceOf(
      SparkleDesktopUpdater,
    );
    expect(bridge.init).toHaveBeenCalledWith({ appcastUrl: "", publicEdKey: "" });
    expect(bridge.setAutomaticChecks).toHaveBeenCalledWith(false);
  });

  test("accepts only explicit test modes and drives the same controller", async () => {
    expect(resolveSparkleTestMode("check")).toBe("check");
    expect(resolveSparkleTestMode("install")).toBe("install");
    expect(resolveSparkleTestMode("enabled")).toBeUndefined();

    const controller = {
      check: mock(async () => ({ status: "available" as const, version: "0.5.3" })),
      install: mock(async () => "installed" as const),
      relaunch: mock(async () => undefined),
    };
    await runSparkleTestMode(controller, "install", () => undefined);
    expect(controller.check).toHaveBeenCalledTimes(1);
    expect(controller.install).toHaveBeenCalledTimes(1);
    expect(controller.relaunch).toHaveBeenCalledTimes(1);
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 500;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("condition was not reached");
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}
