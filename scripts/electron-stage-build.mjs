import { access, chmod, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { resolveDesktopRuntimeConfig } from "../electron/auth/runtime-config.ts";
import { resolveElectronPackageIdentity } from "../electron/package-identity.mjs";
import { resolveSolutionsUiDir } from "./solutions-ui-path.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoDir = resolve(scriptDir, "..");

export function validateBuiltUiConfig(bundle, expected) {
  const placeholders = ["https://api.test", "auth.test", "client-id"];
  const missingExpected = Object.entries(expected)
    .filter(([, value]) => typeof value !== "string" || value.trim() === "")
    .map(([key]) => key);
  if (missingExpected.length > 0) {
    throw new Error(`Electron UI bundle validation is missing expected values: ${missingExpected.join(", ")}`);
  }
  const missing = [expected.apiUrl, expected.auth0Domain, expected.auth0ClientId].filter(
    (value) => !bundle.includes(value),
  );
  const hasPlaceholder = placeholders.some((value) => bundle.includes(value));

  if (missing.length > 0 || hasPlaceholder) {
    throw new Error(
      `Electron UI bundle does not contain the expected stage configuration (missing: ${missing.join(", ") || "none"})`,
    );
  }

  const cspMeta = [...bundle.matchAll(/<meta\b[^>]*>/gi)]
    .map(([tag]) => tag)
    .find((tag) => /\bhttp-equiv=["']Content-Security-Policy["']/i.test(tag));
  const csp = cspMeta?.match(/\bcontent=(["'])(.*?)\1/i)?.[2];
  const connectSources = csp
    ?.split(";")
    .map((directive) => directive.trim().split(/\s+/))
    .find(([name]) => name === "connect-src")
    ?.slice(1);
  const apiOrigin = new URL(expected.apiUrl).origin;
  if (!connectSources?.includes(apiOrigin)) {
    throw new Error(`Electron desktop CSP does not allow the configured API origin: ${apiOrigin}`);
  }
}

export function parseEnvFile(contents) {
  const entries = {};
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const normalized = line.startsWith("export ") ? line.slice("export ".length).trim() : line;
    const separatorIndex = normalized.indexOf("=");
    if (separatorIndex === -1) continue;

    const key = normalized.slice(0, separatorIndex).trim();
    const value = normalized.slice(separatorIndex + 1).trim();
    entries[key] = unquote(value);
  }
  return entries;
}

export async function writeElectronRuntimeConfig(configPath, config) {
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

export async function readElectronChannelEnv(envPath, { channel, processEnv }) {
  try {
    return parseEnvFile(await readFile(envPath, "utf8"));
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      error.code === "ENOENT" &&
      channel === "prod" &&
      processEnv.ARDOR_SKIP_UI_BUILD === "true"
    ) {
      return {};
    }
    throw error;
  }
}

const CHANNELS = {
  prod: {
    envFile: "prod.env",
  },
  stage1: {
    envFile: "stage1.env",
  },
};

export function resolveElectronUiEnvironment({ channel, fileEnv, processEnv, targetPlatform, uiDir }) {
  return {
    ...fileEnv,
    ...processEnv,
    ARDOR_SOLUTIONS_UI_DIR: uiDir,
    ARDOR_DESKTOP_TARGET_PLATFORM: targetPlatform,
    VITE_DESKTOP_BUILD_CHANNEL: channel,
  };
}

export function resolveElectronAutoUpdateEnabled(environment, targetPlatform) {
  if (targetPlatform === "darwin") {
    return Boolean(environment.ARDOR_SPARKLE_FEED_URL?.trim())
      && Boolean(environment.ARDOR_SPARKLE_PUBLIC_KEY?.trim());
  }
  if (targetPlatform === "win32") {
    return Boolean(resolveWindowsUpdateRuntimeConfig(environment, targetPlatform));
  }
  return false;
}

export function resolveWindowsUpdateRuntimeConfig(environment, targetPlatform) {
  if (targetPlatform !== "win32") return undefined;
  const windowsUpdateFeedUrl = environment.ARDOR_WINDOWS_UPDATE_FEED_URL?.trim();
  const windowsUpdatePublicKey = environment.ARDOR_WINDOWS_UPDATE_PUBLIC_KEY?.trim();
  if (!windowsUpdateFeedUrl || !windowsUpdatePublicKey) return undefined;
  return { windowsUpdateFeedUrl, windowsUpdatePublicKey };
}

async function main() {
  const channel = process.argv[2] ?? "stage1";
  const channelConfig = CHANNELS[channel];
  if (!channelConfig) {
    throw new Error(`Unsupported Electron channel: ${channel}`);
  }
  const packageIdentity = resolveElectronPackageIdentity(channel);
  const platform = readOption("--platform") ?? process.platform;
  const arch = readOption("--arch") ?? process.arch;

  const uiDir = resolveSolutionsUiDir(repoDir, process.env);
  const uiPackage = resolve(uiDir, "package.json");
  const envPath = resolve(repoDir, "env", channelConfig.envFile);
  const fileEnv = await readElectronChannelEnv(envPath, { channel, processEnv: process.env });
  const environment = resolveElectronUiEnvironment({
    channel,
    fileEnv,
    processEnv: process.env,
    targetPlatform: platform,
    uiDir,
  });
  if (environment.ARDOR_SKIP_UI_BUILD !== "true" && !(await Bun.file(uiPackage).exists())) {
    throw new Error(`solutions-ui checkout not found at ${uiDir}`);
  }

  const runtimeConfig = {
    ...resolveDesktopRuntimeConfig(environment),
    autoUpdateEnabled: resolveElectronAutoUpdateEnabled(environment, platform),
    ...resolveWindowsUpdateRuntimeConfig(environment, platform),
  };
  const expected = {
    apiUrl: environment.VITE_API_URL,
    auth0Domain: runtimeConfig.auth0Domain,
    auth0ClientId: runtimeConfig.auth0ClientId,
  };

  if (environment.ARDOR_SKIP_UI_BUILD !== "true") {
    run(process.execPath, ["scripts/run-ui.mjs", channel, "build"], environment);
  }

  await stageCerebrumBinary({
    arch,
    platform,
    source: environment.ARDOR_CEREBRUM_BINARY,
  });

  const uiIndex = await readFile(resolve(uiDir, "dist", "index.html"), "utf8");
  const scripts = [...uiIndex.matchAll(/src=["']([^"']+\.js)["']/g)]
    .map((match) => match[1])
    .filter((script) => script.startsWith("/"));
  const bundle = [uiIndex];
  for (const script of scripts) {
    bundle.push(await readFile(resolve(uiDir, "dist", script.replace(/^\//, "")), "utf8"));
  }
  validateBuiltUiConfig(bundle.join("\n"), expected);

  run(process.execPath, ["run", "electron:build"], environment);
  await writeElectronRuntimeConfig(resolve(repoDir, "dist", "electron", "runtime-config.json"), runtimeConfig);

  const packageEnvironment = {
    ...environment,
    ARDOR_UI_DIST_DIR: resolve(uiDir, "dist"),
    ARDOR_BUNDLE_ID: packageIdentity.bundleId,
    ARDOR_ELECTRON_CHANNEL: channel,
  };
  const forgeScript = resolve(repoDir, "node_modules", "@electron-forge", "cli", "dist", "electron-forge.js");
  run("node", [forgeScript, "make", "--platform", platform, "--arch", arch], packageEnvironment);
}

export async function stageCerebrumBinary({ arch, platform, source, root = repoDir }) {
  const executable = platform === "win32" ? "cerebrum.exe" : "cerebrum";
  const sourcePath = source?.trim() || (
    platform === process.platform && arch === process.arch
      ? resolve(root, "..", "codex", "cerebrum-rs", "target", "release", executable)
      : undefined
  );
  if (!sourcePath) {
    throw new Error("ARDOR_CEREBRUM_BINARY is required for cross-platform desktop packaging");
  }
  try {
    await access(sourcePath);
  } catch {
    throw new Error(`Cerebrum binary not found at ${sourcePath}`);
  }
  const destination = resolve(root, "dist", "cerebrum", executable);
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(sourcePath, destination);
  if (platform !== "win32") await chmod(destination, 0o755);
  return destination;
}

function readOption(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function run(command, args, environment) {
  const result = spawnSync(command, args, {
    cwd: repoDir,
    env: environment,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with code ${result.status}`);
}

function unquote(value) {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
