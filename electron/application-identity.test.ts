import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import { resolveDesktopApplicationIdentity, resolveDesktopUserDataPath } from "./application-identity";

describe("desktop application identity", () => {
  test("uses the explicit build channel only for unpackaged development", () => {
    expect(
      resolveDesktopApplicationIdentity({
        channel: "prod",
        executablePath: "/path/to/Electron.app/Contents/MacOS/Electron",
        isPackaged: false,
      }),
    ).toEqual({ applicationName: "Ardor", channel: "prod" });
    expect(
      resolveDesktopApplicationIdentity({
        channel: "stage1",
        executablePath: "/path/to/Electron.app/Contents/MacOS/Electron",
        isPackaged: false,
      }),
    ).toEqual({ applicationName: "Ardor Dev", channel: "stage1" });
  });

  test("recovers the packaged channel from the executable name", () => {
    expect(
      resolveDesktopApplicationIdentity({
        channel: "stage1",
        executablePath: "/Applications/Ardor.app/Contents/MacOS/Ardor",
        isPackaged: true,
      }),
    ).toEqual({ applicationName: "Ardor", channel: "prod" });
    expect(
      resolveDesktopApplicationIdentity({
        channel: "prod",
        executablePath: "/Applications/Ardor Dev.app/Contents/MacOS/Ardor Dev",
        isPackaged: true,
      }),
    ).toEqual({ applicationName: "Ardor Dev", channel: "stage1" });
    expect(
      resolveDesktopApplicationIdentity({
        executablePath: String.raw`C:\Program Files\Ardor Dev\Ardor Dev.exe`,
        isPackaged: true,
      }),
    ).toEqual({ applicationName: "Ardor Dev", channel: "stage1" });
    expect(
      resolveDesktopApplicationIdentity({
        executablePath: String.raw`C:\Program Files\Ardor\Ardor.exe`,
        isPackaged: true,
      }),
    ).toEqual({ applicationName: "Ardor", channel: "prod" });
  });

  test("defaults local Electron runs to the development identity", () => {
    expect(
      resolveDesktopApplicationIdentity({
        executablePath: "/path/to/Electron.app/Contents/MacOS/Electron",
        isPackaged: false,
      }),
    ).toEqual({ applicationName: "Ardor Dev", channel: "stage1" });
  });

  test("keeps profile data under a stable channel-specific directory", () => {
    const appDataPath = resolve("app-data");

    expect(resolveDesktopUserDataPath(appDataPath, "Ardor Dev")).toBe(resolve(appDataPath, "Ardor Dev"));
  });
});
