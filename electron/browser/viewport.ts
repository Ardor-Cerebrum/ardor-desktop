import type { BrowserPaneViewport } from "../bridge-contract";
import type { BrowserBounds } from "./controller";

const CHROME_MAJOR_VERSION = process.versions.chrome?.split(".")[0] ?? "0";
const CHROME_FULL_VERSION = `${CHROME_MAJOR_VERSION}.0.0.0`;

export const MOBILE_VIEWPORT_USER_AGENT = `Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_FULL_VERSION} Mobile Safari/537.36`;
export const MOBILE_VIEWPORT_USER_AGENT_METADATA = {
  brands: [
    { brand: "Chromium", version: CHROME_MAJOR_VERSION },
    { brand: "Google Chrome", version: CHROME_MAJOR_VERSION },
    { brand: "Not=A?Brand", version: "24" },
  ],
  fullVersion: CHROME_FULL_VERSION,
  fullVersionList: [
    { brand: "Chromium", version: CHROME_FULL_VERSION },
    { brand: "Google Chrome", version: CHROME_FULL_VERSION },
    { brand: "Not=A?Brand", version: "24.0.0.0" },
  ],
  platform: "Android",
  platformVersion: "14.0.0",
  architecture: "",
  model: "Pixel 8",
  mobile: true,
};

export type BrowserViewportCommand = (method: string, params?: Record<string, unknown>) => Promise<unknown>;

export interface BrowserViewportLayout {
  x: number;
  y: number;
  width: number;
  height: number;
  scale: number;
}

export function calculateBrowserViewportLayout(
  bounds: BrowserBounds,
  viewport: BrowserPaneViewport,
): BrowserViewportLayout {
  const scale = bounds.width > 0 && bounds.height > 0
    ? Math.min(1, bounds.width / viewport.width, bounds.height / viewport.height)
    : 0;
  const width = Math.round(viewport.width * scale);
  const height = Math.round(viewport.height * scale);
  return {
    x: Math.round((bounds.width - width) / 2),
    y: 0,
    width,
    height,
    scale,
  };
}

export class BrowserViewportEmulation {
  private viewport: BrowserPaneViewport | null = null;
  private lastScale: number | null = null;
  private mobileActive: boolean | null = null;
  private mobileChain = Promise.resolve();

  constructor(private readonly sendCommand: BrowserViewportCommand) {}

  async set(viewport: BrowserPaneViewport | null): Promise<void> {
    this.viewport = viewport;
    this.lastScale = null;
    if (!viewport) {
      await this.sendCommand("Emulation.clearDeviceMetricsOverride");
      await this.setMobile(false);
      return;
    }
    await this.apply(viewport);
  }

  layout(bounds: BrowserBounds): BrowserViewportLayout | null {
    if (!this.viewport) return null;
    const layout = calculateBrowserViewportLayout(bounds, this.viewport);
    if (
      layout.scale > 0 &&
      (this.lastScale === null ||
        Math.abs(layout.scale - this.lastScale) > 0.01 ||
        (layout.scale === 1) !== (this.lastScale === 1))
    ) {
      this.lastScale = layout.scale;
      void this.apply(this.viewport, layout.scale).catch(() => {
        this.lastScale = null;
      });
    }
    return layout;
  }

  private async apply(viewport: BrowserPaneViewport, scale?: number): Promise<void> {
    await this.sendCommand("Emulation.setDeviceMetricsOverride", {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: viewport.mobile ? 2 : 0,
      mobile: viewport.mobile,
      ...(scale === undefined ? {} : { scale }),
    });
    await this.setMobile(viewport.mobile);
  }

  private setMobile(enabled: boolean): Promise<void> {
    const apply = async () => {
      if (this.mobileActive === enabled) return;
      this.mobileActive = null;
      await this.sendCommand(
        "Emulation.setUserAgentOverride",
        enabled
          ? { userAgent: MOBILE_VIEWPORT_USER_AGENT, userAgentMetadata: MOBILE_VIEWPORT_USER_AGENT_METADATA }
          : { userAgent: "" },
      );
      await this.sendCommand("Emulation.setTouchEmulationEnabled", {
        enabled,
        ...(enabled ? { maxTouchPoints: 5 } : {}),
      });
      await this.sendCommand("Emulation.setEmitTouchEventsForMouse", {
        enabled,
        ...(enabled ? { configuration: "mobile" } : {}),
      });
      this.mobileActive = enabled;
    };
    const transition = this.mobileChain.then(apply, apply);
    this.mobileChain = transition.catch(() => undefined);
    return transition;
  }
}
