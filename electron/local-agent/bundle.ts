import { createHash } from "node:crypto";
import { existsSync, realpathSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

export interface LocalAgentBundleFile {
  readonly path: string;
  readonly sizeBytes: number;
  readonly sha256: string;
}

export interface LocalAgentBundleManifest {
  readonly schemaVersion: 1;
  readonly source: {
    readonly repository: "Ardor-Cerebrum/cerebrum";
    readonly commit: string;
  };
  readonly target: string;
  readonly platform: "darwin" | "win32";
  readonly arch: "arm64" | "x64";
  readonly protocol: {
    readonly name: "codex-app-server";
    readonly version: 2;
    readonly transport: "stdio";
    readonly args: readonly ["app-server", "--stdio"];
  };
  readonly entrypoint: string;
  readonly files: readonly LocalAgentBundleFile[];
}

export interface VerifiedLocalAgentBundle {
  readonly root: string;
  readonly executablePath: string;
  readonly args: readonly ["app-server", "--stdio"];
  readonly manifest: LocalAgentBundleManifest;
}

export function resolveVerifiedLocalAgentBundle(
  bundleRoot: string,
  platform: NodeJS.Platform,
  arch: string,
  expectedSourceCommit: string | undefined,
  expectedManifestSha256: string | undefined,
): VerifiedLocalAgentBundle {
  const expectedTarget = resolveTarget(platform, arch);
  const root = realpathSync(bundleRoot);
  const manifestPath = resolve(root, "manifest.json");
  if (!existsSync(manifestPath)) {
    throw new Error("Bundled Cerebrum runtime manifest is missing.");
  }

  const manifestBytes = readFileSync(manifestPath);
  const manifestDigest = createHash("sha256").update(manifestBytes).digest("hex");
  if (!expectedManifestSha256 || !/^[0-9a-f]{64}$/.test(expectedManifestSha256) ||
      manifestDigest !== expectedManifestSha256) {
    throw new Error("Bundled Cerebrum manifest does not match Desktop's trusted manifest pin.");
  }
  const rawManifest: unknown = JSON.parse(manifestBytes.toString("utf8"));
  const manifest = parseManifest(rawManifest);
  if (!expectedSourceCommit || !/^[0-9a-f]{40}$/.test(expectedSourceCommit) ||
      manifest.source.commit !== expectedSourceCommit) {
    throw new Error("Bundled Cerebrum source does not match Desktop's trusted source pin.");
  }
  if (manifest.platform !== platform || manifest.arch !== arch || manifest.target !== expectedTarget) {
    throw new Error("Bundled Cerebrum runtime does not match this Desktop platform.");
  }
  if (!manifest.files.some((file) => file.path === manifest.entrypoint)) {
    throw new Error("Bundled Cerebrum entrypoint is not covered by the runtime manifest.");
  }

  const seenPaths = new Set<string>();
  for (const file of manifest.files) {
    if (seenPaths.has(file.path)) {
      throw new Error("Bundled Cerebrum manifest contains a duplicate path.");
    }
    seenPaths.add(file.path);
    verifyBundleFile(root, file);
  }
  verifyCanonicalPackageLayout(root, manifest);

  const executablePath = resolveBundleFilePath(root, manifest.entrypoint);
  if (!existsSync(executablePath) || !statSync(executablePath).isFile()) {
    throw new Error("Bundled Cerebrum app-server entrypoint is missing.");
  }

  return { root, executablePath, args: manifest.protocol.args, manifest };
}

function parseManifest(value: unknown): LocalAgentBundleManifest {
  if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.source) ||
      value.source.repository !== "Ardor-Cerebrum/cerebrum" ||
      typeof value.source.commit !== "string" || !/^[0-9a-f]{40}$/.test(value.source.commit) ||
      typeof value.target !== "string" || !isLocalPlatform(value.platform) || !isLocalArch(value.arch) ||
      !isRecord(value.protocol) || value.protocol.name !== "codex-app-server" ||
      value.protocol.version !== 2 || value.protocol.transport !== "stdio" ||
      !Array.isArray(value.protocol.args) || value.protocol.args.length !== 2 ||
      value.protocol.args[0] !== "app-server" || value.protocol.args[1] !== "--stdio" ||
      typeof value.entrypoint !== "string" || !Array.isArray(value.files)) {
    throw new Error("Bundled Cerebrum runtime manifest is invalid or incompatible.");
  }

  const files: LocalAgentBundleFile[] = [];
  for (const valueFile of value.files) {
    if (!isRecord(valueFile) || typeof valueFile.path !== "string" ||
        typeof valueFile.sizeBytes !== "number" || !Number.isSafeInteger(valueFile.sizeBytes) || valueFile.sizeBytes < 0 ||
        typeof valueFile.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(valueFile.sha256)) {
      throw new Error("Bundled Cerebrum runtime file manifest is invalid.");
    }
    files.push({ path: valueFile.path, sizeBytes: valueFile.sizeBytes, sha256: valueFile.sha256 });
  }

  const entrypoint = normalizeManifestPath(value.entrypoint);
  const normalizedFiles = files.map((file) => ({ ...file, path: normalizeManifestPath(file.path) }));
  return {
    schemaVersion: 1,
    source: { repository: "Ardor-Cerebrum/cerebrum", commit: value.source.commit },
    target: value.target,
    platform: value.platform,
    arch: value.arch,
    protocol: {
      name: "codex-app-server",
      version: 2,
      transport: "stdio",
      args: ["app-server", "--stdio"],
    },
    entrypoint,
    files: normalizedFiles,
  };
}

