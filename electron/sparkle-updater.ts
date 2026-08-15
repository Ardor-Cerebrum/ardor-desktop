import type { SparkleBridge, SparkleBridgeEvent } from "electron-sparkle-updater";

import type { DesktopUpdateNativeEvent } from "./bridge-contract.js";
import type {
  DesktopUpdateCheckResult,
  DesktopUpdateController,
  DesktopUpdateInstallResult,
} from "./updater.js";

const DEFAULT_POLL_INTERVAL_MS = 100;
const DEFAULT_STAGE_TIMEOUT_MS = 10 * 60 * 1000;

export type SparkleTestMode = "check" | "install";

export interface CreateSparkleDesktopUpdaterOptions {
  appIsPackaged: boolean;
  beforeRelaunch?: () => Promise<void>;
  loadBridge?: (log: (message: string) => void) => Promise<SparkleBridge | null>;
  log?: (message: string) => void;
  onEvent: (event: DesktopUpdateNativeEvent) => void;
  platform: string;
  pollIntervalMs?: number;
  stageTimeoutMs?: number;
  updatesEnabled: boolean;
}

interface SparkleDesktopUpdaterOptions {
  beforeRelaunch?: () => Promise<void>;
  bridge: SparkleBridge;
  onEvent: (event: DesktopUpdateNativeEvent) => void;
  pollIntervalMs: number;
  stageTimeoutMs: number;
}

interface Deferred<T> {
  promise: Promise<T>;
  reject: (error: Error) => void;
  resolve: (value: T) => void;
}

export class SparkleDesktopUpdater implements DesktopUpdateController {
  private availableVersion: string | undefined;
  private checkDeferred: Deferred<DesktopUpdateCheckResult> | undefined;
  private cycleError: Error | undefined;
  private cycleRunning = false;
  private downloadStarted = false;
  private emittedDownloadStart = false;
  private installDeferred: Deferred<DesktopUpdateInstallResult> | undefined;
  private installRequested = false;
  private lifecycleEvents: DesktopUpdateNativeEvent[] = [];
  private ready = false;

  constructor(private readonly options: SparkleDesktopUpdaterOptions) {}

  check(): Promise<DesktopUpdateCheckResult> {
    if (!this.cycleError && this.availableVersion) {
      return Promise.resolve({ status: "available", version: this.availableVersion });
    }
    if (this.checkDeferred) {
      return this.checkDeferred.promise;
    }

    this.prepareCycle();
    this.checkDeferred = createDeferred<DesktopUpdateCheckResult>();
    this.cycleRunning = true;
    this.options.bridge.startUpdateDownload();
    void this.monitorCycle();
    return this.checkDeferred.promise;
  }

  install(): Promise<DesktopUpdateInstallResult> {
    if (this.cycleError) {
      return this.retryInstall();
    }
    if (!this.availableVersion && !this.ready) {
      return Promise.resolve("up-to-date");
    }
    if (this.installDeferred) {
      return this.installDeferred.promise;
    }

    this.installRequested = true;
    this.flushLifecycleEvents();
    if (this.ready) {
      return Promise.resolve("installed");
    }

    this.installDeferred = createDeferred<DesktopUpdateInstallResult>();
    return this.installDeferred.promise;
  }

  async relaunch(): Promise<void> {
    if (!this.ready || !this.options.bridge.isUpdateReady()) {
      return;
    }
    await this.options.beforeRelaunch?.();
    this.options.bridge.installReadyUpdate();
  }

  private async monitorCycle(): Promise<void> {
    const deadline = Date.now() + this.options.stageTimeoutMs;
    while (this.cycleRunning) {
      for (const event of this.options.bridge.takeEvents()) {
        this.handleBridgeEvent(event);
      }
      if (!this.cycleRunning) {
        return;
      }
      if (Date.now() >= deadline) {
        this.failCycle(new Error("Sparkle update download timed out."));
        return;
      }
      await delay(this.options.pollIntervalMs);
    }
  }

  private prepareCycle(): void {
    this.options.bridge.resetUpdate();
    this.availableVersion = undefined;
    this.cycleError = undefined;
    this.downloadStarted = false;
    this.emittedDownloadStart = false;
    this.installRequested = false;
    this.lifecycleEvents = [];
    this.ready = false;
  }

