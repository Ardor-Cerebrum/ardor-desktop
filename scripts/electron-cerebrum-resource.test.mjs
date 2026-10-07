import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { normalizeCerebrumResourceDirectory, verifyCerebrumRuntimePin } from "./electron-cerebrum-resource.mjs";

test("verifies a pinned runtime archive and the matching manifest source", async () => {
  const root = await mkdtemp(join(tmpdir(), "ardor-cerebrum-pin-"));
  const bundleDirectory = join(root, "runtime");
  const archivePath = join(root, "candidate.zip");
  const sourceCommit = "a".repeat(40);
  const archiveBytes = Buffer.from("verified candidate archive");
  const archiveSha256 = createHash("sha256").update(archiveBytes).digest("hex");
  try {
    await mkdir(bundleDirectory, { recursive: true });
    await writeFile(archivePath, archiveBytes);
    await writeFile(join(bundleDirectory, "manifest.json"), JSON.stringify({
      source: { repository: "Ardor-Cerebrum/cerebrum", commit: sourceCommit },
      target: "x86_64-pc-windows-msvc",
      platform: "win32",
      arch: "x64",
    }));
    const pin = { archivePath, archiveSha256, bundleDirectory, sourceCommit, platform: "win32", arch: "x64" };

    const manifestSha256 = createHash("sha256").update(await readFile(join(bundleDirectory, "manifest.json"))).digest("hex");
    assert.deepEqual(verifyCerebrumRuntimePin(pin), { sourceCommit, manifestSha256 });
    assert.throws(() => verifyCerebrumRuntimePin({ ...pin, archiveSha256: "0".repeat(64) }), /archive digest/);
    assert.throws(() => verifyCerebrumRuntimePin({ ...pin, sourceCommit: "b".repeat(40) }), /source commit/);
    assert.throws(() => verifyCerebrumRuntimePin({ ...pin, sourceCommit: "mutable-ref" }), /pin is invalid/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("normalizes a candidate runtime into the stable resources/cerebrum path", async () => {
  const root = await mkdtemp(join(tmpdir(), "ardor-cerebrum-resource-"));
  const source = join(root, "resources", "candidate-package");
  try {
    await mkdir(join(source, "bin"), { recursive: true });
    await writeFile(join(source, "bin", "codex.exe"), "runtime-binary");
    await normalizeCerebrumResourceDirectory(root, "candidate-package", "win32");

    assert.equal(await readFile(join(root, "resources", "cerebrum", "bin", "codex.exe"), "utf8"), "runtime-binary");
    await assert.rejects(stat(source));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("restores executable permissions for packaged macOS runtime helpers", async (context) => {
  if (process.platform === "win32") context.skip("Windows does not expose POSIX executable mode bits");
  const root = await mkdtemp(join(tmpdir(), "ardor-cerebrum-mac-resource-"));
  const resources = join(root, "Ardor.app", "Contents", "Resources");
  const runtime = join(resources, "cerebrum");
  const executablePaths = [
    "bin/codex",
    "bin/codex-code-mode-host",
    "codex-path/rg",
    "codex-resources/zsh/bin/zsh",
  ];
  try {
    for (const relativePath of executablePaths) {
      const path = join(runtime, relativePath);
      await mkdir(join(path, ".."), { recursive: true });
      await writeFile(path, "binary");
      await chmod(path, 0o644);
    }
    await normalizeCerebrumResourceDirectory(root, "cerebrum", "darwin");

    for (const relativePath of executablePaths) {
      const mode = (await stat(join(runtime, relativePath))).mode;
      assert.notEqual(mode & 0o111, 0);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects an unexpected existing destination rather than replacing runtime files", async () => {
  const root = await mkdtemp(join(tmpdir(), "ardor-cerebrum-resource-conflict-"));
  try {
    await mkdir(join(root, "resources", "candidate"), { recursive: true });
    await mkdir(join(root, "resources", "cerebrum"), { recursive: true });
    await assert.rejects(
      normalizeCerebrumResourceDirectory(root, "candidate", "win32"),
      /destination already exists/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
