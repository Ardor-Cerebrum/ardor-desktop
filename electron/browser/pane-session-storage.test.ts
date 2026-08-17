import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import { createFileBrowserPaneSessionStorage } from "./pane-session-storage";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("file-backed BrowserPane session storage", () => {
  test("writes through a private directory and reads the last encrypted payload", () => {
    const root = mkdtempSync(join(tmpdir(), "ardor-pane-session-"));
    temporaryRoots.push(root);
    const filePath = join(root, "nested", "browser-pane-session.bin");
    const storage = createFileBrowserPaneSessionStorage(filePath);

    storage.write("ciphertext");

    expect(storage.read()).toBe("ciphertext");
    expect(readFileSync(filePath, "utf8")).toBe("ciphertext");
  });

  test("returns undefined when the session file is absent or unreadable", () => {
    const root = mkdtempSync(join(tmpdir(), "ardor-pane-session-"));
    temporaryRoots.push(root);
    const storage = createFileBrowserPaneSessionStorage(join(root, "missing", "session.bin"));

    expect(storage.read()).toBeUndefined();
  });
});
