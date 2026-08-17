import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";

import {
  createSignedUpdateEnvelope,
  deriveEd25519PublicKey,
} from "../electron/update-signature";
import type { WindowsUpdateManifest } from "../electron/windows-secure-updater";

export interface WindowsMetadataOptions {
  arch: "x64";
  expiresAt: Date;
  packagePath: string;
  privateSeed: string;
  publishedAt: Date;
  releaseTag: string;
  repository: string;
  version: string;
}

export async function createWindowsUpdateMetadata(options: WindowsMetadataOptions) {
  if (options.releaseTag !== `v${options.version}`) {
    throw new Error("Windows update release tag does not match its version");
  }
  if (!/^[A-Za-z0-9_.-]+\.nupkg$/.test(basename(options.packagePath))) {
    throw new Error("Windows update package name is unsafe");
  }
  const packageStats = await stat(options.packagePath);
  if (!packageStats.isFile() || packageStats.size <= 0) throw new Error("Windows update package is missing");
  const packageName = basename(options.packagePath);
  const manifest: WindowsUpdateManifest = {
    arch: options.arch,
    artifact: {
      packageName,
      sha256: await hashFile(options.packagePath),
      size: packageStats.size,
      url: `https://github.com/${options.repository}/releases/download/${options.releaseTag}/${packageName}`,
    },
    channel: "prod",
    expiresAt: options.expiresAt.toISOString(),
    platform: "win32",
    publishedAt: options.publishedAt.toISOString(),
    schema: 1,
    version: options.version,
  };
  return createSignedUpdateEnvelope(Buffer.from(JSON.stringify(manifest)), options.privateSeed);
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function main() {
  const packagePath = requiredOption("--package");
  const privateKeyPath = requiredOption("--private-key-file");
  const outputPath = requiredOption("--output");
  const releaseTag = requiredEnvironment("RELEASE_TAG");
  const repository = requiredEnvironment("GITHUB_REPOSITORY");
  const version = releaseTag.replace(/^v/, "");
  const privateSeed = (await readFile(resolve(privateKeyPath), "utf8")).trim();
  const expectedPublicKey = requiredEnvironment("ARDOR_WINDOWS_UPDATE_PUBLIC_KEY");
  if (deriveEd25519PublicKey(privateSeed) !== expectedPublicKey) {
    throw new Error("Windows update private key does not match the configured public key");
  }
  const publishedAt = new Date();
  const expiresAt = new Date(publishedAt.getTime() + 90 * 24 * 60 * 60 * 1000);
  const envelope = await createWindowsUpdateMetadata({
    arch: "x64",
    expiresAt,
    packagePath: resolve(packagePath),
    privateSeed,
    publishedAt,
    releaseTag,
    repository,
    version,
  });
  await writeFile(resolve(outputPath), `${JSON.stringify(envelope)}\n`, { encoding: "utf8", mode: 0o600 });
}

function requiredOption(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index === -1 ? undefined : process.argv[index + 1];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

if (import.meta.main) {
  await main();
}
