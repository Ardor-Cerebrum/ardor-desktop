import type { DesktopUpdateNativeEvent } from "./bridge-contract.js";

const UPDATE_SERVICE_ORIGIN = "https://update.electronjs.org";
const UPDATE_REPOSITORY = "Ardor-Cerebrum/ardor-desktop";
const SUPPORTED_RELEASE_TARGETS = new Set(["darwin-arm64", "win32-x64"]);

export type AutoUpdaterLike = Pick<
  Electron.AutoUpdater,
  "setFeedURL" | "checkForUpdates" | "quitAndInstall" | "on"
>;

export type DesktopUpdateCheckResult =
  | { status: "up-to-date" }
  | { status: "available"; version: string };

export type DesktopUpdateInstallResult = "installed" | "up-to-date";

export interface UpdateFeedOptions {
  channel: string | undefined;
  platform: string;
  arch: string;
  version: string;
}

export interface DesktopUpdaterOptions extends UpdateFeedOptions {
  appIsPackaged: boolean;
  autoUpdater: AutoUpdaterLike;
  onEvent: (event: DesktopUpdateNativeEvent) => void;
}

export function buildUpdateFeedUrl(options: UpdateFeedOptions): string | null {
  const version = options.version.trim();
  if (
    options.channel !== "prod" ||
    !SUPPORTED_RELEASE_TARGETS.has(`${options.platform}-${options.arch}`) ||
    !version
  ) {
    return null;
  }

  return `${UPDATE_SERVICE_ORIGIN}/${UPDATE_REPOSITORY}/${options.platform}-${options.arch}/${encodeURIComponent(version)}`;
}

export class DesktopUpdater {
  private readonly feedUrl: string | null;
  private configured = false;
  private checkPromise: Promise<DesktopUpdateCheckResult> | undefined;
  private pendingCheck:
    | {
        resolve: (result: DesktopUpdateCheckResult) => void;
        reject: (error: Error) => void;
      }
    | undefined;
  private availableVersion: string | undefined;
  private downloaded = false;
  private installPromise: Promise<DesktopUpdateInstallResult> | undefined;

  constructor(private readonly options: DesktopUpdaterOptions) {
    this.feedUrl = options.appIsPackaged ? buildUpdateFeedUrl(options) : null;
    if (!this.feedUrl) {
      return;
    }

    options.autoUpdater.on("update-not-available", () => {
      this.availableVersion = undefined;
      this.downloaded = false;
      this.resolveCheck({ status: "up-to-date" });
    });
    options.autoUpdater.on("update-downloaded", (_event, _releaseNotes, releaseName) => {
      this.availableVersion = releaseName?.trim() || "available";
      this.downloaded = true;
      this.resolveCheck({ status: "available", version: this.availableVersion });
    });
    options.autoUpdater.on("error", (cause) => {
      const error = cause instanceof Error ? cause : new Error("desktop update failed");
      this.availableVersion = undefined;
      this.downloaded = false;
      this.rejectCheck(error);
    });
  }

  check(): Promise<DesktopUpdateCheckResult> {
    if (!this.feedUrl) {
      return Promise.resolve({ status: "up-to-date" });
    }
    if (this.downloaded && this.availableVersion) {
      return Promise.resolve({ status: "available", version: this.availableVersion });
    }
    if (this.checkPromise) {
      return this.checkPromise;
    }

    this.configure();
    let resolve!: (result: DesktopUpdateCheckResult) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<DesktopUpdateCheckResult>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    this.checkPromise = promise;
    this.pendingCheck = { resolve, reject };
    try {
      this.options.autoUpdater.checkForUpdates();
    } catch (cause) {
      this.rejectCheck(cause instanceof Error ? cause : new Error("desktop update check failed"));
    }
    return promise;
  }

  install(): Promise<DesktopUpdateInstallResult> {
    if (!this.feedUrl || !this.availableVersion) {
      return Promise.resolve("up-to-date");
    }
    if (this.installPromise) {
      return this.installPromise;
    }

    this.installPromise = this.installDownloadedUpdate().finally(() => {
      this.installPromise = undefined;
    });
    return this.installPromise;
  }

  relaunch(): void {
    if (!this.feedUrl || !this.downloaded) {
      return;
    }
    this.options.autoUpdater.quitAndInstall();
  }

  private configure(): void {
    if (this.configured || !this.feedUrl) {
      return;
    }
    this.options.autoUpdater.setFeedURL({ url: this.feedUrl });
    this.configured = true;
  }

  private async installDownloadedUpdate(): Promise<DesktopUpdateInstallResult> {
    if (!this.downloaded) {
      return "up-to-date";
    }
    this.options.onEvent({ event: "Started", data: {} });
    this.options.onEvent({ event: "Verifying" });
    this.options.onEvent({ event: "Installing" });
    return "installed";
  }

  private resolveCheck(result: DesktopUpdateCheckResult): void {
    const pending = this.pendingCheck;
    if (!pending) {
      return;
    }
    this.pendingCheck = undefined;
    this.checkPromise = undefined;
    pending.resolve(result);
  }

  private rejectCheck(error: Error): void {
    const pending = this.pendingCheck;
    if (!pending) {
      return;
    }
    this.pendingCheck = undefined;
    this.checkPromise = undefined;
    pending.reject(error);
  }
}