  private handleBridgeEvent(event: SparkleBridgeEvent): void {
    switch (event.event) {
      case "Found":
        this.availableVersion = event.data.version.trim() || "available";
        this.resolveCheck({ status: "available", version: this.availableVersion });
        return;
      case "Started":
        this.downloadStarted = true;
        return;
      case "ContentLength":
        this.emitDownloadStart({ contentLength: event.data.contentLength });
        return;
      case "Progress":
        this.emitDownloadStart({});
        this.emitLifecycle({ event: "Progress", data: { chunkLength: event.data.chunkLength } });
        return;
      case "Verifying":
        this.emitDownloadStart({});
        this.emitLifecycle({ event: "Verifying" });
        return;
      case "Ready":
        this.ready = true;
        this.cycleRunning = false;
        this.resolveCheck({ status: "available", version: this.availableVersion ?? "available" });
        this.installDeferred?.resolve("installed");
        this.installDeferred = undefined;
        return;
      case "NotFound":
        this.cycleRunning = false;
        this.resolveCheck({ status: "up-to-date" });
        this.installDeferred?.resolve("up-to-date");
        this.installDeferred = undefined;
        this.options.bridge.resetUpdate();
        return;
      case "Error":
        this.failCycle(new Error(event.data.message));
        return;
    }
  }

  private emitDownloadStart(data: { contentLength?: number }): void {
    if (this.emittedDownloadStart || !this.downloadStarted) {
      return;
    }
    this.emittedDownloadStart = true;
    this.emitLifecycle({ event: "Started", data });
  }

  private emitLifecycle(event: DesktopUpdateNativeEvent): void {
    if (this.installRequested) {
      this.options.onEvent(event);
      return;
    }
    this.lifecycleEvents.push(event);
  }

  private flushLifecycleEvents(): void {
    for (const event of this.lifecycleEvents) {
      this.options.onEvent(event);
    }
    this.lifecycleEvents = [];
  }

  private failCycle(error: Error): void {
    this.cycleError = error;
    this.cycleRunning = false;
    this.checkDeferred?.reject(error);
    this.checkDeferred = undefined;
    this.installDeferred?.reject(error);
    this.installDeferred = undefined;
    this.options.bridge.resetUpdate();
  }

  private resolveCheck(result: DesktopUpdateCheckResult): void {
    this.checkDeferred?.resolve(result);
    this.checkDeferred = undefined;
  }

  private async retryInstall(): Promise<DesktopUpdateInstallResult> {
    const result = await this.check();
    return result.status === "available" ? this.install() : "up-to-date";
  }
}

export function resolveSparkleTestMode(value: string | undefined): SparkleTestMode | undefined {
  return value === "check" || value === "install" ? value : undefined;
}

export async function createSparkleDesktopUpdater(
  options: CreateSparkleDesktopUpdaterOptions,
): Promise<SparkleDesktopUpdater | null> {
  if (options.platform !== "darwin" || !options.appIsPackaged || !options.updatesEnabled) {
    return null;
  }

  const log = options.log ?? (() => undefined);
  const loadBridge = options.loadBridge ?? defaultLoadBridge;
  const bridge = await loadBridge(log);
  if (!bridge?.init({ appcastUrl: "", publicEdKey: "" })) {
    log("Sparkle bridge did not initialize");
    return null;
  }
  bridge.setAutomaticChecks(false);
  return new SparkleDesktopUpdater({
    beforeRelaunch: options.beforeRelaunch,
    bridge,
    onEvent: options.onEvent,
    pollIntervalMs: options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    stageTimeoutMs: options.stageTimeoutMs ?? DEFAULT_STAGE_TIMEOUT_MS,
  });
}

export async function runSparkleTestMode(
  updater: DesktopUpdateController,
  mode: SparkleTestMode | undefined,
  log: (message: string) => void,
): Promise<void> {
  if (!mode) {
    return;
  }
  const result = await updater.check();
  log(`test check result: ${JSON.stringify(result)}`);
  if (mode !== "install" || result.status !== "available") {
    return;
  }
  const installResult = await updater.install();
  log(`test install result: ${installResult}`);
  if (installResult === "installed") {
    await updater.relaunch();
  }
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function defaultLoadBridge(log: (message: string) => void): Promise<SparkleBridge | null> {
  const { loadSparkleBridgeForApp } = await import("electron-sparkle-updater");
  return loadSparkleBridgeForApp(log);
}
