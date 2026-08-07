import { existsSync } from "node:fs";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { normalizeUiResourceDirectory } from "../scripts/electron-package-resources.mjs";
import { resolveElectronIcon } from "../scripts/electron-app-icon.mjs";

const desktopRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const channel = process.env.ARDOR_ELECTRON_CHANNEL ?? "prod";
const appName = channel === "stage1" ? "Ardor Dev" : "Ardor";
const uiDirectory = resolve(process.env.ARDOR_UI_DIST_DIR ?? resolve(desktopRoot, "..", "solutions-ui", "dist"));
const uiResourceName = basename(uiDirectory);
const runtimeConfigPath = resolve(desktopRoot, "dist", "electron", "runtime-config.json");

export function shouldIgnorePackagedPath(filePath) {
  const normalizedPath = filePath.replaceAll("\\", "/");
  return (
    /(^|\/)(?:out|\.git|\.omx)(?:\/|$)/.test(normalizedPath) ||
    /(^|\/)runtime-config\.json$/.test(normalizedPath)
  );
}

/** @type {import('@electron-forge/shared-types').ForgeConfig} */
export default {
  packagerConfig: {
    asar: true,
    name: appName,
    executableName: appName,
    appBundleId: process.env.ARDOR_BUNDLE_ID ?? "cloud.ardor.desktop",
    appCategoryType: "public.app-category.developer-tools",
    icon: resolveElectronIcon(),
    ignore: shouldIgnorePackagedPath,
    extraResource: [uiDirectory, ...(existsSync(runtimeConfigPath) ? [runtimeConfigPath] : [])],
    afterCopyExtraResources: [(buildPath, _electronVersion, platform, _arch, done) => {
      normalizeUiResourceDirectory(buildPath, uiResourceName, platform).then(() => done(), (error) => done(error));
    }],
  },
  makers: [
    {
      name: "@electron-forge/maker-dmg",
      platforms: ["darwin"],
    },
    {
      name: "@electron-forge/maker-zip",
      platforms: ["darwin"],
    },
    {
      name: "@electron-forge/maker-squirrel",
      config: {
        name: channel === "stage1" ? "ardor-dev" : "ardor",
        authors: "Ardor",
        description: "Ardor desktop application",
        setupIcon: `${resolveElectronIcon()}.ico`,
      },
      platforms: ["win32"],
    },
  ],
};
