import { describe, expect, mock, test } from "bun:test";

import { createWindowsBackgroundTray, type BackgroundTray } from "./background-tray";

describe("Windows background tray", () => {
  test("does not create a tray on other platforms", () => {
    const createTray = mock((_iconPath: string): BackgroundTray => {
      throw new Error("unexpected tray creation");
    });

    expect(
      createWindowsBackgroundTray({
        appName: "Ardor",
        buildMenu: mock(() => ({})),
        createTray,
        iconPath: "icon.ico",
        onOpen: mock(() => undefined),
        onQuit: mock(() => undefined),
        platform: "darwin",
      }),
    ).toBeUndefined();
    expect(createTray).not.toHaveBeenCalled();
  });

  test("opens from click/menu and exposes an explicit Quit command", () => {
    let trayClick: (() => void) | undefined;
    let menuTemplate: Array<{
      click?: () => void;
      label?: string;
      type?: "separator";
    }> = [];
    const tray: BackgroundTray = {
      destroy: mock(() => undefined),
      on: mock((_event, listener) => {
        trayClick = listener;
      }),
      setContextMenu: mock((_menu) => undefined),
      setToolTip: mock((_tooltip) => undefined),
    };
    const onOpen = mock(() => undefined);
    const onQuit = mock(() => undefined);
    const buildMenu = mock((template: typeof menuTemplate) => {
      menuTemplate = template;
      return { template };
    });

    const result = createWindowsBackgroundTray({
      appName: "Ardor Dev",
      buildMenu,
      createTray: mock((iconPath) => {
        expect(iconPath).toBe("stage1/icon.ico");
        return tray;
      }),
      iconPath: "stage1/icon.ico",
      onOpen,
      onQuit,
      platform: "win32",
    });

    expect(result).toBe(tray);
    expect(tray.setToolTip).toHaveBeenCalledWith("Ardor Dev");
    expect(menuTemplate.map(({ label, type }) => label ?? type)).toEqual([
      "Open Ardor",
      "separator",
      "Quit",
    ]);
    trayClick?.();
    menuTemplate[0]?.click?.();
    menuTemplate[2]?.click?.();
    expect(onOpen).toHaveBeenCalledTimes(2);
    expect(onQuit).toHaveBeenCalledTimes(1);
  });
});
