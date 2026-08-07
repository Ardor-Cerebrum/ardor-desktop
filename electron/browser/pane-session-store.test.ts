import { describe, expect, test } from "bun:test";

import { BrowserPaneSessionStore } from "./pane-session-store";

function createMemoryStorage() {
  let value: string | undefined;
  return {
    read: () => value,
    write: (next: string) => {
      value = next;
    },
  };
}

function createProtector(supported = true) {
  return {
    supported,
    encrypt: (value: string) => Buffer.from(value, "utf8").toString("base64"),
    decrypt: (value: string) => Buffer.from(value, "base64").toString("utf8"),
  };
}

describe("BrowserPaneSessionStore", () => {
  test("round-trips ordered tabs and the active tab through encrypted storage", () => {
    const storage = createMemoryStorage();
    const protector = createProtector();
    const store = new BrowserPaneSessionStore({ storage, protector, debounceMs: 0 });

    store.set("browser:one", {
      activeTabId: "tab-2",
      tabs: [
        { id: "tab-1", url: "https://example.com/first" },
        { id: "tab-2", url: "https://example.com/second" },
      ],
    });
    store.flush();

    expect(storage.read()).toBeDefined();
    expect(storage.read()).not.toContain("example.com");

    const restored = new BrowserPaneSessionStore({ storage, protector, debounceMs: 0 });
    expect(restored.get("browser:one")).toEqual({
      activeTabId: "tab-2",
      tabs: [
        { id: "tab-1", url: "https://example.com/first" },
        { id: "tab-2", url: "https://example.com/second" },
      ],
    });
  });

  test("fails closed when safe storage is unavailable", () => {
    const storage = createMemoryStorage();
    const store = new BrowserPaneSessionStore({ storage, protector: createProtector(false), debounceMs: 0 });

    store.set("browser:one", { activeTabId: "tab-1", tabs: [{ id: "tab-1", url: "https://example.com/" }] });
    store.flush();

    expect(storage.read()).toBeUndefined();
    const restored = new BrowserPaneSessionStore({ storage, protector: createProtector(false), debounceMs: 0 });
    expect(restored.get("browser:one")).toBeUndefined();
  });

  test("ignores corrupt encrypted manifests instead of throwing", () => {
    const storage = createMemoryStorage();
    storage.write(createProtector().encrypt("not-json"));

    const store = new BrowserPaneSessionStore({ storage, protector: createProtector(), debounceMs: 0 });

    expect(store.get("browser:one")).toBeUndefined();
  });

  test("drops unsafe URLs and duplicate tab ids while reading a recovered manifest", () => {
    const storage = createMemoryStorage();
    const protector = createProtector();
    storage.write(
      protector.encrypt(
        JSON.stringify({
          version: 1,
          contexts: {
            "browser:one": {
              activeTabId: "tab-2",
              tabs: [
                { id: "tab-1", url: "https://example.com/" },
                { id: "tab-1", url: "https://duplicate.test/" },
                { id: "tab-2", url: "https://user:pass@example.com/" },
              ],
            },
          },
        }),
      ),
    );

    const store = new BrowserPaneSessionStore({ storage, protector, debounceMs: 0 });

    expect(store.get("browser:one")).toEqual({
      activeTabId: "tab-1",
      tabs: [{ id: "tab-1", url: "https://example.com/" }],
    });
  });

  test("removes a context from the persisted manifest when it is explicitly closed", () => {
    const storage = createMemoryStorage();
    const protector = createProtector();
    const store = new BrowserPaneSessionStore({ storage, protector, debounceMs: 0 });
    store.set("browser:one", { activeTabId: "tab-1", tabs: [{ id: "tab-1", url: "https://example.com/" }] });
    store.flush();

    store.delete("browser:one");
    store.flush();

    const restored = new BrowserPaneSessionStore({ storage, protector, debounceMs: 0 });
    expect(restored.get("browser:one")).toBeUndefined();
  });
});
