import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { deriveEd25519PublicKey, verifySignedUpdateEnvelope } from "../electron/update-signature";
import { parseWindowsUpdateManifest } from "../electron/windows-secure-updater";
import { createWindowsUpdateMetadata } from "./generate-electron-update-metadata";

test("generates a verifiable Windows update envelope for the canonical release package", async () => {
  const root = await mkdtemp(join(tmpdir(), "ardor-update-metadata-"));
  const privateSeed = Buffer.alloc(32, 11).toString("base64");
  const packagePath = join(root, "Ardor-v0.6.0-windows-x64-full.nupkg");
  try {
    await writeFile(packagePath, "package");
    const envelope = await createWindowsUpdateMetadata({
      arch: "x64",
      expiresAt: new Date("2026-09-01T00:00:00.000Z"),
      packagePath,
      privateSeed,
      publishedAt: new Date("2026-08-15T00:00:00.000Z"),
      releaseTag: "v0.6.0",
      repository: "Ardor-Cerebrum/ardor-desktop",
      version: "0.6.0",
    });
    const payload = verifySignedUpdateEnvelope(envelope, deriveEd25519PublicKey(privateSeed));
    const manifest = parseWindowsUpdateManifest(JSON.parse(Buffer.from(payload).toString("utf8")), {
      arch: "x64",
      channel: "prod",
      currentVersion: "0.5.1",
      now: new Date("2026-08-15T12:00:00.000Z"),
      platform: "win32",
    });
    expect(manifest?.artifact.packageName).toBe("Ardor-v0.6.0-windows-x64-full.nupkg");
    expect(manifest?.artifact.url).toBe(
      "https://github.com/Ardor-Cerebrum/ardor-desktop/releases/download/v0.6.0/Ardor-v0.6.0-windows-x64-full.nupkg",
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
