import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { resolveDesktopRuntimeConfig } from "../electron/auth/runtime-config.ts";
import { resolveSolutionsUiDir } from "./solutions-ui-path.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoDir = resolve(scriptDir, "..");

export function validateBuiltUiConfig(bundle, expected) {
  const placeholders = ["https://api.test", "auth.test", "client-id"];
  const missing = [expected.apiUrl, expected.auth0Domain, expected.auth0ClientId].filter(
    (value) => !bundle.includes(value),
  );
  const hasPlaceholder = placeholders.some((value) => bundle.includes(value));

  if (missing.length > 0 || hasPlaceholder) {
    throw new Error(
      `Electron UI bundle does not contain the expected stage configuration (missing: ${missing.join(", ") || "none"})`,
    );
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

async function main() {
  const channel = process.argv[2] ?? "stage1";
  if (channel !== "stage1") {
    throw new Error("Electron stage build currently supports only the stage1 channel");
  }

  const uiDir = resolveSolutionsUiDir(repoDir, process.env);
  const uiPackage = resolve(uiDir, "package.json");
  const envPath = resolve(repoDir, "env", "stage1.env");
  const fileEnv = parseEnvFile(await readFile(envPath, "utf8"));
  const environment = {
    ...fileEnv,
    ...process.env,
    ARDOR_SOLUTIONS_UI_DIR: uiDir,
    VITE_DESKTOP_BUILD_CHANNEL: "stage1",
  };

  if (!(await Bun.file(uiPackage).exists())) {
    throw new Error(`solutions-ui checkout not found at ${uiDir}`);
  }

  const runtimeConfig = resolveDesktopRuntimeConfig(environment);
  const expected = {
    apiUrl: environment.VITE_API_URL,
    auth0Domain: runtimeConfig.auth0Domain,
    auth0ClientId: runtimeConfig.auth0ClientId,
  };

  if (environment.ARDOR_SKIP_UI_BUILD !== "true") {
    run(process.execPath, ["scripts/run-ui.mjs", "stage1", "build"], environment);
  }

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
    ARDOR_BUNDLE_ID: "cloud.ardor.desktop.stage1",
  };
  const forgeScript = resolve(repoDir, "node_modules", "@electron-forge", "cli", "dist", "electron-forge.js");
  run(process.execPath, [forgeScript, "make", "--platform", "win32", "--arch", "x64"], packageEnvironment);
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
