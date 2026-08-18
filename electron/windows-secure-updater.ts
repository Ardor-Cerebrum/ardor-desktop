import { createHash } from "node:crypto";
import { mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";

import type { DesktopUpdateNativeEvent } from "./bridge-contract.js";
import type {
  AutoUpdaterLike,
  DesktopUpdateCheckResult,
  DesktopUpdateController,
  DesktopUpdateInstallResult,
} from "./updater.js";
import { verifySignedUpdateEnvelope } from "./update-signature.js";

const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_PACKAGE_BYTES = 1024 * 1024 * 1024;
const STRICT_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

interface FetchResponse {
  arrayBuffer(): Promise<ArrayBuffer>;
  body: AsyncIterable<Uint8Array> | null;
  ok: boolean;
  status: number;
}

interface WindowsUpdateArtifact {
  packageName: string;
  sha256: string;
  size: number;
  url: string;
}

export interface WindowsUpdateManifest {
  arch: "x64";
  artifact: WindowsUpdateArtifact;
  channel: "prod";
  expiresAt: string;
  platform: "win32";
  publishedAt: string;
  schema: 1;
  version: string;
}

export interface CreateSecureWindowsUpdaterOptions {
  appIsPackaged: boolean;
  arch: string;
  autoUpdater: AutoUpdaterLike;
  beforeRelaunch?: () => Promise<void>;
  cacheRoot: string;
  channel: string | undefined;
  currentVersion: string;
  feedUrl?: string;
  fetch: (url: string) => Promise<FetchResponse>;
  now?: () => Date;
  onEvent: (event: DesktopUpdateNativeEvent) => void;
  platform: string;
  publicKey?: string;
  updatesEnabled: boolean;
}

type EnabledWindowsUpdaterOptions = Omit<CreateSecureWindowsUpdaterOptions, "feedUrl" | "publicKey">
  & Required<Pick<CreateSecureWindowsUpdaterOptions, "feedUrl" | "publicKey">>;

interface Deferred<T> {
  promise: Promise<T>;
  reject: (error: Error) => void;
  resolve: (value: T) => void;
}

export class SecureWindowsUpdater implements DesktopUpdateController {
  private availableManifest: WindowsUpdateManifest | undefined;
  private checkPromise: Promise<DesktopUpdateCheckResult> | undefined;
  private installPromise: Promise<DesktopUpdateInstallResult> | undefined;
  private nativeDownload: Deferred<void> | undefined;
  private ready = false;

  constructor(private readonly options: EnabledWindowsUpdaterOptions) {
    options.autoUpdater.on("update-downloaded", () => {
      this.ready = true;
      this.nativeDownload?.resolve();
      this.nativeDownload = undefined;
    });
    options.autoUpdater.on("update-not-available", () => {
      this.rejectNativeDownload(new Error("verified Windows update was not accepted by Squirrel"));
    });
    options.autoUpdater.on("error", (cause) => {
      this.rejectNativeDownload(cause instanceof Error ? cause : new Error("Windows update staging failed"));
    });
  }

  check(): Promise<DesktopUpdateCheckResult> {
    if (this.availableManifest) {
      return Promise.resolve({ status: "available", version: this.availableManifest.version });
    }
    if (this.checkPromise) return this.checkPromise;
    this.checkPromise = this.fetchManifest().finally(() => {
      this.checkPromise = undefined;
    });
    return this.checkPromise;
  }

  install(): Promise<DesktopUpdateInstallResult> {
    if (this.ready) return Promise.resolve("installed");
    if (!this.availableManifest) return Promise.resolve("up-to-date");
    if (this.installPromise) return this.installPromise;
    this.installPromise = this.stageAvailableUpdate().finally(() => {
      this.installPromise = undefined;
    });
    return this.installPromise;
  }

  async relaunch(): Promise<void> {
    if (!this.ready) return;
    await this.options.beforeRelaunch?.();
    this.options.autoUpdater.quitAndInstall();
  }

  private async fetchManifest(): Promise<DesktopUpdateCheckResult> {
    const response = await this.options.fetch(withCacheBuster(this.options.feedUrl));
    if (!response.ok) throw new Error(`Windows update metadata request failed (${response.status})`);
    const encodedEnvelope = await readBoundedResponse(response, MAX_MANIFEST_BYTES);
    const envelope = JSON.parse(encodedEnvelope.toString("utf8"));
    const payload = verifySignedUpdateEnvelope(envelope, this.options.publicKey);
    const manifest = parseWindowsUpdateManifest(JSON.parse(Buffer.from(payload).toString("utf8")), {
      arch: this.options.arch,
      channel: this.options.channel,
      currentVersion: this.options.currentVersion,
      now: this.options.now?.() ?? new Date(),
      platform: this.options.platform,
    });
    if (!manifest) return { status: "up-to-date" };
    this.availableManifest = manifest;
    return { status: "available", version: manifest.version };
  }

  private async stageAvailableUpdate(): Promise<DesktopUpdateInstallResult> {
    const manifest = this.availableManifest;
    if (!manifest) return "up-to-date";

    const stagingDirectory = resolve(this.options.cacheRoot, manifest.version);
    await rm(stagingDirectory, { force: true, recursive: true });
    await mkdir(stagingDirectory, { mode: 0o700, recursive: true });
    const finalPackagePath = resolve(stagingDirectory, manifest.artifact.packageName);
    const partialPackagePath = `${finalPackagePath}.partial`;
    this.options.onEvent({ event: "Started", data: { contentLength: manifest.artifact.size } });
    try {
      const hashes = await downloadAndHash({
        destination: partialPackagePath,
        expectedSize: manifest.artifact.size,
        fetch: this.options.fetch,
        onChunk: (chunkLength) => this.options.onEvent({ event: "Progress", data: { chunkLength } }),
        url: manifest.artifact.url,
      });
      this.options.onEvent({ event: "Verifying" });
      if (hashes.sha256 !== manifest.artifact.sha256) {
        throw new Error("Windows update package hash is invalid");
      }
      await rename(partialPackagePath, finalPackagePath);
      await writeFile(
        resolve(stagingDirectory, "RELEASES"),
        `${hashes.sha1} ${manifest.artifact.packageName} ${manifest.artifact.size}\n`,
        { encoding: "utf8", mode: 0o600 },
      );
      const nativeDownload = createDeferred<void>();
      this.nativeDownload = nativeDownload;
      this.options.autoUpdater.setFeedURL({ url: stagingDirectory });
      this.options.autoUpdater.checkForUpdates();
      await nativeDownload.promise;
      this.options.onEvent({ event: "Installing" });
      return "installed";
    } catch (cause) {
      this.nativeDownload = undefined;
      await rm(stagingDirectory, { force: true, recursive: true });
      throw cause;
    }
  }

  private rejectNativeDownload(error: Error): void {
    this.nativeDownload?.reject(error);
    this.nativeDownload = undefined;
  }
}

export function createSecureWindowsUpdater(
  options: CreateSecureWindowsUpdaterOptions,
): SecureWindowsUpdater | null {
  if (
    options.platform !== "win32"
    || options.arch !== "x64"
    || options.channel !== "prod"
    || !options.appIsPackaged
    || !options.updatesEnabled
    || !options.feedUrl
    || !options.publicKey
  ) {
    return null;
  }
  assertSafeRemoteUrl(options.feedUrl, "Windows update feed URL");
  if (Buffer.from(options.publicKey, "base64").byteLength !== 32) {
    throw new Error("Windows update public key must contain 32 bytes");
  }
  return new SecureWindowsUpdater({ ...options, feedUrl: options.feedUrl, publicKey: options.publicKey });
}

export function parseWindowsUpdateManifest(
  value: unknown,
  expected: { arch: string; channel: string | undefined; currentVersion: string; now: Date; platform: string },
): WindowsUpdateManifest | null {
  if (!value || typeof value !== "object") throw new Error("Windows update manifest is invalid");
  const manifest = value as Record<string, unknown>;
  const artifact = manifest.artifact as Record<string, unknown> | undefined;
  if (
    manifest.schema !== 1
    || manifest.channel !== "prod"
    || manifest.platform !== "win32"
    || manifest.arch !== "x64"
    || typeof manifest.version !== "string"
    || typeof manifest.publishedAt !== "string"
    || typeof manifest.expiresAt !== "string"
    || !artifact
    || typeof artifact.url !== "string"
    || typeof artifact.packageName !== "string"
    || typeof artifact.sha256 !== "string"
    || typeof artifact.size !== "number"
  ) {
    throw new Error("Windows update manifest is invalid");
  }
  if (manifest.channel !== expected.channel || manifest.platform !== expected.platform || manifest.arch !== expected.arch) {
    throw new Error("Windows update manifest targets a different application channel");
  }
  const publishedAt = parseTimestamp(manifest.publishedAt, "publishedAt");
  const expiresAt = parseTimestamp(manifest.expiresAt, "expiresAt");
  if (
    publishedAt > expected.now.getTime() + 5 * 60 * 1000
    || expiresAt <= expected.now.getTime()
    || expiresAt <= publishedAt
  ) {
    throw new Error("Windows update manifest is outside its validity window");
  }
  if (!isNewerVersion(manifest.version, expected.currentVersion)) return null;
  assertSafeRemoteUrl(artifact.url, "Windows update package URL");
  if (basename(artifact.packageName) !== artifact.packageName || !artifact.packageName.endsWith(".nupkg")) {
    throw new Error("Windows update package name is invalid");
  }
  if (!/^[a-f0-9]{64}$/.test(artifact.sha256)) throw new Error("Windows update package hash is invalid");
  if (!Number.isSafeInteger(artifact.size) || artifact.size <= 0 || artifact.size > MAX_PACKAGE_BYTES) {
    throw new Error("Windows update package size is invalid");
  }
  return value as WindowsUpdateManifest;
}

async function readBoundedResponse(response: FetchResponse, maximumBytes: number): Promise<Buffer> {
  if (!response.body) {
    const body = Buffer.from(await response.arrayBuffer());
    if (body.byteLength > maximumBytes) throw new Error("Windows update metadata is too large");
    return body;
  }

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of response.body) {
    const bytes = Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > maximumBytes) throw new Error("Windows update metadata is too large");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, size);
}

