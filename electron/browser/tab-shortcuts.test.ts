import { describe, expect, test } from "bun:test";

import { matchBrowserTabShortcut } from "./tab-shortcuts";

function input(overrides: Partial<Electron.Input> = {}): Electron.Input {
  return {
    alt: false,
    code: "KeyT",
    control: false,
    isAutoRepeat: false,
    key: "t",
    meta: false,
    shift: false,
    type: "keyDown",
    ...overrides,
  } as Electron.Input;
}

describe("browser tab shortcuts", () => {
  test("matches Meta+T/W only on macOS", () => {
    expect(matchBrowserTabShortcut(input({ meta: true, key: "t" }), "darwin")).toBe("newTab");
    expect(matchBrowserTabShortcut(input({ meta: true, key: "W" }), "darwin")).toBe("closeTab");
    expect(matchBrowserTabShortcut(input({ control: true }), "darwin")).toBeUndefined();
  });

  test("matches Control+T/W only on Windows and Linux", () => {
    expect(matchBrowserTabShortcut(input({ control: true, key: "t" }), "win32")).toBe("newTab");
    expect(matchBrowserTabShortcut(input({ control: true, key: "W" }), "linux")).toBe("closeTab");
    expect(matchBrowserTabShortcut(input({ meta: true }), "win32")).toBeUndefined();
    expect(matchBrowserTabShortcut(input({ meta: true }), "linux")).toBeUndefined();
  });

  test("matches the element selection shortcut on every platform", () => {
    expect(matchBrowserTabShortcut(input({ meta: true, shift: true, code: "KeyS" }), "darwin")).toBe(
      "toggleSelection",
    );
    expect(matchBrowserTabShortcut(input({ control: true, shift: true, code: "KeyS" }), "linux")).toBe(
      "toggleSelection",
    );
    expect(
      matchBrowserTabShortcut(input({ meta: true, shift: true, code: "KeyS", isAutoRepeat: true }), "darwin"),
    ).toBeUndefined();
    expect(matchBrowserTabShortcut(input({ meta: true, shift: true, code: "KeyS" }), "darwin", true)).toBeUndefined();
  });

  test("matches F6 and Control+F6 as page focus exit shortcuts", () => {
    expect(matchBrowserTabShortcut(input({ code: "F6", key: "F6" }), "darwin")).toBe("focusExit");
    expect(matchBrowserTabShortcut(input({ code: "F6", control: true, key: "F6" }), "darwin")).toBe("focusExit");
    expect(matchBrowserTabShortcut(input({ code: "F6", key: "F6", shift: true }), "linux")).toBe("focusExit");
    expect(matchBrowserTabShortcut(input({ alt: true, code: "F6", key: "F6" }), "linux")).toBeUndefined();
    expect(matchBrowserTabShortcut(input({ code: "F6", key: "F6", meta: true }), "darwin")).toBeUndefined();
  });

  test("rejects extra modifiers, key-up events, and unrelated keys", () => {
    expect(matchBrowserTabShortcut(input({ meta: true, control: true }), "darwin")).toBeUndefined();
    expect(matchBrowserTabShortcut(input({ meta: true, shift: true }), "darwin")).toBeUndefined();
    expect(matchBrowserTabShortcut(input({ meta: true, alt: true }), "darwin")).toBeUndefined();
    expect(matchBrowserTabShortcut(input({ meta: true, type: "keyUp" }), "darwin")).toBeUndefined();
    expect(matchBrowserTabShortcut(input({ meta: true, key: "Tab" }), "darwin")).toBeUndefined();
  });

  test("claims matching auto-repeat without forwarding another action", () => {
    expect(matchBrowserTabShortcut(input({ meta: true, isAutoRepeat: true }), "darwin")).toBe("claim");
    expect(
      matchBrowserTabShortcut(input({ control: true, key: "w", isAutoRepeat: true }), "linux"),
    ).toBe("claim");
    expect(matchBrowserTabShortcut(input({ code: "F6", key: "F6", isAutoRepeat: true }), "linux")).toBe("claim");
  });

  test("claims matching synthetic input without forwarding another action", () => {
    expect(matchBrowserTabShortcut(input({ meta: true }), "darwin", true)).toBe("claim");
    expect(matchBrowserTabShortcut(input({ control: true, key: "w" }), "win32", true)).toBe("claim");
    expect(matchBrowserTabShortcut(input({ code: "F6", key: "F6" }), "linux", true)).toBe("claim");
  });
});
