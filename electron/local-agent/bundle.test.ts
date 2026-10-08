import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import { resolveVerifiedLocalAgentBundle } from "./bundle.js";

describe("resolveVerifiedLocalAgentBundle", () => {
  test("verifies the entrypoint and every bundled helper against the manifest", () => {
    const root = mkdtempSync(join(tmpdir(), "ardor-cerebrum-bundle-"));
    try {
      const entrypoint = "bin/codex.exe";
      const helper = "codex-resources/codex-windows-sandbox-setup.exe";
      const files = [
        entrypoint,
        "bin/codex-code-mode-host.exe",
        "codex-path/rg.exe",
        "codex-resources/codex-command-runner.exe",
        helper,
        "codex-package.json",
      ];
      for (const path of files) writeBundleFile(root, path, path === "codex-package.json" ? JSON.stringify({
        layoutVersion: 1,
        version: "1.0.0",
        target: "x86_64-pc-windows-msvc",
        variant: "codex",
        entrypoint,
        resourcesDir: "codex-resources",
        pathDir: "codex-path",
      }) : `file:${path}`);
      writeManifest(root, {
        target: "x86_64-pc-windows-msvc",
        platform: "win32",
        arch: "x64",
        entrypoint,
        files: files.map((path) => fileRecord(root, path)),
      });

      expect(resolveVerifiedLocalAgentBundle(root, "win32", "x64", "a".repeat(40), manifestSha256(root))).toMatchObject({
        executablePath: join(root, entrypoint),
        args: ["app-server", "--stdio"],
        manifest: { source: { repository: "Ardor-Cerebrum/cerebrum" } },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects platform mismatch, path traversal, and altered files", () => {
    const root = mkdtempSync(join(tmpdir(), "ardor-cerebrum-bundle-"));
    try {
      const entrypoint = "bin/codex";
      writeBundleFile(root, entrypoint, "codex binary");
      writeManifest(root, { target: "aarch64-apple-darwin", platform: "darwin", arch: "arm64", entrypoint,
        files: [fileRecord(root, entrypoint)] });
      expect(() => resolveVerifiedLocalAgentBundle(root, "win32", "x64", "a".repeat(40), manifestSha256(root))).toThrow();

      writeManifest(root, { target: "aarch64-apple-darwin", platform: "darwin", arch: "arm64",
        entrypoint: "../outside", files: [fileRecord(root, entrypoint)] });
      expect(() => resolveVerifiedLocalAgentBundle(root, "darwin", "arm64", "a".repeat(40), manifestSha256(root))).toThrow();

      const macEntrypoint = "bin/codex";
      const macFiles = [macEntrypoint, "bin/codex-code-mode-host", "codex-path/rg", "codex-resources/zsh/bin/zsh",
        "codex-package.json"];
      for (const path of macFiles) writeBundleFile(root, path, path === "codex-package.json" ? JSON.stringify({
        layoutVersion: 1,
        version: "1.0.0",
        target: "aarch64-apple-darwin",
        variant: "codex",
        entrypoint: macEntrypoint,
        resourcesDir: "codex-resources",
        pathDir: "codex-path",
      }) : `file:${path}`);
      writeManifest(root, {
        target: "aarch64-apple-darwin",
        platform: "darwin",
        arch: "arm64",
        entrypoint: macEntrypoint,
        files: macFiles.map((path) => path === macEntrypoint
          ? { ...fileRecord(root, path), sha256: "0".repeat(64) }
          : fileRecord(root, path)),
      });
      expect(() => resolveVerifiedLocalAgentBundle(root, "darwin", "arm64", "a".repeat(40), manifestSha256(root))).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("accepts macOS-signed runtime executables only after verifying the containing app signature", () => {
    const root = mkdtempSync(join(tmpdir(), "ardor-cerebrum-signed-app-"));
    const appBundleRoot = join(root, "Ardor Dev.app");
    const bundleRoot = join(appBundleRoot, "Contents", "Resources", "cerebrum");
    try {
      const entrypoint = "bin/codex";
      const files = [entrypoint, "bin/codex-code-mode-host", "codex-path/rg", "codex-resources/zsh/bin/zsh",
        "codex-package.json"];
      for (const path of files) writeBundleFile(bundleRoot, path, path === "codex-package.json" ? JSON.stringify({
        layoutVersion: 1,
        version: "1.0.0",
        target: "aarch64-apple-darwin",
        variant: "codex",
        entrypoint,
        resourcesDir: "codex-resources",
        pathDir: "codex-path",
      }) : `file:${path}`);
      writeManifest(bundleRoot, {
        target: "aarch64-apple-darwin",
        platform: "darwin",
        arch: "arm64",
        entrypoint,
        files: files.map((path) => fileRecord(bundleRoot, path)),
      });

      // Electron's macOS signing step changes Mach-O bytes after the Cerebrum archive is sealed.
      writeFileSync(join(bundleRoot, entrypoint), "signed:file:bin/codex");
      const verifyCalls: string[] = [];
      const verification = {
        appBundleRoot,
        verifyMacAppSignature: (path: string) => verifyCalls.push(path),
      };

      expect(() => resolveVerifiedLocalAgentBundle(
        bundleRoot,
        "darwin",
        "arm64",
        "a".repeat(40),
        manifestSha256(bundleRoot),
      )).toThrow(/signed macOS app bundle/);
      expect(resolveVerifiedLocalAgentBundle(
        bundleRoot,
        "darwin",
        "arm64",
        "a".repeat(40),
        manifestSha256(bundleRoot),
        verification,
      )).toMatchObject({ executablePath: join(bundleRoot, entrypoint) });
      expect(verifyCalls).toEqual([appBundleRoot]);

      expect(() => resolveVerifiedLocalAgentBundle(
        bundleRoot,
        "darwin",
        "arm64",
        "a".repeat(40),
        manifestSha256(bundleRoot),
        { ...verification, verifyMacAppSignature: () => { throw new Error("app signature is invalid"); } },
      )).toThrow("app signature is invalid");

      writeFileSync(join(bundleRoot, "codex-package.json"), "altered metadata");
      expect(() => resolveVerifiedLocalAgentBundle(
        bundleRoot,
        "darwin",
        "arm64",
        "a".repeat(40),
        manifestSha256(bundleRoot),
        verification,
      )).toThrow("Bundled Cerebrum runtime file failed integrity verification: codex-package.json");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects a bundle whose source commit differs from Desktop's trusted pin", () => {
    const root = mkdtempSync(join(tmpdir(), "ardor-cerebrum-bundle-pin-"));
    try {
      const entrypoint = "bin/codex.exe";
      const files = [
        entrypoint,
        "bin/codex-code-mode-host.exe",
        "codex-path/rg.exe",
        "codex-resources/codex-command-runner.exe",
        "codex-resources/codex-windows-sandbox-setup.exe",
        "codex-package.json",
      ];
      for (const path of files) writeBundleFile(root, path, path === "codex-package.json" ? JSON.stringify({
        layoutVersion: 1,
        version: "1.0.0",
        target: "x86_64-pc-windows-msvc",
        variant: "codex",
        entrypoint,
        resourcesDir: "codex-resources",
        pathDir: "codex-path",
      }) : `file:${path}`);
      writeManifest(root, {
        target: "x86_64-pc-windows-msvc",
        platform: "win32",
        arch: "x64",
        entrypoint,
        files: files.map((path) => fileRecord(root, path)),
      });

      expect(() => resolveVerifiedLocalAgentBundle(root, "win32", "x64", "b".repeat(40), manifestSha256(root))).toThrow(
        "does not match Desktop's trusted source pin",
      );
      expect(() => resolveVerifiedLocalAgentBundle(root, "win32", "x64", "a".repeat(40), "0".repeat(64))).toThrow(
        "does not match Desktop's trusted manifest pin",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

interface ManifestOverrides {
  readonly target: string;
  readonly platform: "darwin" | "win32";
  readonly arch: "arm64" | "x64";
  readonly entrypoint: string;
  readonly files: Array<{ path: string; sizeBytes: number; sha256: string }>;
}

function writeManifest(root: string, overrides: ManifestOverrides): void {
  writeFileSync(join(root, "manifest.json"), JSON.stringify({
    schemaVersion: 1,
    source: { repository: "Ardor-Cerebrum/cerebrum", commit: "a".repeat(40) },
    target: overrides.target,
    platform: overrides.platform,
    arch: overrides.arch,
    protocol: { name: "codex-app-server", version: 2, transport: "stdio", args: ["app-server", "--stdio"] },
    entrypoint: overrides.entrypoint,
    files: overrides.files,
  }));
}

function writeBundleFile(root: string, relativePath: string, contents: string): void {
  const path = join(root, relativePath);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, contents);
}

function fileRecord(root: string, relativePath: string) {
  const contents = readFileSync(join(root, relativePath));
  return {
    path: relativePath,
    sizeBytes: contents.length,
    sha256: createHash("sha256").update(contents).digest("hex"),
  };
}

function manifestSha256(root: string): string {
  return createHash("sha256").update(readFileSync(join(root, "manifest.json"))).digest("hex");
}
