import { describe, expect, mock, test } from "bun:test";

import { initializeSparkleUpdater, resolveSparkleTestMode } from "./sparkle-updater";

function createBridge() {
  return {
    init: mock(() => true),
    checkForUpdates: mock(() => undefined),
    installUpdateNow: mock(() => undefined),
    setAutomaticChecks: mock(() => undefined),
  };
}

describe("Sparkle updater test harness", () => {
  test("accepts only explicit test modes", () => {
    expect(resolveSparkleTestMode("check")).toBe("check");
    expect(resolveSparkleTestMode("install")).toBe("install");
    expect(resolveSparkleTestMode("enabled")).toBeUndefined();
  });

  test("does not load the native bridge outside packaged macOS", async () => {
    const loadBridge = mock(async () => createBridge());
    expect(
      await initializeSparkleUpdater({
        appIsPackaged: false,
        loadBridge,
        mode: "check",
        platform: "darwin",
      }),
    ).toBe(false);
    expect(
      await initializeSparkleUpdater({
        appIsPackaged: true,
        loadBridge,
        mode: "check",
        platform: "win32",
      }),
    ).toBe(false);
    expect(loadBridge).not.toHaveBeenCalled();
  });

  test("initializes and starts an install check", async () => {
    const bridge = createBridge();
    expect(
      await initializeSparkleUpdater({
        appIsPackaged: true,
        loadBridge: async () => bridge,
        mode: "install",
        platform: "darwin",
      }),
    ).toBe(true);
    expect(bridge.init).toHaveBeenCalledWith({ appcastUrl: "", publicEdKey: "" });
    expect(bridge.setAutomaticChecks).toHaveBeenCalledWith(false);
    expect(bridge.installUpdateNow).toHaveBeenCalledTimes(1);
    expect(bridge.checkForUpdates).not.toHaveBeenCalled();
  });
});