async function downloadAndHash(options: {
  destination: string;
  expectedSize: number;
  fetch: (url: string) => Promise<FetchResponse>;
  onChunk: (chunkLength: number) => void;
  url: string;
}): Promise<{ sha1: string; sha256: string }> {
  const response = await options.fetch(options.url);
  if (!response.ok || !response.body) {
    throw new Error(`Windows update package request failed (${response.status})`);
  }
  const file = await open(options.destination, "wx", 0o600);
  const sha1 = createHash("sha1");
  const sha256 = createHash("sha256");
  let size = 0;
  try {
    for await (const chunk of response.body) {
      const bytes = Buffer.from(chunk);
      size += bytes.byteLength;
      if (size > options.expectedSize || size > MAX_PACKAGE_BYTES) {
        throw new Error("Windows update package exceeds its signed size");
      }
      sha1.update(bytes);
      sha256.update(bytes);
      await file.write(bytes);
      options.onChunk(bytes.byteLength);
    }
  } finally {
    await file.close();
  }
  if (size !== options.expectedSize) throw new Error("Windows update package size does not match");
  return { sha1: sha1.digest("hex"), sha256: sha256.digest("hex") };
}

function isNewerVersion(candidate: string, current: string): boolean {
  const candidateParts = parseVersion(candidate);
  const currentParts = parseVersion(current);
  for (let index = 0; index < candidateParts.length; index += 1) {
    if (candidateParts[index] !== currentParts[index]) return candidateParts[index] > currentParts[index];
  }
  return false;
}

function parseVersion(value: string): [number, number, number] {
  const match = STRICT_VERSION.exec(value);
  if (!match) throw new Error(`unsupported desktop update version: ${value}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function parseTimestamp(value: string, label: string): number {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error(`Windows update ${label} is invalid`);
  return timestamp;
}

function assertSafeRemoteUrl(value: string, label: string): void {
  const url = new URL(value);
  const isLoopback = url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost");
  if (url.protocol !== "https:" && !isLoopback) throw new Error(`${label} must use HTTPS or loopback HTTP`);
  if (url.username || url.password) throw new Error(`${label} must not contain credentials`);
}

function withCacheBuster(value: string): string {
  const url = new URL(value);
  url.searchParams.set("t", Date.now().toString());
  return url.toString();
}

function createDeferred<T>(): Deferred<T> {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error: Error) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, reject: rejectPromise, resolve: resolvePromise };
}
