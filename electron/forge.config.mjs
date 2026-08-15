import { existsSync } from "node:fs";
import { cp, mkdir } from "node:fs/promises";
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
const sparkleFeedUrl = process.env.ARDOR_SPARKLE_FEED_URL?.trim();
const sparklePublicKey = process.env.ARDOR_SPARKLE_PUBLIC_KEY?.trim();
const sparkleEnabled = targetPlatform === "darwin" && Boolean(sparkleFeedUrl && sparklePublicKey);
const appVersion = process.env.ARDOR_DESKTOP_BUILD_VERSION?.trim();
const buildVersion = process.env.ARDOR_DESKTOP_BUILD_NUMBER?.trim();
const sparkleFrameworkSource = resolve(
  desktopRoot,
  "node_modules",
  "electron-sparkle-updater",
  "native",
  "vendor",
  "Sparkle.framework",
);
const sparkleBridgeSource = resolve(
  desktopRoot,
  "node_modules",
  "electron-sparkle-updater",
  "native",
  "build",
  "Release",
  "sparkle_bridge.node",
);

export function resolveSparkleInfoPlist({ feedUrl = sparkleFeedUrl, publicKey = sparklePublicKey } = {}) {
  if (!feedUrl || !publicKey) return undefined;
  const parsedFeedUrl = new URL(feedUrl);
  const loopbackFeed = parsedFeedUrl.protocol === "http:"
    && (parsedFeedUrl.hostname === "127.0.0.1" || parsedFeedUrl.hostname === "localhost");
  if (parsedFeedUrl.protocol !== "https:" && !loopbackFeed) {
    throw new Error("Sparkle feed URL must use HTTPS or loopback HTTP");
  }
  if (Buffer.from(publicKey, "base64").byteLength !== 32) {
    throw new Error("Sparkle public key must be a base64-encoded Ed25519 public key");
  }
  return {
    SUEnableAutomaticChecks: false,
    SUFeedURL: feedUrl,
    SUPublicEDKey: publicKey,
    SURequireSignedFeed: !loopbackFeed,
    SUScheduledCheckInterval: 3600,
    SUVerifyUpdateBeforeExtraction: true,
    ...(loopbackFeed
      ? { NSAppTransportSecurity: { NSAllowsLocalNetworking: true } }
      : {}),
  };
}

export async function copySparkleFramework(
  buildPath,
  platform,
  {
    bridgeSource = sparkleBridgeSource,
    enabled = sparkleEnabled,
    frameworkSource = sparkleFrameworkSource,
  } = {},
) {
  if (platform !== "darwin" || !enabled) return;
  if (!existsSync(frameworkSource)) {
    throw new Error("Sparkle.framework is missing; run electron:sparkle:rebuild before packaging");
  }
  if (!existsSync(bridgeSource)) {
    throw new Error("Sparkle native bridge is missing; run electron:sparkle:rebuild before packaging");
  }
  const frameworksDirectory = resolve(buildPath, "..", "..", "Frameworks");
  await mkdir(frameworksDirectory, { recursive: true });
  await cp(frameworkSource, resolve(frameworksDirectory, "Sparkle.framework"), {
    dereference: false,
    force: true,
    recursive: true,
    verbatimSymlinks: true,
  });
}

export function resolveMacSigningOptions({
  platform = targetPlatform,
} = {}) {
  if (platform !== "darwin") return undefined;
  return resolveAdHocMacSigningOptions();
}

function resolveAdHocMacSigningOptions() {
  return {
    continueOnError: false,
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
    /(^|\/)node_modules\/electron-sparkle-updater\/native\/vendor(?:\/|$)/.test(normalizedPath) ||
    /(^|\/)runtime-config\.json$/.test(normalizedPath)
  );
}

const macSigning = resolveMacSigningOptions();

/** @type {import('@electron-forge/shared-types').ForgeConfig} */
export default {
  packagerConfig: {
    asar: sparkleEnabled
      ? { unpack: "**/node_modules/electron-sparkle-updater/native/build/Release/*.node" }
      : true,
    name: appName,
    executableName: appName,
    ...(appVersion ? { appVersion } : {}),
    ...(buildVersion ? { buildVersion } : {}),
    appBundleId,
    appCategoryType: "public.app-category.developer-tools",
    icon: resolveElectronIcon(),
    osxSign: macSigning,
    ...(sparkleEnabled ? { extendInfo: resolveSparkleInfoPlist() } : {}),
    ignore: shouldIgnorePackagedPath,
    afterCopy: [(buildPath, _electronVersion, platform, _arch, done) => {
      copySparkleFramework(buildPath, platform).then(() => done(), done);
    }],
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
