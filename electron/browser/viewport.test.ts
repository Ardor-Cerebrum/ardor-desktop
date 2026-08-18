import { describe, expect, mock, test } from "bun:test";

import { BrowserViewportEmulation, calculateBrowserViewportLayout } from "./viewport";

describe("browser viewport emulation", () => {
  test("centers and scales a fixed viewport without enlarging it", () => {
    expect(calculateBrowserViewportLayout({ x: 20, y: 30, width: 300, height: 600 }, {
      width: 375,
      height: 812,
      mobile: true,
    })).toEqual({ x: 12, y: 0, width: 277, height: 600, scale: 600 / 812 });
    expect(calculateBrowserViewportLayout({ x: 0, y: 0, width: 900, height: 1200 }, {
      width: 768,
      height: 1024,
      mobile: false,
    })).toEqual({ x: 66, y: 0, width: 768, height: 1024, scale: 1 });
  });

  test("applies mobile metrics and clears every override for responsive mode", async () => {
    const sendCommand = mock(async () => ({}));
    const emulation = new BrowserViewportEmulation(sendCommand);

    await emulation.set({ width: 375, height: 812, mobile: true });
    emulation.layout({ x: 0, y: 0, width: 300, height: 600 });
    await Promise.resolve();
    await Promise.resolve();

    expect(sendCommand).toHaveBeenCalledWith("Emulation.setDeviceMetricsOverride", {
      width: 375,
      height: 812,
      deviceScaleFactor: 2,
      mobile: true,
    });
    expect(sendCommand).toHaveBeenCalledWith(
      "Emulation.setUserAgentOverride",
      expect.objectContaining({ userAgent: expect.stringContaining("Pixel 8") }),
    );
    expect(sendCommand).toHaveBeenCalledWith("Emulation.setTouchEmulationEnabled", {
      enabled: true,
      maxTouchPoints: 5,
    });
    expect(sendCommand).toHaveBeenCalledWith(
      "Emulation.setDeviceMetricsOverride",
      expect.objectContaining({ scale: 600 / 812 }),
    );

    await emulation.set(null);
    expect(sendCommand).toHaveBeenCalledWith("Emulation.clearDeviceMetricsOverride");
    expect(sendCommand).toHaveBeenCalledWith("Emulation.setUserAgentOverride", { userAgent: "" });
    expect(sendCommand).toHaveBeenCalledWith("Emulation.setTouchEmulationEnabled", { enabled: false });
  });
});
