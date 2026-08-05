import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { normalizeUiResourceDirectory } from "../scripts/electron-package-resources.mjs";

const desktopRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const appName = "ardor";
const uiDirectory = resolve(process.env.ARDOR_UI_DIST_DIR ?? resolve(desktopRoot, "..", "solutions-ui", "dist"));
const uiResourceName = basename(uiDirectory);

/** @type {import('@electron-forge/shared-types').ForgeConfig} */
export default {
  packagerConfig: {
    asar: true,
    name: appName,
    executableName: "Ardor",
    appBundleId: process.env.ARDOR_BUNDLE_ID ?? "cloud.ardor.desktop",
    appCategoryType: "public.app-category.developer-tools",
    extraResource: [uiDirectory],
    afterCopyExtraResources: [(buildPath, _electronVersion, platform, _arch, done) => {
      const resourcesRoot =
        platform === "darwin"
          ? resolve(buildPath, `${appName}.app`, "Contents", "Resources")
          : resolve(buildPath, "resources");
      normalizeUiResourceDirectory(resourcesRoot, uiResourceName).then(() => done(), (error) => done(error));
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
