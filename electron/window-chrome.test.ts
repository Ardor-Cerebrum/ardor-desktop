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

  test("uses native Windows colors for overlay controls", () => {
    expect(resolveMainWindowChrome("win32")).toEqual({
      titleBarStyle: "hidden",
      titleBarOverlay: {
        height: 45,
      },
    });
  });

  test("leaves the Linux titlebar unchanged", () => {
    expect(resolveMainWindowChrome("linux")).toEqual({});
  });
});
