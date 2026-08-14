import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const MACOS_RELEASE_SIGNING_MODE = Object.freeze({
  AD_HOC: "ad-hoc",
  DEVELOPER_ID: "developer-id",
});

const PACKAGE_CREDENTIAL_NAMES = [
  "APPLE_SIGNING_IDENTITY",
  "APPLE_TEAM_ID",
  "APPLE_API_KEY",
  "APPLE_API_KEY_ID",
  "APPLE_API_ISSUER",
];

const WORKFLOW_CREDENTIAL_NAMES = [
  "APPLE_CERTIFICATE_P12_BASE64",
  "APPLE_CERTIFICATE_PASSWORD",
  "APPLE_KEYCHAIN_PASSWORD",
  "APPLE_SIGNING_IDENTITY",
  "APPLE_API_KEY_P8_BASE64",
  "APPLE_API_KEY_ID",
  "APPLE_API_ISSUER",
];

function normalizedCredential(environment, name) {
  const value = environment[name]?.trim();
  if (name === "APPLE_SIGNING_IDENTITY" && value === "-") return "";
  return value ?? "";
}

function resolveCompleteCredentialSet(environment, credentialNames) {
  const configured = credentialNames.filter((name) => normalizedCredential(environment, name));
  if (configured.length === 0) return MACOS_RELEASE_SIGNING_MODE.AD_HOC;
  if (configured.length === credentialNames.length) return MACOS_RELEASE_SIGNING_MODE.DEVELOPER_ID;

  const missing = credentialNames.filter((name) => !normalizedCredential(environment, name));
  throw new Error(
    "Incomplete production macOS signing configuration; provide the complete Developer ID and " +
      `notarization credential set or leave it entirely absent for an ad-hoc release. Missing: ${missing.join(", ")}`,
  );
}

export function resolveProductionMacSigningMode({
  environment = process.env,
  identity = environment.APPLE_SIGNING_IDENTITY,
  isProduction = true,
  platform = process.platform,
} = {}) {
  if (platform !== "darwin" || !isProduction) return undefined;
  return resolveCompleteCredentialSet(
    { ...environment, APPLE_SIGNING_IDENTITY: identity },
    PACKAGE_CREDENTIAL_NAMES,
  );
}

export function resolveWorkflowMacSigningMode(environment = process.env) {
  return resolveCompleteCredentialSet(environment, WORKFLOW_CREDENTIAL_NAMES);
}

export function resolveDesktopReleaseTargets(macSigningMode) {
  if (macSigningMode === MACOS_RELEASE_SIGNING_MODE.AD_HOC) {
    return {
      assetMatrix: {
        include: [
          {
            id: "macos-prod",
            label: "macOS production (ad-hoc)",
            os: "macos-26",
            platform: "darwin",
            ui_platform: "darwin",
            arch: "arm64",
            developer_dir: "/Applications/Xcode_26.5.app/Contents/Developer",
          },
        ],
      },
      uiPlatforms: ["darwin"],
    };
  }
  if (macSigningMode !== MACOS_RELEASE_SIGNING_MODE.DEVELOPER_ID) {
    throw new Error(`Unsupported macOS release signing mode: ${macSigningMode}`);
  }
  return {
    assetMatrix: {
      include: [
        {
          id: "macos-prod",
          label: "macOS production",
          os: "macos-26",
          platform: "darwin",
          ui_platform: "darwin",
          arch: "arm64",
          developer_dir: "/Applications/Xcode_26.5.app/Contents/Developer",
        },
        {
          id: "windows-prod",
          label: "Windows production",
          os: "windows-2025",
          platform: "win32",
          ui_platform: "win32",
          arch: "x64",
          developer_dir: "",
        },
      ],
    },
    uiPlatforms: ["darwin", "win32"],
  };
}

const isDirectInvocation = process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectInvocation) {
  if (process.argv.length !== 3 || process.argv[2] !== "workflow") {
    console.error("Usage: node scripts/macos-release-signing.mjs workflow");
    process.exitCode = 1;
  } else {
    try {
      const mode = resolveWorkflowMacSigningMode();
      const targets = resolveDesktopReleaseTargets(mode);
      console.log(`mode=${mode}`);
      console.log(`asset_matrix=${JSON.stringify(targets.assetMatrix)}`);
      console.log(`ui_platforms=${JSON.stringify(targets.uiPlatforms)}`);
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    }
  }
}
