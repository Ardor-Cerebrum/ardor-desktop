#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { FuseV1Options, getCurrentFuseWire } from "@electron/fuses";

import { ELECTRON_FUSE_CONFIG } from "../electron/fuse-config.mjs";

export function resolveElectronOutputTarget(candidate, workingDirectory = process.cwd()) {
  if (!candidate) {
    throw new Error("Usage: node scripts/verify-electron-fuses.mjs <Electron app bundle or executable>");
  }

  const outputRoot = realpathSync(resolve(workingDirectory, "out"));
  const target = realpathSync(resolve(workingDirectory, candidate));
  const relativeTarget = relative(outputRoot, target);
  if (relativeTarget === ".." || relativeTarget.startsWith(`..${sep}`) || isAbsolute(relativeTarget)) {
    throw new Error("Electron fuse target must be inside the current workspace out directory");
  }
  return target;
}

export async function main() {
  const target = resolveElectronOutputTarget(process.argv[2]);
  const actual = await getCurrentFuseWire(target);
  if (actual.version !== ELECTRON_FUSE_CONFIG.version) {
    throw new Error(`Electron fuse version mismatch: expected ${ELECTRON_FUSE_CONFIG.version}, got ${actual.version}`);
  }

  for (const [option, enabled] of Object.entries(ELECTRON_FUSE_CONFIG)) {
    if (!/^\d+$/.test(option)) continue;
    const expectedState = (enabled ? "1" : "0").charCodeAt(0);
    if (actual[option] !== expectedState) {
      throw new Error(`Electron fuse ${FuseV1Options[option]} is not ${enabled ? "enabled" : "disabled"}`);
    }
  }

  console.log(`Verified hardened Electron fuses in ${target}`);
}

const isDirectInvocation = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectInvocation) {
  await main();
}
