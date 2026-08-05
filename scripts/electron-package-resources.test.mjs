import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { normalizeUiResourceDirectory } from "./electron-package-resources.mjs";

test("normalizes an extraResource UI directory to resources/dist", async () => {
  const packageRoot = await mkdtemp(join(tmpdir(), "ardor-electron-package-"));
  const source = join(packageRoot, "resources", "ardor-ui-dist");
  await mkdir(source, { recursive: true });
  await writeFile(join(source, "index.html"), "<!doctype html>");

  await normalizeUiResourceDirectory(packageRoot, "ardor-ui-dist");

  await assert.doesNotReject(() => Bun.file(join(packageRoot, "resources", "dist", "index.html")).text());
  assert.equal(await Bun.file(join(packageRoot, "resources", "dist", "index.html")).text(), "<!doctype html>");
  assert.equal(await Bun.file(join(packageRoot, "resources", "ardor-ui-dist", "index.html")).exists(), false);
});