function verifyBundleFile(root: string, file: LocalAgentBundleFile): void {
  const path = resolveBundleFilePath(root, file.path);
  if (!existsSync(path) || !statSync(path).isFile()) {
    throw new Error(`Bundled Cerebrum runtime file is missing: ${file.path}`);
  }
  const realPath = realpathSync(path);
  if (!isPathWithin(root, realPath)) {
    throw new Error(`Bundled Cerebrum runtime file escapes its bundle: ${file.path}`);
  }
  const contents = readFileSync(realPath);
  const digest = createHash("sha256").update(contents).digest("hex");
  if (contents.byteLength !== file.sizeBytes || digest !== file.sha256) {
    throw new Error(`Bundled Cerebrum runtime file failed integrity verification: ${file.path}`);
  }
}

function verifyCanonicalPackageLayout(root: string, manifest: LocalAgentBundleManifest): void {
  const entryName = manifest.platform === "win32" ? "codex.exe" : "codex";
  const executableSuffix = manifest.platform === "win32" ? ".exe" : "";
  const requiredFiles = [
    `bin/${entryName}`,
    `bin/codex-code-mode-host${executableSuffix}`,
    `codex-path/rg${executableSuffix}`,
    "codex-package.json",
    ...(manifest.platform === "win32"
      ? ["codex-resources/codex-command-runner.exe", "codex-resources/codex-windows-sandbox-setup.exe"]
      : ["codex-resources/zsh/bin/zsh"]),
  ];
  const manifestPaths = new Set(manifest.files.map((file) => file.path));
  if (requiredFiles.some((path) => !manifestPaths.has(path))) {
    throw new Error("Bundled Cerebrum runtime is missing a required app-server helper.");
  }

  const metadataPath = resolveBundleFilePath(root, "codex-package.json");
  const metadataValue: unknown = JSON.parse(readFileSync(metadataPath, "utf8"));
  if (!isRecord(metadataValue) || metadataValue.layoutVersion !== 1 || metadataValue.variant !== "codex" ||
      metadataValue.target !== manifest.target || metadataValue.entrypoint !== manifest.entrypoint ||
      metadataValue.resourcesDir !== "codex-resources" || metadataValue.pathDir !== "codex-path") {
    throw new Error("Bundled Cerebrum canonical package metadata is invalid.");
  }
}

function resolveBundleFilePath(root: string, manifestPath: string): string {
  const normalizedPath = normalizeManifestPath(manifestPath);
  const path = resolve(root, ...normalizedPath.split("/"));
  if (!isPathWithin(root, path)) {
    throw new Error("Bundled Cerebrum manifest path escapes its bundle.");
  }
  return path;
}

function normalizeManifestPath(value: string): string {
  const path = value.replaceAll("\\", "/");
  const segments = path.split("/");
  if (path.length === 0 || path.startsWith("/") || /^[A-Za-z]:/.test(path) ||
      segments.some((segment) => segment === ".." || segment === "" || segment === ".")) {
    throw new Error("Bundled Cerebrum manifest path is invalid.");
  }
  return path;
}

function isPathWithin(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate);
  return relativePath === "" || (!relativePath.startsWith(`..${sep}`) && relativePath !== "..");
}

function resolveTarget(platform: NodeJS.Platform, arch: string): string {
  if (platform === "darwin" && arch === "arm64") return "aarch64-apple-darwin";
  if (platform === "win32" && arch === "x64") return "x86_64-pc-windows-msvc";
  throw new Error("Bundled Cerebrum runtime is unsupported on this platform.");
}

function isLocalPlatform(value: unknown): value is "darwin" | "win32" {
  return value === "darwin" || value === "win32";
}

function isLocalArch(value: unknown): value is "arm64" | "x64" {
  return value === "arm64" || value === "x64";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
