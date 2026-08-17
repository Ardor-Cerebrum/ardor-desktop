import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import { resolveAppAssetPath } from "./app-assets";

describe("shell app asset resolution", () => {
  test("falls back to index.html for an extensionless SPA route", async () => {
    const root = await mkdtemp(join(tmpdir(), "ardor-app-assets-"));
    await mkdir(join(root, "assets"), { recursive: true });
    await writeFile(join(root, "index.html"), "<!doctype html>");
    await writeFile(join(root, "assets", "app.js"), "console.log('ok')");

    expect(resolveAppAssetPath(root, "/signed-out")).toBe(join(root, "index.html"));
  });

  test("does not turn missing static assets into the application shell", async () => {
    const root = await mkdtemp(join(tmpdir(), "ardor-app-assets-"));
    await writeFile(join(root, "index.html"), "<!doctype html>");

    expect(resolveAppAssetPath(root, "/assets/missing.js")).toBeNull();
  });
});
