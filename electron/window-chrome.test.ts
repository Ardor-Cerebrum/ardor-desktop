import { describe, expect, test } from "bun:test";

import { resolveMainWindowChrome } from "./window-chrome";

describe("main window chrome", () => {
  test("overlays the macOS titlebar and aligns native traffic lights with the app toolbar", () => {
    expect(resolveMainWindowChrome("darwin")).toEqual({
      titleBarStyle: "hidden",
      trafficLightPosition: {
        x: 17,
        y: 17,
      },
    });
  });

  test("leaves the Windows titlebar native so controls follow the OS theme", () => {
    expect(resolveMainWindowChrome("win32")).toEqual({});
  });

  test("leaves the Linux titlebar unchanged", () => {
    expect(resolveMainWindowChrome("linux")).toEqual({});
  });
});
