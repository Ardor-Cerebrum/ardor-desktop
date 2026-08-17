#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BRIDGE_CAPABILITY_PATTERN = /^[A-Za-z][A-Za-z0-9]*$/;

try {
  const requirementsPath = resolve(
    process.env.ARDOR_DESKTOP_UI_REQUIREMENTS_PATH ?? resolve(repoDir, "desktop-ui-requirements.json"),
  );
  const requirements = readJson(requirementsPath, "desktop UI requirements");
  const solutionsUiDir = resolveSolutionsUiDir(process.argv[2]);
  verifyRequirements(requirements);
  verifyRequestedSolutionsUiRef(requirements, process.argv[3]);
  verifyElectronUi(solutionsUiDir, requirements);
  console.log(`Verified Electron solutions-ui bridge at ${solutionsUiDir}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

function verifyRequestedSolutionsUiRef(requirements, requestedRef) {
  if (requestedRef === undefined) {
    return;
  }
  if (requestedRef !== requirements.solutionsUiRef) {
    throw new Error(
      `checked out solutions-ui ref ${requestedRef} does not match required ref ${requirements.solutionsUiRef}`,
    );
  }
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Unable to read ${label} at ${path}: ${error.message}`);
  }
}

function resolveSolutionsUiDir(directoryName) {
  if (directoryName === undefined) {
    return resolve(repoDir, "../solutions-ui");
  }

  if (basename(directoryName) !== directoryName || directoryName === "." || directoryName === "..") {
    throw new Error("solutions-ui directory must be a direct child of the current workspace");
  }
  return resolve(process.cwd(), directoryName);
}

function verifyRequirements(requirements) {
  if (requirements?.schemaVersion !== 2) {
    throw new Error("desktop UI requirements schemaVersion must be 2");
  }
  if (!/^[0-9a-f]{40}$/.test(requirements.solutionsUiRef)) {
    throw new Error("desktop UI requirements solutionsUiRef must be a lowercase 40-character commit SHA");
  }
  if (requirements.bridgeGlobal !== "ardorDesktop") {
    throw new Error("desktop UI requirements bridgeGlobal must be ardorDesktop");
  }
  if (
    !Array.isArray(requirements.requiredCapabilities) ||
    requirements.requiredCapabilities.length === 0 ||
    requirements.requiredCapabilities.some((capability) => !BRIDGE_CAPABILITY_PATTERN.test(capability))
  ) {
    throw new Error("desktop UI requirements must list requiredCapabilities");
  }
}

function verifyElectronUi(solutionsUiDir, requirements) {
  const packageJson = readJson(resolve(solutionsUiDir, "package.json"), "solutions-ui package");
  const dependencies = { ...packageJson.dependencies, ...packageJson.devDependencies };
  const forbiddenDependency = Object.keys(dependencies).find((name) => name.startsWith("@tauri-apps/"));
  if (forbiddenDependency) {
    throw new Error(`solutions-ui still depends on forbidden legacy runtime package ${forbiddenDependency}`);
  }

  const bridgePath = resolve(solutionsUiDir, "src/lib/desktop-bridge.ts");
  const bridge = readFileSync(bridgePath, "utf8");
  if (!bridge.includes(`window.${requirements.bridgeGlobal}`)) {
    throw new Error(`Electron preload bridge ${requirements.bridgeGlobal} is missing from ${bridgePath}`);
  }
  if (bridge.includes("@tauri-apps/") || bridge.includes("CompatibilityBridge")) {
    throw new Error(`legacy runtime adapter is forbidden in ${bridgePath}`);
  }
  for (const capability of requirements.requiredCapabilities) {
    if (!hasBridgeCapability(bridge, capability)) {
      throw new Error(`required Electron bridge capability ${capability} is missing from ${bridgePath}`);
    }
  }

  const providerPath = resolve(solutionsUiDir, "src/auth/auth0-provider-with-navigation.tsx");
  const provider = readFileSync(providerPath, "utf8");
  if (!provider.includes("<DesktopAuthCallbackBridge />")) {
    throw new Error(`DesktopAuthCallbackBridge mount is missing from ${providerPath}`);
  }
}

function hasBridgeCapability(source, capability) {
  let offset = 0;
  while (offset < source.length) {
    const index = source.indexOf(capability, offset);
    if (index === -1) {
      return false;
    }

    const previousCharacter = source[index - 1];
    const isPropertyNameBoundary =
      previousCharacter === undefined || !/[A-Za-z0-9_$]/.test(previousCharacter);
    if (isPropertyNameBoundary && /^\s*:/.test(source.slice(index + capability.length))) {
      return true;
    }
    offset = index + capability.length;
  }
  return false;
}
