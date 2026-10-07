import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { deflateRawSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { normalizeCerebrumResourceDirectory, verifyCerebrumRuntimePin } from "./electron-cerebrum-resource.mjs";

const requirements = JSON.parse(readFileSync(new URL("../desktop-cerebrum-requirements.json", import.meta.url), "utf8"));

test("verifies that the extracted runtime matches the immutable archive contents", async () => {
  const root = await mkdtemp(join(tmpdir(), "ardor-cerebrum-pin-"));
  const bundleDirectory = join(root, "runtime");
  const archivePath = join(root, "candidate.zip");
  const sourceCommit = requirements.sourceCommit;
  const executable = Buffer.from("runtime binary");
  const manifest = {
    schemaVersion: 1,
    source: { repository: "Ardor-Cerebrum/cerebrum", commit: sourceCommit },
    target: "x86_64-pc-windows-msvc",
    platform: "win32",
    arch: "x64",
    protocol: { name: "codex-app-server", version: 2, transport: "stdio", args: ["app-server", "--stdio"] },
    entrypoint: "bin/codex.exe",
    files: [{
      path: "bin/codex.exe",
      sizeBytes: executable.byteLength,
      sha256: createHash("sha256").update(executable).digest("hex"),
    }],
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  const archiveBytes = createDeflatedZip([
    { name: "bin/codex.exe", bytes: executable },
    { name: "manifest.json", bytes: manifestBytes },
  ]);
  const archiveSha256 = createHash("sha256").update(archiveBytes).digest("hex");
  try {
    await mkdir(join(bundleDirectory, "bin"), { recursive: true });
    await writeFile(join(bundleDirectory, "bin", "codex.exe"), executable);
    await writeFile(archivePath, archiveBytes);
    await writeFile(join(bundleDirectory, "manifest.json"), manifestBytes);
    const pin = { archivePath, archiveSha256, bundleDirectory, sourceCommit, platform: "win32", arch: "x64", trustedRoot: root };

    const manifestSha256 = createHash("sha256").update(manifestBytes).digest("hex");
    assert.deepEqual(verifyCerebrumRuntimePin(pin), { sourceCommit, manifestSha256, bundleDirectory });
    assert.throws(
      () => verifyCerebrumRuntimePin({ ...pin, trustedRoot: join(root, "runtime") }),
      /outside the trusted build root/,
    );
    assert.throws(() => verifyCerebrumRuntimePin({ ...pin, archiveSha256: "0".repeat(64) }), /archive digest/);
    assert.throws(() => verifyCerebrumRuntimePin({ ...pin, sourceCommit: "b".repeat(40) }), /source commit/);
    assert.throws(() => verifyCerebrumRuntimePin({ ...pin, sourceCommit: "mutable-ref" }), /pin is invalid/);

    await writeFile(join(bundleDirectory, "manifest.json"), JSON.stringify({ ...manifest, files: [] }));
    assert.throws(() => verifyCerebrumRuntimePin(pin), /manifest does not match the pinned archive/);

    const incompatibleManifest = {
      ...manifest,
      protocol: { ...manifest.protocol, version: manifest.protocol.version + 1 },
    };
    const incompatibleManifestBytes = Buffer.from(JSON.stringify(incompatibleManifest));
    const incompatibleArchive = createDeflatedZip([
      { name: "bin/codex.exe", bytes: executable },
      { name: "manifest.json", bytes: incompatibleManifestBytes },
    ]);
    await writeFile(archivePath, incompatibleArchive);
    await writeFile(join(bundleDirectory, "manifest.json"), incompatibleManifestBytes);
    assert.throws(
      () => verifyCerebrumRuntimePin({
        ...pin,
        archiveSha256: createHash("sha256").update(incompatibleArchive).digest("hex"),
      }),
      /protocol does not match Desktop requirements/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function createDeflatedZip(entries) {
  let localOffset = 0;
  const localParts = [];
  const centralParts = [];
  for (const { name, bytes } of entries) {
    const filename = Buffer.from(name);
    const compressed = deflateRawSync(bytes);
    const crc = crc32(bytes);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(8, 8);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(compressed.byteLength, 18);
    localHeader.writeUInt32LE(bytes.byteLength, 22);
    localHeader.writeUInt16LE(filename.byteLength, 26);
    localParts.push(localHeader, filename, compressed);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(8, 10);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(compressed.byteLength, 20);
    centralHeader.writeUInt32LE(bytes.byteLength, 24);
    centralHeader.writeUInt16LE(filename.byteLength, 28);
    centralHeader.writeUInt32LE(localOffset, 42);
    centralParts.push(centralHeader, filename);
    localOffset += localHeader.byteLength + filename.byteLength + compressed.byteLength;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.byteLength, 12);
  end.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

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

test("rejects dot segments as Cerebrum resource names", async () => {
  await assert.rejects(
    normalizeCerebrumResourceDirectory(tmpdir(), ".", "win32"),
    /single path component/,
  );
  await assert.rejects(
    normalizeCerebrumResourceDirectory(tmpdir(), "..", "win32"),
    /single path component/,
  );
  await assert.rejects(
    normalizeCerebrumResourceDirectory(tmpdir(), "C:runtime", "win32"),
    /single path component/,
  );
});

if (process.platform !== "win32") {
  test("restores executable permissions for packaged macOS runtime helpers", async () => {
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
}

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
