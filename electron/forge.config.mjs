import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { normalizeUiResourceDirectory } from "../scripts/electron-package-resources.mjs";
import { resolveElectronIcon } from "../scripts/electron-app-icon.mjs";
import { MakerArdorDMG } from "../scripts/electron-dmg-maker.mjs";
import { ELECTRON_FUSE_CONFIG } from "./fuse-config.mjs";
import {
  renderBrowserWebAuthnEntitlements,
  resolveBrowserWebAuthnKeychainAccessGroup,
} from "./browser/webauthn-signing.mjs";

// Forge 7's plugin is CommonJS while the Electron 43-compatible fuses package
// is ESM. Load the plugin after the fuse config finishes evaluating to avoid a
// CJS-to-ESM initialization cycle. Both packages stay exact-pinned until Forge 8.
const { FusesPlugin } = await import("@electron-forge/plugin-fuses");

const desktopRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const channel = process.env.ARDOR_ELECTRON_CHANNEL ?? "prod";
const appName = channel === "stage1" ? "Ardor Dev" : "Ardor";
const appBundleId = process.env.ARDOR_BUNDLE_ID ?? "cloud.ardor.desktop";
const uiDirectory = resolve(process.env.ARDOR_UI_DIST_DIR ?? resolve(desktopRoot, "..", "solutions-ui", "dist"));
const uiResourceName = basename(uiDirectory);
const runtimeConfigPath = resolve(desktopRoot, "dist", "electron", "runtime-config.json");
const targetPlatform = process.env.ARDOR_DESKTOP_TARGET_PLATFORM ?? process.platform;
const production = channel === "prod";

function requireEnvironmentValue(environment, name) {
  const value = environment[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required for production Electron release signing`);
  }
  return value;
}

export function resolveMacSigningOptions({
  bundleId = appBundleId,
  environment = process.env,
  identity = environment.APPLE_SIGNING_IDENTITY,
  isProduction = production,
  platform = targetPlatform,
} = {}) {
  if (platform !== "darwin") return undefined;
  const normalizedIdentity = identity?.trim();
  if (!normalizedIdentity) {
    if (isProduction) {
      throw new Error("APPLE_SIGNING_IDENTITY is required for production macOS releases");
    }
    return undefined;
  }
  if (normalizedIdentity === "-" && isProduction) {
    throw new Error("Ad-hoc macOS signing is not allowed for production releases");
  }
  if (normalizedIdentity !== "-" && !environment.APPLE_TEAM_ID?.trim()) {
    throw new Error("APPLE_TEAM_ID is required for Browser WebAuthn signing");
  }
  const keychainAccessGroup = resolveBrowserWebAuthnKeychainAccessGroup({
    bundleId,
    teamId: environment.APPLE_TEAM_ID,
  });
  let optionsForFile;
  if (keychainAccessGroup) {
    const directory = mkdtempSync(join(tmpdir(), "ardor-webauthn-entitlements-"));
    const entitlementsPath = join(directory, "browser.plist");
    writeFileSync(entitlementsPath, renderBrowserWebAuthnEntitlements(keychainAccessGroup), "utf8");
    optionsForFile = (filePath) =>
      filePath.includes(".app/") ? {} : { entitlements: entitlementsPath };
  }
  return {
    identity: normalizedIdentity,
    identityValidation: normalizedIdentity !== "-",
    ...(optionsForFile ? { optionsForFile } : {}),
    ...(environment.APPLE_KEYCHAIN_PATH?.trim()
      ? { keychain: environment.APPLE_KEYCHAIN_PATH.trim() }
      : {}),
  };
}

export function resolveMacNotarizeOptions({
  environment = process.env,
  isProduction = production,
  platform = targetPlatform,
} = {}) {
  if (platform !== "darwin" || !isProduction) return undefined;
  return {
    appleApiKey: requireEnvironmentValue(environment, "APPLE_API_KEY"),
    appleApiKeyId: requireEnvironmentValue(environment, "APPLE_API_KEY_ID"),
    appleApiIssuer: requireEnvironmentValue(environment, "APPLE_API_ISSUER"),
  };
}

export function resolveWindowsSigningOptions({
  environment = process.env,
  isProduction = production,
  platform = targetPlatform,
} = {}) {
  if (platform !== "win32") return undefined;

  const certificateFile = environment.WINDOWS_CERTIFICATE_FILE?.trim();
  const certificatePassword = environment.WINDOWS_CERTIFICATE_PASSWORD?.trim();
  const signToolPath = environment.WINDOWS_SIGNTOOL_PATH?.trim();
  const signWithParams = environment.WINDOWS_SIGN_WITH_PARAMS?.trim();
  const hasPfx = Boolean(certificateFile && certificatePassword);
  const hasCustomSigner = Boolean(signToolPath || signWithParams);
  if (!(hasPfx || hasCustomSigner)) {
    if (isProduction) {
      throw new Error("Windows code signing configuration is required for production releases");
    }
    return undefined;
  }

  return {
    description: environment.WINDOWS_SIGN_DESCRIPTION?.trim() || "Ardor desktop application",
    website: environment.WINDOWS_SIGN_WEBSITE?.trim() || "https://ardor.cloud",
    timestampServer: environment.WINDOWS_TIMESTAMP_SERVER?.trim() || "http://timestamp.digicert.com",
    hashes: ["sha256"],
    ...(certificateFile ? { certificateFile } : {}),
    ...(certificatePassword ? { certificatePassword } : {}),
    ...(signToolPath ? { signToolPath } : {}),
    ...(signWithParams ? { signWithParams } : {}),
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
const macNotarization = resolveMacNotarizeOptions();
const windowsSigning = resolveWindowsSigningOptions();

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
    osxNotarize: macNotarization,
    windowsSign: windowsSigning,
    ignore: shouldIgnorePackagedPath,
    extraResource: [uiDirectory, ...(existsSync(runtimeConfigPath) ? [runtimeConfigPath] : [])],
    afterCopyExtraResources: [(buildPath, _electronVersion, platform, _arch, done) => {
      normalizeUiResourceDirectory(buildPath, uiResourceName, platform).then(() => done(), (error) => done(error));
    }],
  },
  makers: [
    new MakerArdorDMG({}, ["darwin"]),
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
        ...(windowsSigning ? { windowsSign: windowsSigning } : {}),
      },
      platforms: ["win32"],
    },
  ],
  plugins: [new FusesPlugin(ELECTRON_FUSE_CONFIG)],
};
