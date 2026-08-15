import { describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";

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
  test("keeps the native install-now path confirmed through final relaunch", () => {
    const packageJson = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { patchedDependencies?: Record<string, string> };
    const patchPath = packageJson.patchedDependencies?.["electron-sparkle-updater@0.2.0"];

    expect(patchPath).toBe("patches/electron-sparkle-updater@0.2.0.patch");
    if (!patchPath) {
      throw new Error("Sparkle updater native patch is not configured.");
    }
    const nativePatch = readFileSync(new URL(`../${patchPath}`, import.meta.url), "utf8");
    expect(nativePatch).toContain("showReadyToInstallAndRelaunch");
    expect(nativePatch).toContain("reply(SPUUserUpdateChoiceInstall)");
    expect(nativePatch).toContain("auto-accepting ready-to-install update");
  });

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
