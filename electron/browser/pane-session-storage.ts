import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";

import type { BrowserPaneSessionStorage } from "./pane-session-store";

export function createFileBrowserPaneSessionStorage(filePath: string): BrowserPaneSessionStorage {
  const targetPath = resolve(filePath);
  return {
    read: () => {
      try {
        return readFileSync(targetPath, "utf8");
      } catch {
        return undefined;
      }
    },
    write: (value) => {
      const directory = dirname(targetPath);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const temporaryPath = `${targetPath}.${randomUUID()}.tmp`;
      try {
        writeFileSync(temporaryPath, value, { encoding: "utf8", mode: 0o600 });
        chmodSync(temporaryPath, 0o600);
        renameSync(temporaryPath, targetPath);
        chmodSync(targetPath, 0o600);
      } finally {
        try {
          unlinkSync(temporaryPath);
        } catch {
          // The rename succeeded or the temporary file was never created.
        }
      }
    },
  };
}
