import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import { resolveAppAssetPath } from "./app-assets";

const fixtureRoots: string[] = [];
afterEach(async () => {
  for (const root of fixtureRoots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("shell app asset resolution", () => {
  test("falls back to index.html for an extensionless SPA route", async () => {
    const root = await createFixtureRoot();
    await mkdir(join(root, "assets"), { recursive: true });
    await writeFile(join(root, "index.html"), "<!doctype html>");
    await writeFile(join(root, "assets", "app.js"), "console.log('ok')");

    expect(resolveAppAssetPath(root, "/signed-out")).toBe(join(root, "index.html"));
  });

  test("does not turn missing static assets into the application shell", async () => {
    const root = await createFixtureRoot();
    await writeFile(join(root, "index.html"), "<!doctype html>");

    expect(resolveAppAssetPath(root, "/assets/missing.js")).toBeNull();
  });
});

async function createFixtureRoot(): Promise<string> {
  // NOTE: macOS /var is a symlink; the asset boundary expects a canonical root.
  const root = await realpath(await mkdtemp(join(tmpdir(), "ardor-app-assets-")));
  fixtureRoots.push(root);
  return root;
}
