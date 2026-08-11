#!/usr/bin/env node

import { access } from "node:fs/promises";
import { resolve } from "node:path";

import { FuseV1Options, getCurrentFuseWire } from "@electron/fuses";

import { ELECTRON_FUSE_CONFIG } from "../electron/fuse-config.mjs";

const target = process.argv[2] ? resolve(process.argv[2]) : null;
if (!target) {
  throw new Error("Usage: node scripts/verify-electron-fuses.mjs <Electron app bundle or executable>");
}

await access(target);
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
