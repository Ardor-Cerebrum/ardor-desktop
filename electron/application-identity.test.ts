import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import { resolveDesktopApplicationName, resolveDesktopUserDataPath } from "./application-identity";

describe("desktop application identity", () => {
  test("uses the explicit build channel when it is available", () => {
    expect(
      resolveDesktopApplicationName({
        channel: "prod",
        executablePath: "/Applications/Ardor Dev.app/Contents/MacOS/Ardor Dev",
        isPackaged: true,
      }),
    ).toBe("Ardor");
    expect(
      resolveDesktopApplicationName({
        channel: "stage1",
        executablePath: "/Applications/Ardor.app/Contents/MacOS/Ardor",
        isPackaged: true,
      }),
    ).toBe("Ardor Dev");
  });

  test("recovers the packaged channel from the executable name", () => {
    expect(
      resolveDesktopApplicationName({
        executablePath: "/Applications/Ardor.app/Contents/MacOS/Ardor",
        isPackaged: true,
      }),
    ).toBe("Ardor");
    expect(
      resolveDesktopApplicationName({
        executablePath: "/Applications/Ardor Dev.app/Contents/MacOS/Ardor Dev",
        isPackaged: true,
      }),
    ).toBe("Ardor Dev");
    expect(
      resolveDesktopApplicationName({
        executablePath: String.raw`C:\Program Files\Ardor Dev\Ardor Dev.exe`,
        isPackaged: true,
      }),
    ).toBe("Ardor Dev");
    expect(
      resolveDesktopApplicationName({
        executablePath: String.raw`C:\Program Files\Ardor\Ardor.exe`,
        isPackaged: true,
      }),
    ).toBe("Ardor");
  });

  test("defaults local Electron runs to the development identity", () => {
    expect(
      resolveDesktopApplicationName({
        executablePath: "/path/to/Electron.app/Contents/MacOS/Electron",
        isPackaged: false,
      }),
    ).toBe("Ardor Dev");
  });

  test("keeps profile data under a stable channel-specific directory", () => {
    const appDataPath = resolve("app-data");

    expect(resolveDesktopUserDataPath(appDataPath, "Ardor Dev")).toBe(resolve(appDataPath, "Ardor Dev"));
  });
});
