import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { resolveCerebrumBinary } from "./app-server-client";

test("resolves packaged Cerebrum only from application resources", () => {
  const root = mkdtempSync(join(tmpdir(), "ardor-cerebrum-resolver-"));
  try {
    const bundledDirectory = join(root, "resources", "cerebrum");
    const bundledBinary = join(bundledDirectory, "cerebrum");
    mkdirSync(bundledDirectory, { recursive: true });
    writeFileSync(bundledBinary, "binary");

    expect(
      resolveCerebrumBinary({
        appPath: join(root, "app"),
        isPackaged: true,
        platform: "darwin",
        resourcesPath: join(root, "resources"),
      }),
    ).toBe(realpathSync(bundledBinary));
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("does not fall back to a development checkout for packaged applications", () => {
  const root = mkdtempSync(join(tmpdir(), "ardor-cerebrum-resolver-"));
  try {
    const developmentBinary = join(root, "codex", "cerebrum-rs", "target", "release", "cerebrum");
    mkdirSync(dirname(developmentBinary), { recursive: true });
    writeFileSync(developmentBinary, "binary");

    expect(() =>
      resolveCerebrumBinary({
        appPath: join(root, "ardor-desktop"),
        isPackaged: true,
        platform: "darwin",
        resourcesPath: join(root, "resources"),
      }),
    ).toThrow("Cerebrum binary is unavailable");
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
