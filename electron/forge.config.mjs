import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { normalizeUiResourceDirectory } from "../scripts/electron-package-resources.mjs";
import { resolveElectronIcon } from "../scripts/electron-app-icon.mjs";

const desktopRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const appName = "ardor";
const uiDirectory = resolve(process.env.ARDOR_UI_DIST_DIR ?? resolve(desktopRoot, "..", "solutions-ui", "dist"));
const uiResourceName = basename(uiDirectory);

export function shouldIgnorePackagedPath(filePath) {
  const normalizedPath = filePath.replaceAll("\\", "/");
  return (
    /(^|\/)(?:src-tauri|out|\.git|\.omx)(?:\/|$)/.test(normalizedPath) ||
    /(^|\/)runtime-config\.json$/.test(normalizedPath)
  );
}

/** @type {import('@electron-forge/shared-types').ForgeConfig} */
export default {
  packagerConfig: {
    asar: true,
    name: appName,
    executableName: "Ardor",
    appBundleId: process.env.ARDOR_BUNDLE_ID ?? "cloud.ardor.desktop",
    appCategoryType: "public.app-category.developer-tools",
    icon: resolveElectronIcon(),
    ignore: shouldIgnorePackagedPath,
    extraResource: [uiDirectory],
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
        name: "ardor",
        authors: "Ardor",
        description: "Ardor desktop application",
      },
      platforms: ["win32"],
    },
  ],
};
