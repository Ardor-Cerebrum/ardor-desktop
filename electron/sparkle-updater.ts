import type { SparkleBridge } from "electron-sparkle-updater";

export type SparkleTestMode = "check" | "install";

export interface InitializeSparkleUpdaterOptions {
  appIsPackaged: boolean;
  loadBridge?: (log: (message: string) => void) => Promise<SparkleBridge | null>;
  log?: (message: string) => void;
  mode: SparkleTestMode | undefined;
  platform: string;
}

export function resolveSparkleTestMode(value: string | undefined): SparkleTestMode | undefined {
  return value === "check" || value === "install" ? value : undefined;
}

export async function initializeSparkleUpdater(
  options: InitializeSparkleUpdaterOptions,
): Promise<boolean> {
  if (options.platform !== "darwin" || !options.appIsPackaged || !options.mode) {
    return false;
  }

  const log = options.log ?? (() => undefined);
  const loadBridge = options.loadBridge ?? defaultLoadBridge;
  const bridge = await loadBridge(log);
  if (!bridge?.init({ appcastUrl: "", publicEdKey: "" })) {
    log("Sparkle bridge did not initialize");
    return false;
  }

  bridge.setAutomaticChecks(false);
  if (options.mode === "install") {
    bridge.installUpdateNow();
  } else {
    bridge.checkForUpdates();
  }
  return true;
}

async function defaultLoadBridge(log: (message: string) => void): Promise<SparkleBridge | null> {
  const { loadSparkleBridgeForApp } = await import("electron-sparkle-updater");
  return loadSparkleBridgeForApp(log);
}
