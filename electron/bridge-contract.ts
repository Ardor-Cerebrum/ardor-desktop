export const DESKTOP_BRIDGE_CHANNELS = [
  "desktop:runtime:get-info",
  "desktop:auth:get-status",
  "desktop:auth:open-url",
  "desktop:update:get-status",
  "desktop:update:check",
  "desktop:browser:get-status",
] as const;

export type DesktopBridgeChannel = (typeof DESKTOP_BRIDGE_CHANNELS)[number];

const desktopBridgeChannelSet = new Set<string>(DESKTOP_BRIDGE_CHANNELS);

export function isDesktopBridgeChannel(value: string): value is DesktopBridgeChannel {
  return desktopBridgeChannelSet.has(value);
}

export interface ArdorDesktopBridge {
  readonly runtime: {
    getInfo(): Promise<RuntimeInfo>;
  };
  readonly auth: {
    getStatus(): Promise<FeatureStatus>;
    openUrl(url: string): Promise<boolean>;
  };
  readonly updates: {
    getStatus(): Promise<FeatureStatus>;
    check(): Promise<FeatureStatus>;
  };
  readonly browser: {
    getStatus(): Promise<FeatureStatus>;
  };
}

export interface RuntimeInfo {
  readonly platform: NodeJS.Platform;
  readonly shellVersion: string;
}

export interface FeatureStatus {
  readonly state: "unavailable";
}
