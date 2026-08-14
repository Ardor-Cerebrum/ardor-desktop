import { existsSync } from "node:fs";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { normalizeUiResourceDirectory } from "../scripts/electron-package-resources.mjs";
import { resolveElectronIcon } from "../scripts/electron-app-icon.mjs";
import { MakerArdorDMG } from "../scripts/electron-dmg-maker.mjs";
import { ELECTRON_FUSE_CONFIG } from "./fuse-config.mjs";
import { resolveElectronPackageIdentity, stampElectronPackageIdentity } from "./package-identity.mjs";

// Forge 7's plugin is CommonJS while the Electron 43-compatible fuses package
// is ESM. Load the plugin after the fuse config finishes evaluating to avoid a
// CJS-to-ESM initialization cycle. Both packages stay exact-pinned until Forge 8.
const { FusesPlugin } = await import("@electron-forge/plugin-fuses");

const desktopRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const channel = process.env.ARDOR_ELECTRON_CHANNEL ?? "prod";
const packageIdentity = resolveElectronPackageIdentity(channel);
const appName = packageIdentity.productName;
const appBundleId = process.env.ARDOR_BUNDLE_ID ?? packageIdentity.bundleId;
const uiDirectory = resolve(process.env.ARDOR_UI_DIST_DIR ?? resolve(desktopRoot, "..", "solutions-ui", "dist"));
const uiResourceName = basename(uiDirectory);
const runtimeConfigPath = resolve(desktopRoot, "dist", "electron", "runtime-config.json");
const targetPlatform = process.env.ARDOR_DESKTOP_TARGET_PLATFORM ?? process.platform;

export function resolveMacSigningOptions({
  platform = targetPlatform,
} = {}) {
  if (platform !== "darwin") return undefined;
  return resolveAdHocMacSigningOptions();
}

function resolveAdHocMacSigningOptions() {
  return {
    hardenedRuntime: false,
    identity: "-",
    identityValidation: false,
    // @electron/osx-sign applies hardened runtime per nested binary. Ad-hoc
    // bundles have no Team ID, so every child must explicitly opt out or dyld
    // rejects Electron Framework as belonging to a different signing team.
    optionsForFile: () => ({ hardenedRuntime: false }),
  };
}

export function shouldIgnorePackagedPath(filePath) {
  const normalizedPath = filePath.replaceAll("\\", "/");
  return (
    /(^|\/)(?:out|\.git|\.omx)(?:\/|$)/.test(normalizedPath) ||
    /(^|\/)runtime-config\.json$/.test(normalizedPath)
  );
}

const macSigning = resolveMacSigningOptions();

/** @type {import('@electron-forge/shared-types').ForgeConfig} */
export default {
  packagerConfig: {
    asar: true,
    name: appName,
    executableName: appName,
    appBundleId,
    appCategoryType: "public.app-category.developer-tools",
    icon: resolveElectronIcon(),
    osxSign: macSigning,
    ignore: shouldIgnorePackagedPath,
    beforeAsar: [(buildPath, _electronVersion, _platform, _arch, done) => {
      stampElectronPackageIdentity(buildPath, channel).then(() => done(), done);
    }],
    extraResource: [uiDirectory, ...(existsSync(runtimeConfigPath) ? [runtimeConfigPath] : [])],
    afterCopyExtraResources: [(buildPath, _electronVersion, platform, _arch, done) => {
      normalizeUiResourceDirectory(buildPath, uiResourceName, platform).then(() => done(), (error) => done(error));
    }],
  },
  makers: [
    new MakerArdorDMG({}, ["darwin"]),
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
  plugins: [new FusesPlugin(ELECTRON_FUSE_CONFIG)],
};
