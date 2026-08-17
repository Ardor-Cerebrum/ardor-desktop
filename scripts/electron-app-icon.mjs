import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const iconRoots = {
  prod: resolve(repoRoot, "assets", "icons", "prod", "icon"),
  stage1: resolve(repoRoot, "assets", "icons", "stage1", "icon"),
  "update-test": resolve(repoRoot, "assets", "icons", "stage1", "icon"),
};

export function resolveElectronIcon(channel = process.env.ARDOR_ELECTRON_CHANNEL ?? "prod") {
  const iconRoot = iconRoots[channel];
  if (!iconRoot) {
    throw new Error(`Unsupported Electron channel: ${channel}`);
  }
  return iconRoot;
}
