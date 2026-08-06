import { describe, expect, test } from "bun:test";

import { resolveMainWindowChrome } from "./window-chrome";

describe("main window chrome", () => {
  test("uses the standard Windows titlebar overlay", () => {
    expect(resolveMainWindowChrome("win32")).toEqual({
      titleBarStyle: "hidden",
      titleBarOverlay: true,
    });
  });

  test("leaves non-Windows titlebars unchanged", () => {
    expect(resolveMainWindowChrome("darwin")).toEqual({});
    expect(resolveMainWindowChrome("linux")).toEqual({});
  });
});
