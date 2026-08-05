import { contextBridge, ipcRenderer } from "electron";

import type {
  ArdorDesktopBridge,
  DesktopBridgeChannel,
  FeatureStatus,
  RuntimeInfo,
} from "./bridge-contract.js";

declare global {
  interface Window {
    ardorDesktop: ArdorDesktopBridge;
  }
}

function invoke<T>(channel: DesktopBridgeChannel, ...args: unknown[]): Promise<T> {
  return ipcRenderer.invoke(channel, ...args) as Promise<T>;
}

const unavailable = (): Promise<FeatureStatus> =>
  invoke<FeatureStatus>("desktop:browser:get-status");

const bridge: ArdorDesktopBridge = Object.freeze({
  runtime: Object.freeze({
    getInfo: () => invoke<RuntimeInfo>("desktop:runtime:get-info"),
  }),
  auth: Object.freeze({
    getStatus: () => invoke<FeatureStatus>("desktop:auth:get-status"),
    openUrl: (url: string) => invoke<boolean>("desktop:auth:open-url", url),
  }),
  updates: Object.freeze({
    getStatus: () => invoke<FeatureStatus>("desktop:update:get-status"),
    check: () => invoke<FeatureStatus>("desktop:update:check"),
  }),
  browser: Object.freeze({
    getStatus: unavailable,
  }),
});

contextBridge.exposeInMainWorld("ardorDesktop", bridge);
